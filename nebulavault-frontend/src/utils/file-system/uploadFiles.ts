import { FlatFile } from "@/types/FileFolderBuffer";
import { downloadCurrentFile, uploadEncryptedFile } from "./encryptedTransfers";
import { loadUnlockedVaultKey } from "./vaultKey";

/**
 * Keeps browser drop paths rooted at the directory the user is viewing.
 * `webkitGetAsEntry` already includes that directory in some browsers, while
 * plain file drops and older callers pass paths relative to it.
 */
function joinDrivePath(basePath: string, candidatePath: string): string {
  const base = basePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const candidate = candidatePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

  if (!base) return candidate;
  if (!candidate || candidate === base || candidate.startsWith(`${base}/`)) {
    return candidate || base;
  }
  return `${base}/${candidate}`;
}

export interface UploadProgress {
  /** Files whose bytes have finished transferring and committing. */
  completed: number;
  total: number;
  currentFile: string | null;
}

export interface UploadResult {
  uploaded: number;
  bytes: number;
  /** Device or protection issues that did not prevent other files completing. */
  issues: string[];
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function errorMessageFrom(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return fallback;
}

async function uploadOneDeviceBackedFile(
  file: File,
  filePath: string,
  vaultId: string,
): Promise<{ bytes: number; issues: string[] }> {
  return uploadEncryptedFile(file, filePath, vaultId);
}

/**
 * Places files on user-owned devices. Metadata remains pending until the
 * device reports possession, and only then is the version committed.
 */
export async function uploadFiles(
  path: string,
  vaultId: string,
  files: FlatFile[],
  folderPaths: string[],
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  if (files.length > 0 && !await loadUnlockedVaultKey(vaultId)) {
    throw new Error("Import this Vault’s recovery kit before uploading encrypted files.");
  }
  if (files.length === 0 && folderPaths.length === 0) {
    return { uploaded: 0, bytes: 0, issues: [] };
  }

  const rootedFolderPaths = [
    ...new Set(folderPaths.map((folderPath) => joinDrivePath(path, folderPath))),
  ];

  if (rootedFolderPaths.length > 0) {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: rootedFolderPaths }),
    });
    const payload = await readJson(res);
    if (!res.ok) {
      throw new Error(errorMessageFrom(payload, "Could not create folders"));
    }
  }

  let uploaded = 0;
  let bytes = 0;
  const issues: string[] = [];

  for (const [index, { file, path: filePath }] of files.entries()) {
    onProgress?.({
      completed: uploaded,
      total: files.length,
      currentFile: file.name,
    });
    const destinationPath = joinDrivePath(path, filePath);
    let result: { bytes: number; issues: string[] };
    try {
      result = await uploadOneDeviceBackedFile(file, destinationPath, vaultId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload could not be started";
      result = { bytes: 0, issues: [`${file.name}: ${message}`] };
    }
    bytes += result.bytes;
    if (result.bytes > 0) uploaded += 1;
    issues.push(...result.issues);
    onProgress?.({
      completed: index + 1,
      total: files.length,
      currentFile: index + 1 === files.length ? null : file.name,
    });
  }

  return { uploaded, bytes, issues };
}

/** Downloads through healthy device replicas using a scoped transfer grant. */
export async function downloadFile(
  nodeId: string,
  objectHash: string,
  filename: string,
  vaultId: string,
): Promise<boolean> {
  return downloadCurrentFile(nodeId, objectHash, filename, vaultId);
}

/** Explicit legacy fallback for pre-device-backed metadata only. */
export async function downloadLegacyFile(
  nodeId: string,
  filename: string,
): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(nodeId)}/download`);
  if (!res.ok) {
    throw new Error(errorMessageFrom(await readJson(res), "Could not download the file"));
  }

  const payload = (await res.json()) as { data?: { url?: string } };
  const url = payload.data?.url;
  if (!url) throw new Error("No download URL was returned");

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function deleteNode(nodeId: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(errorMessageFrom(await readJson(res), "Could not delete the item"));
  }
}
