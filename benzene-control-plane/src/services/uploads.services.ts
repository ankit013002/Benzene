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

    if (version.status === "committed") {
      completed.push({
        nodeId: version.nodeId.toString(),
        versionId,
        version: version.version,
        bytes: version.bytes,
      });
      continue;
    }

    if (!version.storage?.key) {
      throw AppError.badRequest(
        `Version ${versionId} is device-backed; use device upload completion`
      );
    }

    const stored = await driver.headObject(version.storage.key);
    if (!stored) {
      throw AppError.badRequest(
        `No object was uploaded for version ${versionId}; the presigned PUT did not complete`
      );
    }

    // Demote the previous current version first: the partial unique index
    // permits only one isCurrent=true row per node.
    await FileVersionModel.updateMany(
      { nodeId: version.nodeId, isCurrent: true },
      { $set: { isCurrent: false } }
    );

    version.bytes = stored.bytes;
    version.status = "committed";
    version.isCurrent = true;
    version.uploadedAt = new Date();
    if (stored.etag) version.etag = stored.etag;
    if (stored.contentType) version.contentType = stored.contentType;
    await version.save();

    await DriveNodeModel.updateOne(
      { _id: version.nodeId, ownerId },
      {
        $set: {
          bytes: stored.bytes,
          versionsCount: version.version,
          uploadedAt: version.uploadedAt,
          updatedBy: ownerId,
          ...(version.contentType ? { contentType: version.contentType } : {}),
        },
      }
    );

    completed.push({
      nodeId: version.nodeId.toString(),
      versionId,
      version: version.version,
      bytes: stored.bytes,
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
      await FileVersionModel.updateMany(
        { nodeId: version.nodeId, isCurrent: true },
        { $set: { isCurrent: false } }
      );

      version.status = "committed";
      version.isCurrent = true;
      version.uploadedAt = new Date();
      await version.save();

      await DriveNodeModel.updateOne(
        { _id: version.nodeId, ownerId },
        {
          $set: {
            bytes: version.bytes,
            versionsCount: version.version,
            uploadedAt: version.uploadedAt,
            updatedBy: ownerId,
            ...(version.contentType ? { contentType: version.contentType } : {}),
          },
        }
      );
    }

    completed.push({
      nodeId: version.nodeId.toString(),
      versionId,
      version: version.version,
      objectHash: version.objectHash,
      bytes: version.bytes,
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
