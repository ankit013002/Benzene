import { randomUUID } from "node:crypto";

import type { Types } from "mongoose";

import { config } from "../config/env.js";
import DriveNodeModel, { normalizePath, type DriveNodeDocument } from "../models/driveNode.model.js";
import FileVersionModel from "../models/fileVersion.model.js";
import { storage } from "../storage/index.js";
import type { UploadTarget } from "../storage/types.js";
import { AppError } from "../utils/AppError.js";
import { buildObjectKey } from "../utils/objectKeys.js";
import { getObjectProtection, type ObjectProtection } from "../modules/placement/placement.service.js";
import { planUpload, type UploadPlan } from "../modules/placement/uploadTargets.service.js";

export interface PresignFileInput {
  name: string;
  size: number;
  contentType?: string;
  /**
   * Directory this file belongs in, absolute from the drive root. Folder
   * drag-and-drop sends one per file, so a nested tree keeps its shape instead
   * of collapsing into the directory the drop started in.
   */
  path?: string;
}

export interface PresignedUpload {
  nodeId: string;
  versionId: string;
  version: number;
  name: string;
  path: string;
  key: string;
  upload: UploadTarget;
}

export interface DeviceUploadReservation {
  nodeId: string;
  versionId: string;
  version: number;
  name: string;
  path: string;
  objectHash: string;
  sizeBytes: number;
  contentType: string;
  placement: UploadPlan;
}

export interface DeviceCompletedUpload {
  nodeId: string;
  versionId: string;
  version: number;
  objectHash: string;
  bytes: number;
  protection: ObjectProtection;
  shortfall: boolean;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * Creates the folder chain for `path`, returning the deepest node.
 *
 * Folders are upserted rather than inserted so concurrent uploads into the same
 * new directory do not race each other into a duplicate-key error.
 */
export async function ensureFolderChain(
  ownerId: string,
  path: string
): Promise<DriveNodeDocument | null> {
  const normalized = normalizePath(path);
  if (normalized === "") return null;

  const segments = normalized.split("/").filter(Boolean);
  let parentPath = "";
  let parent: DriveNodeDocument | null = null;
  const ancestors: Types.ObjectId[] = [];

  for (const segment of segments) {
    const folder: DriveNodeDocument = await DriveNodeModel.findOneAndUpdate(
      {
        ownerId,
        path: parentPath,
        nameLower: segment.toLowerCase(),
        isDeleted: false,
      },
      {
        $setOnInsert: {
          ownerId,
          type: "folder",
          name: segment,
          nameLower: segment.toLowerCase(),
          path: parentPath,
          parentId: parent?._id ?? null,
          ancestors: [...ancestors],
          createdBy: ownerId,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (folder.type !== "folder") {
      throw AppError.conflict(
        `Cannot create folder "${segment}": a file with that name already exists`
      );
    }

    ancestors.push(folder._id);
    parent = folder;
    parentPath = `${parentPath}${segment}/`;
  }

  return parent;
}

/**
 * Reserves a version row and hands back a presigned URL per file.
 *
 * Nothing is marked current here — the row stays "pending" until
 * `completeUploads` confirms the bytes actually landed, so an abandoned upload
 * can never surface as a zero-byte file in the drive listing.
 */
export async function presignUploads(
  ownerId: string,
  input: { path: string; files: PresignFileInput[] }
): Promise<PresignedUpload[]> {
  const cfg = config();
  const driver = storage();
  const path = normalizePath(input.path);

  for (const file of input.files) {
    if (file.size > cfg.maxUploadBytes) {
      throw AppError.payloadTooLarge(
        `"${file.name}" is ${file.size} bytes, over the ${cfg.maxUploadBytes}-byte limit`
      );
    }
  }

  const results: PresignedUpload[] = [];
  // Cache the chain per directory so a 200-file drop does not re-walk it.
  const parents = new Map<string, DriveNodeDocument | null>();

  for (const file of input.files) {
    const contentType = file.contentType?.trim() || DEFAULT_CONTENT_TYPE;
    const filePath = normalizePath(file.path ?? path);

    if (!parents.has(filePath)) {
      parents.set(filePath, await ensureFolderChain(ownerId, filePath));
    }
    const parent = parents.get(filePath) ?? null;

    const node = await DriveNodeModel.findOneAndUpdate(
      { ownerId, path: filePath, nameLower: file.name.toLowerCase(), isDeleted: false },
      {
        $setOnInsert: {
          ownerId,
          type: "file",
          name: file.name,
          nameLower: file.name.toLowerCase(),
          path: filePath,
          parentId: parent?._id ?? null,
          ancestors: parent ? [...parent.ancestors, parent._id] : [],
          createdBy: ownerId,
        },
        $set: { updatedBy: ownerId, contentType },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (node.type !== "file") {
      throw AppError.conflict(`"${file.name}" already exists as a folder`);
    }

    const version = await nextVersionFor(node._id);
    const key = buildObjectKey({ ownerId, nodeId: node._id.toString(), version });

    const versionDoc = await FileVersionModel.create({
      nodeId: node._id,
      ownerId,
      version,
      bytes: file.size,
      contentType,
      storage: { driver: driver.name, bucket: driver.bucket, key },
      status: "pending",
      uploadedBy: ownerId,
      isCurrent: false,
    });

    const upload = await driver.createUploadTarget({
      key,
      contentType,
      contentLength: file.size,
    });

    results.push({
      nodeId: node._id.toString(),
      versionId: versionDoc._id.toString(),
      version,
      name: node.name,
      path: filePath,
      key,
      upload,
    });
  }

  return results;
}

/**
 * Creates pending logical metadata for an object that will live on devices.
 *
 * Unlike the legacy presign path this never creates a StorageDriver object or
 * URL. The placement plan reserves device replicas, while this Mongo row stays
 * pending until a signed device possession report makes at least one copy real.
 */
export async function reserveDeviceUpload(
  ownerId: string,
  input: { name: string; path: string; size: number; contentType?: string; sha256: string }
): Promise<DeviceUploadReservation> {
  const cfg = config();
  if (input.size > cfg.maxUploadBytes) {
    throw AppError.payloadTooLarge(
      `"${input.name}" is ${input.size} bytes, over the ${cfg.maxUploadBytes}-byte limit`
    );
  }

  const contentType = input.contentType?.trim() || DEFAULT_CONTENT_TYPE;
  const filePath = normalizePath(input.path);
  const parent = await ensureFolderChain(ownerId, filePath);
  const node = await DriveNodeModel.findOneAndUpdate(
    { ownerId, path: filePath, nameLower: input.name.toLowerCase(), isDeleted: false },
    {
      $setOnInsert: {
        ownerId,
        type: "file",
        name: input.name,
        nameLower: input.name.toLowerCase(),
        path: filePath,
        parentId: parent?._id ?? null,
        ancestors: parent ? [...parent.ancestors, parent._id] : [],
        createdBy: ownerId,
      },
      $set: { updatedBy: ownerId, contentType },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (node.type !== "file") {
    throw AppError.conflict(`"${input.name}" already exists as a folder`);
  }

  const objectHash = input.sha256.toLowerCase();
  const version = await nextVersionFor(node._id);
  const versionDoc = await FileVersionModel.create({
    nodeId: node._id,
    ownerId,
    version,
    bytes: input.size,
    contentType,
    sha256: objectHash,
    objectHash,
    status: "pending",
    uploadedBy: ownerId,
    isCurrent: false,
  });

  let placement: UploadPlan;
  try {
    placement = await planUpload(ownerId, { objectHash, sizeBytes: input.size });
  } catch (error) {
    // Metadata is intentionally retained as pending so a transient placement
    // or configuration failure cannot make an untracked logical file.
    throw error;
  }

  return {
    nodeId: node._id.toString(),
    versionId: versionDoc._id.toString(),
    version,
    name: node.name,
    path: filePath,
    objectHash,
    sizeBytes: input.size,
    contentType,
    placement,
  };
}

async function nextVersionFor(nodeId: Types.ObjectId): Promise<number> {
  const latest = await FileVersionModel.findOne({ nodeId })
    .sort({ version: -1 })
    .select("version")
    .lean();
  return (latest?.version ?? 0) + 1;
}

const PROMOTION_LOCK_TTL_MS = 30_000;
const PROMOTION_LOCK_RETRY_MS = 5;

interface CommittedVersionMetadata {
  bytes: number;
  uploadedAt: Date;
  contentType?: string;
}

/**
 * Commits a pending version without allowing a stale hydrated document to
 * overwrite a concurrent completion. Both callers then re-read the row before
 * building their response when two requests complete the same version at once.
 */
async function markVersionCommitted(
  versionId: string,
  ownerId: string,
  metadata: CommittedVersionMetadata & { etag?: string }
): Promise<void> {
  const set: Record<string, unknown> = {
    bytes: metadata.bytes,
    status: "committed",
    uploadedAt: metadata.uploadedAt,
  };
  if (metadata.contentType) set.contentType = metadata.contentType;
  if (metadata.etag) set.etag = metadata.etag;

  await FileVersionModel.updateOne(
    { _id: versionId, ownerId, status: "pending" },
    { $set: set }
  );
}

async function acquirePromotionLock(nodeId: Types.ObjectId, ownerId: string): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + PROMOTION_LOCK_TTL_MS;

  // The lease is only a crash-recovery guard. Every live promoter releases it
  // in finally, while the conditional update makes competing promoters wait
  // without ever demoting one another's current version.
  for (;;) {
    const now = new Date();
    const acquired = await DriveNodeModel.findOneAndUpdate(
      {
        _id: nodeId,
        ownerId,
        $or: [
          { promotionLock: { $exists: false } },
          { "promotionLock.expiresAt": { $lte: now } },
        ],
      },
      {
        $set: {
          promotionLock: {
            token,
            expiresAt: new Date(Date.now() + PROMOTION_LOCK_TTL_MS),
          },
        },
      },
      { new: true, timestamps: false }
    ).select("_id");

    if (acquired) return token;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out promoting versions for node ${nodeId.toString()}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROMOTION_LOCK_RETRY_MS));
  }
}

/**
 * Promotes the highest completed version for a node. Completion is deliberately
 * monotonic: a lower version that finishes after a higher one is retained as
 * history but cannot become current or overwrite DriveNode metadata.
 */
async function promoteHighestCommittedVersion(
  ownerId: string,
  nodeId: Types.ObjectId
): Promise<void> {
  const token = await acquirePromotionLock(nodeId, ownerId);
  try {
    const highest = await FileVersionModel.findOne({
      nodeId,
      ownerId,
      status: "committed",
    })
      .sort({ version: -1 })
      .lean();
    if (!highest) return;

    const current = await FileVersionModel.findOne({
      nodeId,
      ownerId,
      isCurrent: true,
      status: "committed",
    })
      .sort({ version: -1 })
      .lean();

    if (!current || current._id.toString() !== highest._id.toString()) {
      // The lock makes the two updates below a serialized promotion. The
      // predicates still make each write conditional if a legacy caller or a
      // manually repaired database changes the row between reads.
      if (current) {
        await FileVersionModel.updateOne(
          { _id: current._id, nodeId, ownerId, isCurrent: true },
          { $set: { isCurrent: false } }
        );
      }
      await FileVersionModel.updateOne(
        {
          _id: highest._id,
          nodeId,
          ownerId,
          status: "committed",
          isCurrent: false,
        },
        { $set: { isCurrent: true } }
      );
    }

    // Re-read the winner after promotion so metadata is always derived from
    // the row that is actually current, not from the request that got the lock.
    const winner = await FileVersionModel.findOne({
      nodeId,
      ownerId,
      isCurrent: true,
      status: "committed",
    })
      .sort({ version: -1 })
      .lean();
    if (!winner) return;

    await DriveNodeModel.updateOne(
      { _id: nodeId, ownerId, "promotionLock.token": token },
      {
        $set: {
          bytes: winner.bytes,
          versionsCount: winner.version,
          uploadedAt: winner.uploadedAt,
          updatedBy: ownerId,
          ...(winner.contentType ? { contentType: winner.contentType } : {}),
        },
      }
    );
  } finally {
    await DriveNodeModel.updateOne(
      { _id: nodeId, ownerId, "promotionLock.token": token },
      { $unset: { promotionLock: 1 } },
      { timestamps: false }
    );
  }
}

export interface CompletedUpload {
  nodeId: string;
  versionId: string;
  version: number;
  bytes: number;
}

/**
 * Promotes pending versions to current after verifying the object exists.
 *
 * The size recorded is the one storage reports, not the one the client claimed,
 * so a client cannot under-report to dodge its quota.
 */
export async function completeUploads(
  ownerId: string,
  versionIds: string[]
): Promise<CompletedUpload[]> {
  const driver = storage();
  const completed: CompletedUpload[] = [];

  for (const versionId of versionIds) {
    const version = await FileVersionModel.findOne({ _id: versionId, ownerId });
    if (!version) {
      throw AppError.notFound(`Upload ${versionId} not found`);
    }

    if (version.status !== "committed") {
      const storageKey = version.storage?.key;
      if (!storageKey) {
        throw AppError.badRequest(
          `Version ${versionId} is device-backed; use device upload completion`
        );
      }
      const stored = await driver.headObject(storageKey);
      if (!stored) {
        throw AppError.badRequest(
          `No object was uploaded for version ${versionId}; the presigned PUT did not complete`
        );
      }

      await markVersionCommitted(versionId, ownerId, {
        bytes: stored.bytes,
        uploadedAt: new Date(),
        etag: stored.etag,
        contentType: stored.contentType ?? version.contentType,
      });
    }

    await promoteHighestCommittedVersion(ownerId, version.nodeId);
    const committed = await FileVersionModel.findById(versionId).lean();
    if (!committed) throw AppError.notFound(`Upload ${versionId} not found`);

    completed.push({
      nodeId: version.nodeId.toString(),
      versionId,
      version: committed.version,
      bytes: committed.bytes,
    });
  }

  return completed;
}

/** Commits a device-backed version only after signed possession exists. */
export async function completeDeviceUploads(
  ownerId: string,
  versionIds: string[]
): Promise<DeviceCompletedUpload[]> {
  const completed: DeviceCompletedUpload[] = [];

  for (const versionId of versionIds) {
    const version = await FileVersionModel.findOne({ _id: versionId, ownerId });
    if (!version) throw AppError.notFound(`Upload ${versionId} not found`);
    if (!version.objectHash) {
      throw AppError.badRequest(`Version ${versionId} is not device-backed`);
    }

    const protection = await getObjectProtection(ownerId, version.objectHash);
    if (protection.healthyReplicas < 1) {
      throw new AppError(
        409,
        "NO_HEALTHY_REPLICA",
        `No device has confirmed possession for version ${versionId}`,
        { protection, shortfall: true }
      );
    }

    if (version.status !== "committed") {
      await markVersionCommitted(versionId, ownerId, {
        bytes: version.bytes,
        uploadedAt: new Date(),
        contentType: version.contentType,
      });
    }

    await promoteHighestCommittedVersion(ownerId, version.nodeId);
    const committed = await FileVersionModel.findById(versionId).lean();
    if (!committed) throw AppError.notFound(`Upload ${versionId} not found`);

    completed.push({
      nodeId: version.nodeId.toString(),
      versionId,
      version: committed.version,
      objectHash: committed.objectHash ?? version.objectHash,
      bytes: committed.bytes,
      protection,
      shortfall: protection.healthyReplicas < protection.desiredReplicas,
    });
  }

  return completed;
}

/** Time-limited download URL for the current version of a node. */
export async function createDownloadUrlForNode(
  ownerId: string,
  nodeId: string
): Promise<string> {
  const node = await DriveNodeModel.findOne({ _id: nodeId, ownerId, isDeleted: false });
  if (!node) throw AppError.notFound("File not found");
  if (node.type !== "file") throw AppError.badRequest("Cannot download a folder");

  const current = await FileVersionModel.findOne({
    nodeId: node._id,
    isCurrent: true,
    status: "committed",
  });
  if (!current) throw AppError.notFound("File has no uploaded content yet");

  if (!current.storage?.key) {
    throw AppError.conflict("File is stored on devices; download it using its object hash");
  }

  return storage().createDownloadUrl({
    key: current.storage.key,
    filename: node.name,
  });
}
