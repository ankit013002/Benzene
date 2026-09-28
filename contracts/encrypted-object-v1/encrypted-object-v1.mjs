import { createHash, randomBytes, webcrypto } from 'node:crypto';

const FORMAT = 'benzene-encrypted-object';
const VERSION = 1;
const ALGORITHM = 'AES-256-GCM';
const WRAP_ALGORITHM = 'HKDF-SHA-256+AES-256-GCM';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();

function assertVaultId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('vaultId must be 1–128 ASCII letters, digits, _ or -');
  }
}

function assertKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new TypeError('Vault Master Key must be exactly 32 bytes');
  }
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new TypeError(`${field} must be unpadded base64url`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new TypeError(`${field} is not canonical base64url`);
  }
  return new Uint8Array(bytes);
}

function payloadAad(vaultId, objectId, plaintextSize) {
  return encoder.encode(`benzene/encrypted-object/v1\n${vaultId}\n${objectId}\n${plaintextSize}`);
}

function wrappingAad(vaultId, objectId) {
  return encoder.encode(`benzene/object-key-wrap/v1\n${vaultId}\n${objectId}`);
}

async function deriveWrappingKey(vaultMasterKey, vaultId, objectId) {
  const keyMaterial = await webcrypto.subtle.importKey('raw', vaultMasterKey, 'HKDF', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(`benzene/v1/vault/${vaultId}`),
      info: encoder.encode(`benzene/v1/object-key-wrap/${objectId}`),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function validateMetadata(metadata, ciphertext) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('Encrypted object metadata must be an object');
  }
  const expectedKeys = [
    'format', 'version', 'payloadAlgorithm', 'keyWrapAlgorithm', 'vaultId', 'objectId', 'storageHash',
    'plaintextSize', 'payloadNonce', 'wrappedKeyNonce', 'wrappedKeyCiphertext',
  ].sort();
  const actualKeys = Object.keys(metadata).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError('Encrypted object metadata has missing or unknown fields');
  }
  if (metadata.format !== FORMAT || metadata.version !== VERSION
    || metadata.payloadAlgorithm !== ALGORITHM || metadata.keyWrapAlgorithm !== WRAP_ALGORITHM) {
    throw new TypeError('Unsupported encrypted object format or algorithm');
  }
  assertVaultId(metadata.vaultId);
  if (typeof metadata.objectId !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.objectId)) {
    throw new TypeError('objectId must be a lowercase SHA-256 hex digest');
  }
  if (typeof metadata.storageHash !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.storageHash)) {
    throw new TypeError('storageHash must be a lowercase SHA-256 hex digest');
  }
  if (!Number.isSafeInteger(metadata.plaintextSize) || metadata.plaintextSize < 0) {
    throw new TypeError('plaintextSize must be a non-negative safe integer');
  }
  const payloadNonce = fromBase64Url(metadata.payloadNonce, 'payloadNonce');
  const wrappedKeyNonce = fromBase64Url(metadata.wrappedKeyNonce, 'wrappedKeyNonce');
  const wrappedKeyCiphertext = fromBase64Url(metadata.wrappedKeyCiphertext, 'wrappedKeyCiphertext');
  if (payloadNonce.byteLength !== NONCE_BYTES || wrappedKeyNonce.byteLength !== NONCE_BYTES) {
    throw new TypeError('AES-GCM nonces must be exactly 12 bytes');
  }
  if (!(ciphertext instanceof Uint8Array)) throw new TypeError('ciphertext must be a Uint8Array');
  if (ciphertext.byteLength !== metadata.plaintextSize + TAG_BYTES) {
    throw new TypeError('Encrypted payload length must equal plaintextSize plus the 16-byte GCM tag');
  }
  if (wrappedKeyCiphertext.byteLength !== KEY_BYTES + TAG_BYTES) {
    throw new TypeError('Wrapped key must contain 32 encrypted key bytes and a 16-byte GCM tag');
  }
  const actualStorageHash = createHash('sha256').update(ciphertext).digest('hex');
  if (actualStorageHash !== metadata.storageHash) {
    throw new Error('Stored ciphertext hash does not match storageHash');
  }
  return { payloadNonce, wrappedKeyNonce, wrappedKeyCiphertext };
}

/** Encrypts one whole object in memory. The caller owns the VMK lifecycle. */
export async function encryptObject(plaintext, vaultMasterKey, vaultId) {
  if (!(plaintext instanceof Uint8Array)) throw new TypeError('plaintext must be a Uint8Array');
  assertKey(vaultMasterKey);
  assertVaultId(vaultId);

  const objectId = createHash('sha256').update(plaintext).digest('hex');
  const objectKeyBytes = randomBytes(KEY_BYTES);
  const payloadNonce = randomBytes(NONCE_BYTES);
  const wrappedKeyNonce = randomBytes(NONCE_BYTES);
  const payloadKey = await webcrypto.subtle.importKey('raw', objectKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const wrappingKey = await deriveWrappingKey(vaultMasterKey, vaultId, objectId);
  const payloadCiphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: payloadNonce, additionalData: payloadAad(vaultId, objectId, plaintext.byteLength), tagLength: 128 },
    payloadKey,
    plaintext,
  );
  const wrappedKeyCiphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrappedKeyNonce, additionalData: wrappingAad(vaultId, objectId), tagLength: 128 },
    wrappingKey,
    objectKeyBytes,
  );
  const payloadCiphertextBytes = new Uint8Array(payloadCiphertext);

  return {
    metadata: {
      format: FORMAT,
      version: VERSION,
      payloadAlgorithm: ALGORITHM,
      keyWrapAlgorithm: WRAP_ALGORITHM,
      vaultId,
      objectId,
      storageHash: createHash('sha256').update(payloadCiphertextBytes).digest('hex'),
      plaintextSize: plaintext.byteLength,
      payloadNonce: toBase64Url(payloadNonce),
      wrappedKeyNonce: toBase64Url(wrappedKeyNonce),
      wrappedKeyCiphertext: toBase64Url(new Uint8Array(wrappedKeyCiphertext)),
    },
    ciphertext: payloadCiphertextBytes,
  };
}

/** Authenticates compact metadata and raw ciphertext, returning plaintext or throwing. */
export async function decryptObject(metadata, ciphertext, vaultMasterKey) {
  assertKey(vaultMasterKey);
  const { payloadNonce, wrappedKeyNonce, wrappedKeyCiphertext } = validateMetadata(metadata, ciphertext);
  const wrappingKey = await deriveWrappingKey(vaultMasterKey, metadata.vaultId, metadata.objectId);
  const objectKeyBytes = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrappedKeyNonce, additionalData: wrappingAad(metadata.vaultId, metadata.objectId), tagLength: 128 },
    wrappingKey,
    wrappedKeyCiphertext,
  );
  const payloadKey = await webcrypto.subtle.importKey('raw', objectKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintextBuffer = await webcrypto.subtle.decrypt(
    {
      name: 'AES-GCM', iv: payloadNonce,
      additionalData: payloadAad(metadata.vaultId, metadata.objectId, metadata.plaintextSize), tagLength: 128,
    },
    payloadKey,
    ciphertext,
  );
  const plaintext = new Uint8Array(plaintextBuffer);
  if (plaintext.byteLength !== metadata.plaintextSize) throw new Error('Plaintext size does not match authenticated metadata');
  const actualObjectId = createHash('sha256').update(plaintext).digest('hex');
  if (actualObjectId !== metadata.objectId) throw new Error('Plaintext hash does not match authenticated objectId');
  return plaintext;
}
