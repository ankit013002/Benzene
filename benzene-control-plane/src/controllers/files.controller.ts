import type { Request, Response } from "express";
import { z } from "zod";

import {
  createFolders,
  deleteNode,
  getUsage,
  listDirectory,
} from "../services/driveNodes.services.js";
import {
  completeUploads,
  completeDeviceUploads,
  createDownloadUrlForNode,
  presignUploads,
  reserveDeviceUpload,
} from "../services/uploads.services.js";
import { AppError } from "../utils/AppError.js";

/** Rejects path segments that could escape the owner prefix or break listing. */
const safeName = z
  .string()
  .min(1, "name is required")
  .max(255, "name must be 255 characters or fewer")
  .refine((v) => !v.includes("/") && !v.includes("\\"), "name may not contain slashes")
  .refine((v) => v !== "." && v !== "..", "name may not be '.' or '..'");

const pathString = z
  .string()
  .max(1024)
  .refine(
    (v) => !v.split(/[\\/]/).some((seg) => seg === ".." ),
    "path may not contain '..' segments"
  );

/**
 * Batch path, defaulted when omitted. Kept separate from `pathString`
 * because `.default()` still fires under `.optional()`, which would turn an
 * absent per-file path into "" and flatten a dropped folder tree into the
 * root directory.
 */
const relativePath = pathString.default("");

const presignSchema = z.object({
  path: relativePath,
  files: z
    .array(
      z.object({
        name: safeName,
        size: z.number().int().nonnegative(),
        contentType: z.string().max(255).optional(),
        // Absolute from the drive root; falls back to the batch path.
        path: pathString.optional(),
      })
    )
    .min(1, "at least one file is required")
    .max(500, "at most 500 files per batch"),
  // Absolute paths of folders to create, for ones that contain no files.
  folderPaths: z.array(pathString).max(500).optional(),
});

const completeSchema = z.object({
  versionIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i, "versionId must be an ObjectId"))
    .min(1)
    .max(500),
});

const deviceUploadSchema = z.object({
  name: safeName,
  path: pathString.default(""),
  size: z.number().int().nonnegative(),
  contentType: z.string().max(255).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, "sha256 must be a SHA-256 hex digest"),
});

const completeDeviceSchema = z.object({
  versionIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i, "versionId must be an ObjectId"))
    .min(1)
    .max(500),
});

const foldersSchema = z.object({
  paths: z.array(pathString).min(1).max(500),
});

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "must be a 24-character ObjectId");

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw AppError.badRequest("Request validation failed", z.flattenError(result.error));
  }
  return result.data;
}

/** `requireUser` guarantees this; the check keeps the type narrowing honest. */
function ownerOf(req: Request): string {
  if (!req.ownerId) throw AppError.unauthorized();
  return req.ownerId;
}

export async function listDirectoryHandler(req: Request, res: Response): Promise<void> {
  const path = typeof req.query["path"] === "string" ? req.query["path"] : "";
  const listing = await listDirectory(ownerOf(req), path);
  res.status(200).json({ data: listing });
}

export async function presignUploadsHandler(req: Request, res: Response): Promise<void> {
  const ownerId = ownerOf(req);
  const body = parse(presignSchema, req.body);

  if (body.folderPaths?.length) {
    await createFolders(ownerId, body.folderPaths);
  }

  const uploads = await presignUploads(ownerId, { path: body.path, files: body.files });
  res.status(201).json({ data: { uploads } });
}

export async function completeUploadsHandler(req: Request, res: Response): Promise<void> {
  const body = parse(completeSchema, req.body);
  const completed = await completeUploads(ownerOf(req), body.versionIds);
  res.status(200).json({ data: { completed } });
}

export async function reserveDeviceUploadHandler(
  req: Request,
  res: Response
): Promise<void> {
  const body = parse(deviceUploadSchema, req.body);
  const reservation = await reserveDeviceUpload(ownerOf(req), body);
  res.status(201).json({ data: reservation });
}

export async function completeDeviceUploadsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const body = parse(completeDeviceSchema, req.body);
  const completed = await completeDeviceUploads(ownerOf(req), body.versionIds);
  res.status(200).json({ data: { completed } });
}

export async function createFoldersHandler(req: Request, res: Response): Promise<void> {
  const body = parse(foldersSchema, req.body);
  const created = await createFolders(ownerOf(req), body.paths);
  res.status(201).json({ data: { created } });
}

export async function downloadHandler(req: Request, res: Response): Promise<void> {
  const nodeId = parse(objectId, req.params["nodeId"]);
  const url = await createDownloadUrlForNode(ownerOf(req), nodeId);

  // A redirect keeps the bytes off this service entirely: the browser fetches
  // them straight from S3 using the presigned URL.
  if (req.query["redirect"] === "false") {
    res.status(200).json({ data: { url } });
    return;
  }
  res.redirect(302, url);
}

export async function deleteNodeHandler(req: Request, res: Response): Promise<void> {
  const nodeId = parse(objectId, req.params["nodeId"]);
  const purge = req.query["purge"] === "true";
  const result = await deleteNode(ownerOf(req), nodeId, { purge });
  res.status(200).json({ data: result });
}

export async function usageHandler(req: Request, res: Response): Promise<void> {
  const usage = await getUsage(ownerOf(req));
  res.status(200).json({ data: usage });
}
