import type { Types } from "mongoose";

import DriveNodeModel, { normalizePath } from "../models/driveNode.model.js";
import FileVersionModel from "../models/fileVersion.model.js";
import { storage } from "../storage/index.js";
import { AppError } from "../utils/AppError.js";
import { getObjectProtection, type ObjectProtection } from "../modules/placement/placement.service.js";
import { ensureFolderChain } from "./uploads.services.js";

export interface ListedFile {
  id: string;
  name: string;
  path: string;
  bytes: number;
  contentType: string | undefined;
  ext: string | undefined;
  lastModified: number | null;
  hasContent: boolean;
  /** Present for a committed device-backed version. */
  objectHash?: string;
  /** Protection state used by the device download flow. */
  protection?: ObjectProtection;
}

export interface ListedFolder {
  id: string;
  name: string;
  path: string;
  bytes: number;
  lastModified: number | null;
}

export interface DirectoryListing {
  path: string;
  files: ListedFile[];
  folders: ListedFolder[];
}

/**
 * Lists one directory level.
 *
 * Folder sizes are rolled up from every descendant in a single aggregation over
 * the `ancestors` array, which avoids the N+1 subtree walk the old listing
 * would have needed.
 */
export async function listDirectory(
  ownerId: string,
  rawPath: string
): Promise<DirectoryListing> {
  const path = normalizePath(rawPath);

  const nodes = await DriveNodeModel.find({ ownerId, path, isDeleted: false })
    .sort({ type: 1, nameLower: 1 })
    .lean();

  const folderIds = nodes.filter((n) => n.type === "folder").map((n) => n._id);
  const rollups = await rollUpFolderSizes(ownerId, folderIds);
  const fileNodes = nodes.filter((node) => node.type === "file");
  const currentVersions = await FileVersionModel.find({
    ownerId,
    nodeId: { $in: fileNodes.map((node) => node._id) },
    isCurrent: true,
    status: "committed",
  })
    .select("nodeId objectHash sha256")
    .lean();
  const versionByNode = new Map(
    currentVersions.map((version) => [version.nodeId.toString(), version])
  );

  const files: ListedFile[] = [];
  const folders: ListedFolder[] = [];

  for (const node of nodes) {
    if (node.type === "folder") {
      const rollup = rollups.get(node._id.toString());
      folders.push({
        id: node._id.toString(),
        name: node.name,
        path: `${path}${node.name}/`,
        bytes: rollup?.bytes ?? 0,
        lastModified: rollup?.lastModified ?? node.updatedAt?.getTime() ?? null,
      });
    } else {
      const current = versionByNode.get(node._id.toString());
      const objectHash = current?.objectHash ?? current?.sha256;
      const protection = objectHash
        ? await getObjectProtection(ownerId, objectHash)
        : undefined;
      files.push({
        id: node._id.toString(),
        name: node.name,
        path,
        bytes: node.bytes,
        contentType: node.contentType,
        ext: node.ext,
        lastModified: (node.uploadedAt ?? node.updatedAt)?.getTime() ?? null,
        // Distinguishes a real file from one whose upload never completed.
        hasContent: Boolean(node.uploadedAt),
        ...(objectHash ? { objectHash } : {}),
        ...(protection ? { protection } : {}),
      });
    }
  }

  return { path, files, folders };
}

interface FolderRollup {
  bytes: number;
  lastModified: number | null;
}

async function rollUpFolderSizes(
  ownerId: string,
  folderIds: Types.ObjectId[]
): Promise<Map<string, FolderRollup>> {
  const result = new Map<string, FolderRollup>();
  if (folderIds.length === 0) return result;

  const rows = await DriveNodeModel.aggregate<{
    _id: unknown;
    bytes: number;
    lastModified: Date | null;
  }>([
    {
      $match: {
        ownerId,
        type: "file",
        isDeleted: false,
        ancestors: { $in: folderIds },
      },
    },
    { $unwind: "$ancestors" },
    { $match: { ancestors: { $in: folderIds } } },
    {
      $group: {
        _id: "$ancestors",
        bytes: { $sum: "$bytes" },
        lastModified: { $max: "$updatedAt" },
      },
    },
  ]);

  for (const row of rows) {
    result.set(String(row._id), {
      bytes: row.bytes,
      lastModified: row.lastModified ? new Date(row.lastModified).getTime() : null,
    });
  }
  return result;
}

/**
 * Creates folders from absolute drive paths.
 *
 * Uploading files implies their ancestors, but an empty folder has no file to
 * imply it, so drag-and-drop sends those paths explicitly.
 */
export async function createFolders(
  ownerId: string,
  paths: string[]
): Promise<number> {
  let created = 0;
  for (const path of paths) {
    if (normalizePath(path) === "") continue;
    await ensureFolderChain(ownerId, path);
    created += 1;
  }
  return created;
}

export interface DeleteResult {
  deletedNodes: number;
  purgedObjects: number;
}

/**
 * Soft-deletes a node and everything beneath it.
 *
 * `purge` additionally removes the bytes from storage. It is irreversible, so
 * it is opt-in rather than the default — a plain delete stays recoverable.
 */
export async function deleteNode(
  ownerId: string,
  nodeId: string,
  options: { purge: boolean }
): Promise<DeleteResult> {
  const node = await DriveNodeModel.findOne({ _id: nodeId, ownerId, isDeleted: false });
  if (!node) throw AppError.notFound("Node not found");

  const subtreeFilter =
    node.type === "folder"
      ? { ownerId, isDeleted: false, $or: [{ _id: node._id }, { ancestors: node._id }] }
      : { ownerId, isDeleted: false, _id: node._id };

  const affected = await DriveNodeModel.find(subtreeFilter).select("_id type").lean();
  const affectedIds = affected.map((n) => n._id);
  const now = new Date();

  await DriveNodeModel.updateMany(subtreeFilter, {
    $set: {
      isDeleted: true,
      deletedAt: now,
      originalPath: node.path,
      updatedBy: ownerId,
    },
  });

  let purgedObjects = 0;
  if (options.purge && affectedIds.length > 0) {
    const versions = await FileVersionModel.find({
      nodeId: { $in: affectedIds },
      ownerId,
    })
      .select("storage.key")
      .lean();

    // Device-backed versions intentionally have no legacy storage key. Their
    // bytes remain on devices until reference-counted GC exists.
    const keys = versions
      .map((v) => v.storage?.key)
      .filter((key): key is string => Boolean(key));
    if (keys.length > 0) {
      await storage().deleteObjects(keys);
      purgedObjects = keys.length;
    }
    await FileVersionModel.deleteMany({ nodeId: { $in: affectedIds }, ownerId });
  }

  return { deletedNodes: affectedIds.length, purgedObjects };
}

/** Aggregate bytes stored by an owner — the source of truth for quota display. */
export async function getUsage(ownerId: string): Promise<{ bytes: number; files: number }> {
  const rows = await DriveNodeModel.aggregate<{ bytes: number; files: number }>([
    { $match: { ownerId, type: "file", isDeleted: false } },
    { $group: { _id: null, bytes: { $sum: "$bytes" }, files: { $sum: 1 } } },
  ]);

  const row = rows[0];
  return { bytes: row?.bytes ?? 0, files: row?.files ?? 0 };
}
