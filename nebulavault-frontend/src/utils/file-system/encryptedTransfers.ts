import {
  decryptObject,
  ENCRYPTED_OBJECT_MAX_BYTES,
  encryptObject,
  type EncryptedObjectMetadata,
} from "./encryptedObject";
import { loadUnlockedVaultKey } from "./vaultKey";
import { downloadFromDevices } from "./deviceUpload";
import { receiveRelayCiphertext, requestRelayReadFallback } from "./relayCiphertext";

interface TransferTarget {
  deviceId: string;
  deviceName: string;
  url: string;
  grant: string;
  expiresAt: string;
}

const DEVICE_FETCH_HEADER_TIMEOUT_MS = 10_000;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return { message: text }; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(payload: unknown, fallback: string): string {
  return record(payload) && typeof payload.message === "string" && payload.message.trim()
    ? payload.message
    : fallback;
}

function responseData(payload: unknown, label: string): Record<string, unknown> {
  if (!record(payload) || !record(payload.data)) throw new Error(`Benzene returned an invalid ${label}.`);
  return payload.data;
}

function isPrivateLanHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host === "::1") return true;
  if (host.includes(":") && (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host))) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168
    || octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31
    || octets[0] === 169 && octets[1] === 254;
}

function parseTarget(value: unknown, expectedStorageHash: string): TransferTarget {
  if (!record(value) || typeof value.deviceId !== "string" || typeof value.deviceName !== "string"
    || typeof value.url !== "string" || typeof value.grant !== "string" || typeof value.expiresAt !== "string") {
    throw new Error("Benzene returned an invalid storage-device target.");
  }
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error("Benzene returned an unsafe storage-device target."); }
  const validTransport = url.protocol === "https:" || url.protocol === "http:" && isPrivateLanHost(url.hostname);
  const expiresAt = Date.parse(value.expiresAt);
  if (!validTransport || url.username || url.password || url.search || url.hash
    || url.pathname !== `/objects/${expectedStorageHash}` || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Benzene returned an unsafe or expired storage-device target.");
  }
  return { deviceId: value.deviceId, deviceName: value.deviceName, url: url.toString(), grant: value.grant, expiresAt: value.expiresAt };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseMetadata(value: unknown, expectedVaultId: string, expectedStorageHash: string): EncryptedObjectMetadata {
  if (!record(value) || value.format !== "benzene-encrypted-object" || value.version !== 1
    || value.payloadAlgorithm !== "AES-256-GCM" || value.keyWrapAlgorithm !== "HKDF-SHA-256+AES-256-GCM"
    || value.vaultId !== expectedVaultId || value.storageHash !== expectedStorageHash
    || typeof value.objectId !== "string" || !/^[a-f0-9]{64}$/.test(value.objectId)
    || typeof value.plaintextSize !== "number" || !Number.isSafeInteger(value.plaintextSize)
    || value.plaintextSize < 0 || typeof value.payloadNonce !== "string"
    || typeof value.wrappedKeyNonce !== "string" || typeof value.wrappedKeyCiphertext !== "string") {
    throw new Error("Benzene returned invalid encrypted file metadata.");
  }
  return value as unknown as EncryptedObjectMetadata;
}

export interface EncryptedUploadResult {
  bytes: number;
  issues: string[];
}

/** Encrypts before reservation, then sends the ciphertext only to grant-selected devices. */
export async function uploadEncryptedFile(
  file: File,
  path: string,
  vaultId: string,
): Promise<EncryptedUploadResult> {
  const vmk = await loadUnlockedVaultKey(vaultId);
  if (!vmk) throw new Error("Import this Vault’s recovery kit before uploading encrypted files.");
  const encrypted = await encryptObject(new Uint8Array(await file.arrayBuffer()), vmk, vaultId);
  const reservationResponse = await fetch("/api/files/uploads/device/v1/encrypted", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      path,
      contentType: file.type || "application/octet-stream",
      encryptedObject: encrypted.metadata,
    }),
  });
  const reservationPayload = await readJson(reservationResponse);
  if (!reservationResponse.ok) throw new Error(errorMessage(reservationPayload, "Could not reserve a place for this file"));
  const reservation = responseData(reservationPayload, "encrypted upload reservation");
  if (typeof reservation.versionId !== "string" || reservation.versionId.length === 0
    || reservation.storageHash !== encrypted.metadata.storageHash || !record(reservation.placement)
    || !Array.isArray(reservation.placement.targets) || !Array.isArray(reservation.placement.alreadyHeldBy)
    || !reservation.placement.alreadyHeldBy.every((id) => typeof id === "string")
    || reservation.placement.storageHash !== encrypted.metadata.storageHash
    || typeof reservation.placement.shortfall !== "boolean"
    || !isNonNegativeInteger(reservation.placement.desiredReplicas)
    || reservation.placement.desiredReplicas < 1
    || (reservation.placement.reason !== undefined && typeof reservation.placement.reason !== "string")) {
    throw new Error("Benzene returned an invalid encrypted upload reservation.");
  }
  const targets = reservation.placement.targets.map((target) => parseTarget(target, encrypted.metadata.storageHash));
  const storedOn = [...reservation.placement.alreadyHeldBy];
  const issues: string[] = [];
  let possessionPending = false;
  for (const target of targets) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), DEVICE_FETCH_HEADER_TIMEOUT_MS);
    try {
      const response = await fetch(target.url, {
        method: "PUT",
        headers: {
          "X-Transfer-Grant": target.grant,
          "Content-Type": file.type || "application/octet-stream",
        },
        body: encrypted.ciphertext.slice().buffer,
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);
      if (response.status === 201) storedOn.push(target.deviceId);
      else {
        if (response.status === 503) possessionPending = true;
        issues.push(`${target.deviceName}: ${await errorMessage(await readJson(response), `refused with ${response.status}`)}`);
      }
    } catch {
      issues.push(`${target.deviceName}: could not be reached`);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }
  if (storedOn.length === 0) {
    if (possessionPending) issues.push(`${file.name} is not confirmed on any device yet; retry this upload safely`);
    throw new Error(issues.length ? issues.join(". ") : `${file.name} could not be stored on any device`);
  }

  const completionResponse = await fetch("/api/files/uploads/device/v1/encrypted/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionIds: [reservation.versionId] }),
  });
  const completionPayload = await readJson(completionResponse);
  if (!completionResponse.ok) throw new Error(errorMessage(completionPayload, "Could not finish this encrypted upload"));
  const completion = responseData(completionPayload, "encrypted upload completion");
  if (!Array.isArray(completion.completed) || !record(completion.completed[0])) {
    throw new Error("Benzene returned an invalid encrypted upload completion.");
  }
  const completed = completion.completed[0];
  const protection = completed.protection;
  if (typeof completed.nodeId !== "string" || completed.nodeId.length === 0 || typeof completed.shortfall !== "boolean"
    || !record(protection) || !isNonNegativeInteger(protection.desiredReplicas)
    || !isNonNegativeInteger(protection.healthyReplicas) || protection.healthyReplicas > protection.desiredReplicas) {
    throw new Error("Benzene returned an invalid encrypted upload completion.");
  }
  if (completed.shortfall) {
    issues.push(`${file.name} has reduced protection: stored on ${protection.healthyReplicas} of ${protection.desiredReplicas} devices`);
  }
  return { bytes: file.size, issues };
}

/** Returns true after a plaintext-era compatibility download. */
export async function downloadCurrentFile(
  nodeId: string,
  objectHash: string,
  filename: string,
  vaultId: string,
): Promise<boolean> {
  const vmk = await loadUnlockedVaultKey(vaultId);
  const metadataResponse = await fetch(`/api/files/${encodeURIComponent(nodeId)}/encrypted-object`, { cache: "no-store" });
  const metadataPayload = await readJson(metadataResponse);
  if (!metadataResponse.ok) {
    const message = errorMessage(metadataPayload, "Could not load encrypted file metadata");
    // Keep old content readable, but make it explicit that no decryption occurred.
    if (metadataResponse.status === 400 && message.includes("not an encrypted v1 object")) {
      await downloadFromDevices(objectHash, filename);
      return true;
    }
    throw new Error(message);
  }
  if (!vmk) throw new Error("Import this Vault’s recovery kit before downloading encrypted files.");
  const metadataData = responseData(metadataPayload, "encrypted file metadata");
  const metadata = parseMetadata(metadataData.encryptedObject, vaultId, objectHash);
  const planResponse = await fetch(`/api/placement/download-targets/${encodeURIComponent(metadata.storageHash)}`);
  const planPayload = await readJson(planResponse);
  if (!planResponse.ok) throw new Error(errorMessage(planPayload, "Could not locate this file on your devices"));
  const plan = responseData(planPayload, "device read plan");
  if (!Array.isArray(plan.targets) || plan.targets.length === 0) throw new Error("None of the devices holding this file are reachable right now");

  for (const item of plan.targets) {
    const target = parseTarget(item, metadata.storageHash);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), DEVICE_FETCH_HEADER_TIMEOUT_MS);
    try {
      const headResponse = await fetch(target.url, {
        method: "HEAD",
        headers: { "X-Transfer-Grant": target.grant },
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);
      const expectedBytes = metadata.plaintextSize + 16;
      const headLength = headResponse.headers.get("content-length");
      if (!headResponse.ok || headLength === null || !/^\d+$/.test(headLength) || Number(headLength) !== expectedBytes
        || expectedBytes > ENCRYPTED_OBJECT_MAX_BYTES + 16) continue;
      const getController = new AbortController();
      const getTimeoutId = window.setTimeout(() => getController.abort(), DEVICE_FETCH_HEADER_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(target.url, {
          headers: { "X-Transfer-Grant": target.grant },
          signal: getController.signal,
        });
      } finally {
        window.clearTimeout(getTimeoutId);
      }
      const getLength = response.headers.get("content-length");
      if (!response.ok || getLength === null || !/^\d+$/.test(getLength) || Number(getLength) !== expectedBytes) continue;
      const ciphertext = new Uint8Array(await response.arrayBuffer());
      if (ciphertext.byteLength !== expectedBytes) {
        ciphertext.fill(0);
        continue;
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await decryptObject(metadata, ciphertext, vmk);
      } finally {
        ciphertext.fill(0);
      }
      try {
        const url = URL.createObjectURL(new Blob([Uint8Array.from(plaintext).buffer], { type: "application/octet-stream" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        plaintext.fill(0);
      }
      return false;
    } catch {
      // Try the next independently authorized holder after a network or auth failure.
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  const ciphertextBytes = metadata.plaintextSize + 16;
  const fallback = await requestRelayReadFallback({ nodeId, storageHash: metadata.storageHash, ciphertextBytes });
  const ciphertext = await receiveRelayCiphertext({
    fallback,
    expectedStorageHash: metadata.storageHash,
    expectedCiphertextBytes: ciphertextBytes,
  });
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptObject(metadata, ciphertext, vmk);
  } catch {
    ciphertext.fill(0);
    throw new Error("The relayed copy failed encrypted-object authentication. The file was not exported.");
  }
  try {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(plaintext).buffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally {
    plaintext.fill(0);
    ciphertext.fill(0);
  }
  return false;
}
