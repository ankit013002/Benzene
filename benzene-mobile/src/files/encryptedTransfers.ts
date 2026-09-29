import { isRecord, type JsonRecord } from '../api/client';
import { ApiError } from '../api/client';
import type { EncryptedObject, EncryptedObjectMetadata } from '../crypto/encryptedObjectCore';

export const MAX_ENCRYPTED_FILE_BYTES = 25 * 1024 * 1024;
const DEVICE_HEADER_TIMEOUT_MS = 10_000;

export type DeviceTransferTarget = { deviceId: string; deviceName: string; url: string; grant: string; expiresAt: string };
export type EncryptedUploadResult = { nodeId: string; shortfall: boolean; protection: { desiredReplicas: number; healthyReplicas: number }; warnings: string[] };

export type JsonRequest = (path: string, init?: RequestInit) => Promise<unknown>;
export type DirectFetch = (url: string, init?: RequestInit) => Promise<Response>;

type Dependencies = {
  request: JsonRequest;
  directFetch: DirectFetch;
  allowInsecureLanTransfers: boolean;
  timeoutMs?: number;
};

type FileUploadInput = {
  name: string;
  path: string;
  contentType: string;
  plaintext: Uint8Array;
  vaultId: string;
  encrypt: (plaintext: Uint8Array, vaultId: string) => Promise<EncryptedObject>;
};

function fileErrorMessage(reason: string | undefined): string {
  switch (reason) {
    case 'no_devices': return 'Add a storage device to your Vault before uploading.';
    case 'none_online': return 'None of your storage devices are online right now.';
    case 'insufficient_capacity': return 'Your storage devices do not have enough free space.';
    case 'unreachable_devices': return 'No storage device with a reachable transfer address is available.';
    default: return 'No storage device was available for this file.';
  }
}

function parseTarget(value: unknown, allowInsecureLanTransfers: boolean, objectHash: string): DeviceTransferTarget | null {
  if (!isRecord(value) || typeof value.deviceId !== 'string' || typeof value.deviceName !== 'string'
    || typeof value.url !== 'string' || typeof value.grant !== 'string' || typeof value.expiresAt !== 'string') return null;
  let parsed: URL;
  try { parsed = new URL(value.url); } catch { return null; }
  if (parsed.protocol !== 'https:' && !(allowInsecureLanTransfers && parsed.protocol === 'http' && isPrivateHost(parsed.hostname))) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== `/objects/${objectHash}`) return null;
  return { deviceId: value.deviceId, deviceName: value.deviceName, url: parsed.toString(), grant: value.grant, expiresAt: value.expiresAt };
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true;
  // Accept only IPv6 literals in ULA (fc00::/7) or link-local (fe80::/10)
  // ranges; hostname prefix lookalikes must never receive an HTTP grant.
  if (host.includes(':') && (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host))) return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168
    || octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31
    || octets[0] === 169 && octets[1] === 254;
}

function responseData(payload: unknown, label: string): JsonRecord {
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error(`Benzene returned an invalid ${label} response.`);
  return payload.data;
}

function parseUploadReservation(payload: unknown, expectedStorageHash: string, allowInsecureLanTransfers: boolean) {
  const data = responseData(payload, 'upload reservation');
  if (typeof data.versionId !== 'string' || data.storageHash !== expectedStorageHash || !isRecord(data.placement) || !Array.isArray(data.placement.targets)
    || !Array.isArray(data.placement.alreadyHeldBy) || !data.placement.alreadyHeldBy.every((id) => typeof id === 'string')
    || typeof data.placement.shortfall !== 'boolean') throw new Error('Benzene returned an invalid encrypted upload reservation.');
  const targets = data.placement.targets.map((target) => parseTarget(target, allowInsecureLanTransfers, expectedStorageHash));
  if (targets.some((target) => target === null)) throw new Error('Benzene returned an unsafe or invalid storage-device target.');
  return {
    versionId: data.versionId,
    targets: targets as DeviceTransferTarget[],
    alreadyHeldBy: data.placement.alreadyHeldBy as string[],
    shortfall: data.placement.shortfall,
    reason: typeof data.placement.reason === 'string' ? data.placement.reason : undefined,
  };
}

function parseCompletion(payload: unknown): EncryptedUploadResult {
  const data = responseData(payload, 'encrypted upload completion');
  if (!Array.isArray(data.completed) || !isRecord(data.completed[0])) throw new Error('Benzene returned an invalid encrypted upload completion.');
  const completed = data.completed[0];
  if (typeof completed.nodeId !== 'string' || typeof completed.shortfall !== 'boolean' || !isRecord(completed.protection)
    || typeof completed.protection.desiredReplicas !== 'number' || typeof completed.protection.healthyReplicas !== 'number') {
    throw new Error('Benzene returned an invalid encrypted upload completion.');
  }
  return {
    nodeId: completed.nodeId,
    shortfall: completed.shortfall,
    protection: { desiredReplicas: completed.protection.desiredReplicas, healthyReplicas: completed.protection.healthyReplicas },
    warnings: [],
  };
}

/** Encrypts locally, sends compact metadata to Benzene, then sends only ciphertext to device grants. */
export async function uploadEncryptedFile(input: FileUploadInput, dependencies: Dependencies): Promise<EncryptedUploadResult> {
  if (input.plaintext.byteLength > MAX_ENCRYPTED_FILE_BYTES) {
    throw new Error(`Files larger than ${formatLimit(MAX_ENCRYPTED_FILE_BYTES)} are not supported on mobile yet. Use a connected computer.`);
  }
  const encrypted = await input.encrypt(input.plaintext, input.vaultId);
  if (encrypted.metadata.vaultId !== input.vaultId || encrypted.metadata.plaintextSize !== input.plaintext.byteLength
    || encrypted.ciphertext.byteLength !== input.plaintext.byteLength + 16) throw new Error('Local encryption returned an invalid object.');

  const reserved = await dependencies.request('/files/uploads/device/v1/encrypted', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: input.name, path: input.path, contentType: input.contentType, encryptedObject: encrypted.metadata }),
  });
  const reservation = parseUploadReservation(reserved, encrypted.metadata.storageHash, dependencies.allowInsecureLanTransfers);
  const warnings: string[] = [];
  const storedOn = [...reservation.alreadyHeldBy];
  for (const target of reservation.targets) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEVICE_HEADER_TIMEOUT_MS);
      let response: Response;
      try {
        response = await dependencies.directFetch(target.url, {
          method: 'PUT',
          headers: { 'X-Transfer-Grant': target.grant, 'Content-Type': input.contentType || 'application/octet-stream' },
          body: encrypted.ciphertext.slice().buffer,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 201) storedOn.push(target.deviceId);
      else warnings.push(`${target.deviceName} did not confirm the encrypted copy (${response.status}).`);
    } catch {
      warnings.push(`${target.deviceName} could not be reached; its transfer grant was not used.`);
    }
  }
  if (storedOn.length === 0) throw new Error(warnings.length > 0 ? `No device confirmed this upload. ${warnings.join(' ')}` : fileErrorMessage(reservation.reason));

  const completedPayload = await dependencies.request('/files/uploads/device/v1/encrypted/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ versionIds: [reservation.versionId] }),
  });
  const completion = parseCompletion(completedPayload);
  if (reservation.shortfall || completion.shortfall) {
    warnings.push(`Reduced protection: ${completion.protection.healthyReplicas} of ${completion.protection.desiredReplicas} required copies are confirmed.`);
  }
  return { ...completion, warnings };
}

type EncryptedDownloadInput = {
  nodeId: string;
  filename: string;
  contentType: string;
  availability?: string;
  vaultId: string;
  vmk: Uint8Array;
  decrypt: (metadata: EncryptedObjectMetadata, ciphertext: Uint8Array, vmk: Uint8Array) => Uint8Array;
  exportPlaintext: (filename: string, contentType: string, plaintext: Uint8Array) => Promise<void>;
};

/** Plans the current encrypted version, tries online holders, and exports only after local authentication succeeds. */
export async function downloadEncryptedCurrentFile(input: EncryptedDownloadInput, dependencies: Dependencies): Promise<void> {
  if (!input.vmk || input.vmk.byteLength !== 32) throw new Error('No Vault key is available on this device. Import your recovery kit before downloading encrypted files.');
  if (input.availability === 'unavailable') throw new Error('This file is unavailable because no durable copy can currently be found.');
  if (input.availability === 'waiting_for_device') throw new Error('This file is waiting for one of your storage devices to come online.');

  let metadataPayload: unknown;
  try {
    metadataPayload = await dependencies.request(`/files/${encodeURIComponent(input.nodeId)}/encrypted-object`);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 400 && cause.message.includes('not an encrypted v1 object')) {
      throw new Error('This file uses the earlier unencrypted storage format. Encrypted mobile downloads are not available for it yet.');
    }
    throw cause;
  }
  const metadataData = responseData(metadataPayload, 'encrypted file metadata');
  if (!isRecord(metadataData.encryptedObject)) throw new Error('This file has no encrypted metadata for the mobile client.');
  const metadata = metadataData.encryptedObject as unknown as EncryptedObjectMetadata;
  if (typeof metadata.storageHash !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.storageHash)
    || typeof metadata.vaultId !== 'string' || metadata.vaultId !== input.vaultId
    || typeof metadata.plaintextSize !== 'number' || !Number.isSafeInteger(metadata.plaintextSize) || metadata.plaintextSize < 0) {
    throw new Error('This file belongs to a different or invalid Vault encryption format.');
  }
  if (metadata.plaintextSize > MAX_ENCRYPTED_FILE_BYTES) {
    throw new Error(`Files larger than ${formatLimit(MAX_ENCRYPTED_FILE_BYTES)} are not supported on mobile yet. Use a connected computer.`);
  }
  const planPayload = await dependencies.request(`/placement/download-targets/${encodeURIComponent(metadata.storageHash)}`);
  const planData = responseData(planPayload, 'device read plan');
  if (!Array.isArray(planData.targets)) throw new Error('Benzene returned an invalid device read plan.');
  const targets = planData.targets.map((target) => parseTarget(target, dependencies.allowInsecureLanTransfers, metadata.storageHash));
  if (targets.some((target) => target === null)) throw new Error('Benzene returned an unsafe or invalid storage-device target.');
  const reachableTargets = targets as DeviceTransferTarget[];
  if (reachableTargets.length === 0) throw new Error('No online storage device is available to serve this file right now.');

  let deviceResponded = false;
  const timeoutMs = dependencies.timeoutMs ?? DEVICE_HEADER_TIMEOUT_MS;
  const expectedCiphertextBytes = metadata.plaintextSize + 16;
  for (const target of reachableTargets) {
    const headController = new AbortController();
    const headTimeout = setTimeout(() => headController.abort(), timeoutMs);
    let headResponse: Response;
    try {
      headResponse = await dependencies.directFetch(target.url, {
        method: 'HEAD', headers: { 'X-Transfer-Grant': target.grant }, signal: headController.signal,
      });
    } catch {
      continue;
    } finally {
      clearTimeout(headTimeout);
    }
    deviceResponded = true;
    if (!headResponse.ok) continue;
    const headLength = headResponse.headers.get('content-length');
    if (headLength === null || !/^\d+$/.test(headLength) || Number(headLength) !== expectedCiphertextBytes
      || Number(headLength) > MAX_ENCRYPTED_FILE_BYTES + 16) continue;

    let rawBytes: Uint8Array;
    const getController = new AbortController();
    const getTimeout = setTimeout(() => getController.abort(), timeoutMs);
    try {
      const response = await dependencies.directFetch(target.url, {
        headers: { 'X-Transfer-Grant': target.grant }, signal: getController.signal,
      });
      if (!response.ok) continue;
      const getLength = response.headers.get('content-length');
      if (getLength !== null && (!/^\d+$/.test(getLength) || Number(getLength) !== expectedCiphertextBytes)) continue;
      rawBytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      continue;
    }
    finally {
      clearTimeout(getTimeout);
    }
    if (rawBytes.byteLength !== expectedCiphertextBytes || rawBytes.byteLength > MAX_ENCRYPTED_FILE_BYTES + 16) {
      rawBytes.fill(0);
      continue;
    }
    let plaintext: Uint8Array;
    try { plaintext = input.decrypt(metadata, rawBytes, input.vmk); } catch {
      rawBytes.fill(0);
      continue;
    }
    try {
      await input.exportPlaintext(input.filename, input.contentType, plaintext);
      return;
    } finally {
      plaintext.fill(0);
      rawBytes.fill(0);
    }
  }
  if (deviceResponded) throw new Error('No available device returned a valid, decryptable copy. The file was not exported.');
  throw new Error('None of the storage devices holding this file could be reached.');
}

function formatLimit(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MB`;
}
