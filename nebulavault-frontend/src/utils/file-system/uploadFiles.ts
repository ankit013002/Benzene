import { FlatFile } from "@/types/FileFolderBuffer";
import { downloadFromDevices, hashFile } from "./deviceUpload";

interface UploadTarget {
  deviceId: string;
  deviceName: string;
  url: string;
  grant: string;
  expiresAt: string;
}

interface PlacementPlan {
  alreadyHeldBy: string[];
  desiredReplicas: number;
  targets: UploadTarget[];
  shortfall: boolean;
  reason?: string;
  singleCopy: boolean;
}

interface DeviceUploadReservation {
  nodeId: string;
  versionId: string;
  objectHash: string;
  placement: PlacementPlan;
}

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

async function transferFailureMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  const payload = await readJson(res);
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { code?: unknown }).code === "POSSESSION_UNCONFIRMED"
  ) {
    return "The device stored the file, but protection confirmation is pending. Retry this upload safely.";
  }
  return errorMessageFrom(payload, fallback);
}

async function reserveDeviceUpload(
  file: File,
  filePath: string,
): Promise<DeviceUploadReservation> {
  const objectHash = await hashFile(file);
  const res = await fetch("/api/files/uploads/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      path: filePath,
      size: file.size,
      contentType: file.type || "application/octet-stream",
      sha256: objectHash,
    }),
  });

  const payload = await readJson(res);
  if (!res.ok) {
    throw new Error(errorMessageFrom(payload, "Could not reserve a place for this file"));
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { data?: unknown }).data !== "object" ||
    (payload as { data?: unknown }).data === null
  ) {
    throw new Error("The storage service returned an invalid upload reservation");
  }
  return (payload as { data: DeviceUploadReservation }).data;
}

async function completeDeviceUpload(versionId: string): Promise<unknown> {
  const res = await fetch("/api/files/uploads/device/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionIds: [versionId] }),
  });
  const payload = await readJson(res);
  if (!res.ok) {
    throw new Error(errorMessageFrom(payload, "Could not finish this device upload"));
  }
  return payload;
}

async function uploadOneDeviceBackedFile(
  file: File,
  filePath: string,
): Promise<{ bytes: number; issues: string[] }> {
  const reservation = await reserveDeviceUpload(file, filePath);
  const placement = reservation.placement;
  const storedOn = [...placement.alreadyHeldBy];
  const issues: string[] = [];
  let possessionPending = false;

  for (const target of placement.targets) {
    try {
      const putRes = await fetch(target.url, {
        method: "PUT",
        headers: {
          "X-Transfer-Grant": target.grant,
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });

      // Agent 201 includes its signed possession report. A 503 means the
      // bytes may be present, but this browser cannot claim a healthy copy.
      if (putRes.status !== 201) {
        if (putRes.status === 503) possessionPending = true;
        issues.push(
          `${target.deviceName}: ${await transferFailureMessage(
            putRes,
            `refused with ${putRes.status}`,
          )}`,
        );
        continue;
      }
      storedOn.push(target.deviceId);
    } catch {
      issues.push(`${target.deviceName}: could not be reached`);
    }
  }

  if (storedOn.length === 0) {
    const reason = placement.reason
      ? {
          no_devices: "You have not added any devices yet",
          none_online: "None of your devices are online right now",
          insufficient_capacity: "Your devices do not have enough free space",
          unreachable_devices: "Your devices could not be reached",
        }[placement.reason]
      : undefined;
    issues.push(
      possessionPending
        ? `${file.name} is not confirmed on any device yet; retry this upload safely`
        : reason
        ? `${file.name} could not be stored: ${reason.toLowerCase()}`
        : `${file.name} could not be stored on any device`,
    );
    return { bytes: 0, issues };
  }

  try {
    await completeDeviceUpload(reservation.versionId);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Could not finish this device upload");
    return { bytes: 0, issues };
  }

  if (placement.shortfall) {
    issues.push(
      `${file.name} has reduced protection: stored on ${storedOn.length} of ${placement.desiredReplicas} devices`,
    );
  }
  return { bytes: file.size, issues };
}

/**
 * Places files on user-owned devices. Metadata remains pending until the
 * device reports possession, and only then is the version committed.
 */
export async function uploadFiles(
  path: string,
  files: FlatFile[],
  folderPaths: string[],
  onProgress?: (progress: UploadProgress) => void,
): Promise<UploadResult> {
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
      result = await uploadOneDeviceBackedFile(file, destinationPath);
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
  objectHash: string,
  filename: string,
): Promise<void> {
  await downloadFromDevices(objectHash, filename);
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
