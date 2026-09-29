import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, decodeBase64Url, encodeBase64Url } from './bytes';

const FORMAT = 'benzene-encrypted-object';
const VERSION = 1;
const PAYLOAD_ALGORITHM = 'AES-256-GCM';
const KEY_WRAP_ALGORITHM = 'HKDF-SHA-256+AES-256-GCM';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();

export type EncryptedObjectMetadata = {
  format: typeof FORMAT;
  version: typeof VERSION;
  payloadAlgorithm: typeof PAYLOAD_ALGORITHM;
  keyWrapAlgorithm: typeof KEY_WRAP_ALGORITHM;
  vaultId: string;
  objectId: string;
  storageHash: string;
  plaintextSize: number;
  payloadNonce: string;
  wrappedKeyNonce: string;
  wrappedKeyCiphertext: string;
};

export type EncryptedObject = { metadata: EncryptedObjectMetadata; ciphertext: Uint8Array };
export type RandomBytes = (length: number) => Promise<Uint8Array>;

function assertVaultId(vaultId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(vaultId)) throw new TypeError('vaultId must be 1–128 ASCII letters, digits, _ or -');
}

function assertVmk(vmk: Uint8Array): void {
  if (!(vmk instanceof Uint8Array) || vmk.byteLength !== KEY_BYTES) throw new TypeError('Vault Master Key must be exactly 32 bytes');
}

function payloadAad(vaultId: string, objectId: string, plaintextSize: number): Uint8Array {
  return encoder.encode(`benzene/encrypted-object/v1\n${vaultId}\n${objectId}\n${plaintextSize}`);
}

function wrappingAad(vaultId: string, objectId: string): Uint8Array {
  return encoder.encode(`benzene/object-key-wrap/v1\n${vaultId}\n${objectId}`);
}

function wrappingKey(vmk: Uint8Array, vaultId: string, objectId: string): Uint8Array {
  return hkdf(
    sha256,
    vmk,
    encoder.encode(`benzene/v1/vault/${vaultId}`),
    encoder.encode(`benzene/v1/object-key-wrap/${objectId}`),
    KEY_BYTES,
  );
}

async function requiredRandom(randomBytes: RandomBytes, length: number): Promise<Uint8Array> {
  const value = await randomBytes(length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) throw new Error('Secure random source returned an invalid value');
  return value;
}

/** Internal primitive with injectable randomness, used only to run the shared deterministic conformance vector. */
export async function encryptObjectWithRandomValues(
  plaintext: Uint8Array,
  vaultMasterKey: Uint8Array,
  vaultId: string,
  randomBytes: RandomBytes,
): Promise<EncryptedObject> {
  if (!(plaintext instanceof Uint8Array)) throw new TypeError('plaintext must be a Uint8Array');
  assertVmk(vaultMasterKey);
  assertVaultId(vaultId);
  const objectId = bytesToHex(sha256(plaintext));
  const objectKey = (await requiredRandom(randomBytes, KEY_BYTES)).slice();
  const payloadNonce = await requiredRandom(randomBytes, NONCE_BYTES);
  const wrappedKeyNonce = await requiredRandom(randomBytes, NONCE_BYTES);
  const wrapKey = wrappingKey(vaultMasterKey, vaultId, objectId);
  try {
    const ciphertext = gcm(objectKey, payloadNonce, payloadAad(vaultId, objectId, plaintext.byteLength)).encrypt(plaintext);
    const wrappedKeyCiphertext = gcm(wrapKey, wrappedKeyNonce, wrappingAad(vaultId, objectId)).encrypt(objectKey);
    return {
      metadata: {
        format: FORMAT,
        version: VERSION,
        payloadAlgorithm: PAYLOAD_ALGORITHM,
        keyWrapAlgorithm: KEY_WRAP_ALGORITHM,
        vaultId,
        objectId,
        storageHash: bytesToHex(sha256(ciphertext)),
        plaintextSize: plaintext.byteLength,
        payloadNonce: encodeBase64Url(payloadNonce),
        wrappedKeyNonce: encodeBase64Url(wrappedKeyNonce),
        wrappedKeyCiphertext: encodeBase64Url(wrappedKeyCiphertext),
      },
      ciphertext,
    };
  } finally {
    objectKey.fill(0);
    wrapKey.fill(0);
  }
}

function validateMetadata(metadata: EncryptedObjectMetadata, ciphertext: Uint8Array) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('Encrypted object metadata must be an object');
  const expected = [
    'format', 'version', 'payloadAlgorithm', 'keyWrapAlgorithm', 'vaultId', 'objectId', 'storageHash',
    'plaintextSize', 'payloadNonce', 'wrappedKeyNonce', 'wrappedKeyCiphertext',
  ].sort();
  const actual = Object.keys(metadata).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError('Encrypted object metadata has missing or unknown fields');
  }
  if (metadata.format !== FORMAT || metadata.version !== VERSION || metadata.payloadAlgorithm !== PAYLOAD_ALGORITHM
    || metadata.keyWrapAlgorithm !== KEY_WRAP_ALGORITHM) throw new TypeError('Unsupported encrypted object format or algorithm');
  assertVaultId(metadata.vaultId);
  if (!/^[a-f0-9]{64}$/.test(metadata.objectId) || !/^[a-f0-9]{64}$/.test(metadata.storageHash)) {
    throw new TypeError('Object identities must be lowercase SHA-256 hex digests');
  }
  if (!Number.isSafeInteger(metadata.plaintextSize) || metadata.plaintextSize < 0) throw new TypeError('plaintextSize must be a non-negative safe integer');
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength !== metadata.plaintextSize + TAG_BYTES) {
    throw new TypeError('Encrypted payload length must equal plaintextSize plus the 16-byte GCM tag');
  }
  const payloadNonce = decodeBase64Url(metadata.payloadNonce, 'payloadNonce');
  const wrappedKeyNonce = decodeBase64Url(metadata.wrappedKeyNonce, 'wrappedKeyNonce');
  const wrappedKeyCiphertext = decodeBase64Url(metadata.wrappedKeyCiphertext, 'wrappedKeyCiphertext');
  if (payloadNonce.byteLength !== NONCE_BYTES || wrappedKeyNonce.byteLength !== NONCE_BYTES) throw new TypeError('AES-GCM nonces must be exactly 12 bytes');
  if (wrappedKeyCiphertext.byteLength !== KEY_BYTES + TAG_BYTES) throw new TypeError('Wrapped key must contain 32 encrypted bytes and a 16-byte GCM tag');
  if (bytesToHex(sha256(ciphertext)) !== metadata.storageHash) throw new Error('Stored ciphertext hash does not match storageHash');
  return { payloadNonce, wrappedKeyNonce, wrappedKeyCiphertext };
}

/** Encrypts a complete object in memory. The VMK remains a local client secret. */
export function encryptObject(plaintext: Uint8Array, vaultMasterKey: Uint8Array, vaultId: string, randomBytes: RandomBytes): Promise<EncryptedObject> {
  return encryptObjectWithRandomValues(plaintext, vaultMasterKey, vaultId, randomBytes);
}

/** Authenticates compact metadata and raw ciphertext, returning plaintext or throwing. */
export function decryptObject(metadata: EncryptedObjectMetadata, ciphertext: Uint8Array, vaultMasterKey: Uint8Array): Uint8Array {
  assertVmk(vaultMasterKey);
  const { payloadNonce, wrappedKeyNonce, wrappedKeyCiphertext } = validateMetadata(metadata, ciphertext);
  const wrapKey = wrappingKey(vaultMasterKey, metadata.vaultId, metadata.objectId);
  let objectKey: Uint8Array | undefined;
  try {
    objectKey = gcm(wrapKey, wrappedKeyNonce, wrappingAad(metadata.vaultId, metadata.objectId)).decrypt(wrappedKeyCiphertext);
    const plaintext = gcm(objectKey, payloadNonce, payloadAad(metadata.vaultId, metadata.objectId, metadata.plaintextSize)).decrypt(ciphertext);
    if (plaintext.byteLength !== metadata.plaintextSize) throw new Error('Plaintext size does not match authenticated metadata');
    if (bytesToHex(sha256(plaintext)) !== metadata.objectId) throw new Error('Plaintext hash does not match authenticated objectId');
    return plaintext;
  } finally {
    wrapKey.fill(0);
    objectKey?.fill(0);
  }
}
