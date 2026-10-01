/** Browser implementation of contracts/encrypted-object-v1. */
export const ENCRYPTED_OBJECT_MAX_BYTES = 25 * 1024 * 1024;

const FORMAT = "benzene-encrypted-object";
const VERSION = 1;
const PAYLOAD_ALGORITHM = "AES-256-GCM";
const KEY_WRAP_ALGORITHM = "HKDF-SHA-256+AES-256-GCM";
const encoder = new TextEncoder();

export interface EncryptedObjectMetadata {
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
}

export interface EncryptedObject {
  metadata: EncryptedObjectMetadata;
  ciphertext: Uint8Array;
}

export type RandomBytes = (length: number) => Uint8Array;

function assertVaultId(vaultId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(vaultId)) {
    throw new TypeError("vaultId must be 1–128 ASCII letters, digits, _ or -");
  }
}

function assertVmk(vmk: Uint8Array): void {
  if (!(vmk instanceof Uint8Array) || vmk.byteLength !== 32) {
    throw new TypeError("Vault Master Key must be exactly 32 bytes");
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string, field: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${field} must be canonical unpadded base64url`);
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(decoded) !== value) throw new TypeError(`${field} must be canonical unpadded base64url`);
  return decoded;
}

function payloadAad(vaultId: string, objectId: string, plaintextSize: number): Uint8Array {
  return encoder.encode(`benzene/encrypted-object/v1\n${vaultId}\n${objectId}\n${plaintextSize}`);
}

function wrappingAad(vaultId: string, objectId: string): Uint8Array {
  return encoder.encode(`benzene/object-key-wrap/v1\n${vaultId}\n${objectId}`);
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))));
}

async function deriveWrappingKey(vmk: Uint8Array, vaultId: string, objectId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", toArrayBuffer(vmk), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(encoder.encode(`benzene/v1/vault/${vaultId}`)),
      info: toArrayBuffer(encoder.encode(`benzene/v1/object-key-wrap/${objectId}`)),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function secureRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Injectable randomness exists so the shared contract vector can be asserted byte for byte. */
export async function encryptObjectWithRandomValues(
  plaintext: Uint8Array,
  vaultMasterKey: Uint8Array,
  vaultId: string,
  randomBytes: RandomBytes,
): Promise<EncryptedObject> {
  if (!(plaintext instanceof Uint8Array)) throw new TypeError("plaintext must be a Uint8Array");
  assertVmk(vaultMasterKey);
  assertVaultId(vaultId);
  if (plaintext.byteLength > ENCRYPTED_OBJECT_MAX_BYTES) {
    throw new Error("Web uploads currently support files up to 25 MiB.");
  }

  const objectId = await digestHex(plaintext);
  const objectKeyBytes = randomBytes(32);
  const payloadNonce = randomBytes(12);
  const wrappedKeyNonce = randomBytes(12);
  if (objectKeyBytes.byteLength !== 32 || payloadNonce.byteLength !== 12 || wrappedKeyNonce.byteLength !== 12) {
    throw new Error("Secure random source returned an invalid value");
  }
  const payloadKey = await crypto.subtle.importKey("raw", toArrayBuffer(objectKeyBytes), "AES-GCM", false, ["encrypt"]);
  const wrappingKey = await deriveWrappingKey(vaultMasterKey, vaultId, objectId);
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(payloadNonce), additionalData: toArrayBuffer(payloadAad(vaultId, objectId, plaintext.byteLength)), tagLength: 128 },
      payloadKey,
      toArrayBuffer(plaintext),
    ));
    const wrappedKeyCiphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(wrappedKeyNonce), additionalData: toArrayBuffer(wrappingAad(vaultId, objectId)), tagLength: 128 },
      wrappingKey,
      toArrayBuffer(objectKeyBytes),
    ));
    return {
      metadata: {
        format: FORMAT,
        version: VERSION,
        payloadAlgorithm: PAYLOAD_ALGORITHM,
        keyWrapAlgorithm: KEY_WRAP_ALGORITHM,
        vaultId,
        objectId,
        storageHash: await digestHex(ciphertext),
        plaintextSize: plaintext.byteLength,
        payloadNonce: encodeBase64Url(payloadNonce),
        wrappedKeyNonce: encodeBase64Url(wrappedKeyNonce),
        wrappedKeyCiphertext: encodeBase64Url(wrappedKeyCiphertext),
      },
      ciphertext,
    };
  } finally {
    objectKeyBytes.fill(0);
  }
}

export function encryptObject(
  plaintext: Uint8Array,
  vaultMasterKey: Uint8Array,
  vaultId: string,
): Promise<EncryptedObject> {
  return encryptObjectWithRandomValues(plaintext, vaultMasterKey, vaultId, secureRandomBytes);
}

function validateMetadata(metadata: EncryptedObjectMetadata, ciphertext: Uint8Array) {
  const expectedKeys = [
    "format", "version", "payloadAlgorithm", "keyWrapAlgorithm", "vaultId", "objectId", "storageHash",
    "plaintextSize", "payloadNonce", "wrappedKeyNonce", "wrappedKeyCiphertext",
  ].sort();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("Encrypted metadata must be an object");
  const actualKeys = Object.keys(metadata).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("Encrypted object metadata has missing or unknown fields");
  }
  if (metadata.format !== FORMAT || metadata.version !== VERSION || metadata.payloadAlgorithm !== PAYLOAD_ALGORITHM
    || metadata.keyWrapAlgorithm !== KEY_WRAP_ALGORITHM) throw new TypeError("Unsupported encrypted object format or algorithm");
  assertVaultId(metadata.vaultId);
  if (!/^[a-f0-9]{64}$/.test(metadata.objectId) || !/^[a-f0-9]{64}$/.test(metadata.storageHash)) {
    throw new TypeError("Object identities must be lowercase SHA-256 hex digests");
  }
  if (!Number.isSafeInteger(metadata.plaintextSize) || metadata.plaintextSize < 0
    || metadata.plaintextSize > ENCRYPTED_OBJECT_MAX_BYTES) throw new TypeError("plaintextSize is outside the supported range");
  const payloadNonce = decodeBase64Url(metadata.payloadNonce, "payloadNonce");
  const wrappedKeyNonce = decodeBase64Url(metadata.wrappedKeyNonce, "wrappedKeyNonce");
  const wrappedKeyCiphertext = decodeBase64Url(metadata.wrappedKeyCiphertext, "wrappedKeyCiphertext");
  if (payloadNonce.byteLength !== 12 || wrappedKeyNonce.byteLength !== 12 || wrappedKeyCiphertext.byteLength !== 48) {
    throw new TypeError("Encrypted metadata contains invalid cryptographic lengths");
  }
  if (ciphertext.byteLength !== metadata.plaintextSize + 16) throw new TypeError("Encrypted payload has an invalid size");
  return { payloadNonce, wrappedKeyNonce, wrappedKeyCiphertext };
}

export async function decryptObject(
  metadata: EncryptedObjectMetadata,
  ciphertext: Uint8Array,
  vaultMasterKey: Uint8Array,
): Promise<Uint8Array> {
  assertVmk(vaultMasterKey);
  const { payloadNonce, wrappedKeyNonce, wrappedKeyCiphertext } = validateMetadata(metadata, ciphertext);
  if (await digestHex(ciphertext) !== metadata.storageHash) throw new Error("Stored ciphertext hash does not match storageHash");
  const wrappingKey = await deriveWrappingKey(vaultMasterKey, metadata.vaultId, metadata.objectId);
  const objectKeyBytes = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(wrappedKeyNonce), additionalData: toArrayBuffer(wrappingAad(metadata.vaultId, metadata.objectId)), tagLength: 128 },
    wrappingKey,
    toArrayBuffer(wrappedKeyCiphertext),
  ));
  try {
    const payloadKey = await crypto.subtle.importKey("raw", toArrayBuffer(objectKeyBytes), "AES-GCM", false, ["decrypt"]);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(payloadNonce), additionalData: toArrayBuffer(payloadAad(metadata.vaultId, metadata.objectId, metadata.plaintextSize)), tagLength: 128 },
      payloadKey,
      toArrayBuffer(ciphertext),
    ));
    if (plaintext.byteLength !== metadata.plaintextSize || await digestHex(plaintext) !== metadata.objectId) {
      plaintext.fill(0);
      throw new Error("Plaintext does not match authenticated object metadata");
    }
    return plaintext;
  } finally {
    objectKeyBytes.fill(0);
  }
}

async function recoveryKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const passphraseBytes = encoder.encode(passphrase);
  const material = await crypto.subtle.importKey("raw", toArrayBuffer(passphraseBytes), "PBKDF2", false, ["deriveKey"]);
  passphraseBytes.fill(0);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: 600_000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const RECOVERY_KIT_FORMAT = "benzene-vmk-recovery";
const RECOVERY_KIT_VERSION = 1;
const RECOVERY_KIT_KDF = "PBKDF2-HMAC-SHA-256";
const RECOVERY_KIT_CIPHER = "AES-256-GCM";
const RECOVERY_KIT_ITERATIONS = 600_000;

function assertRecoveryPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || [...passphrase].length < 16 || passphrase.trim().length === 0) {
    throw new TypeError("Use a recovery passphrase with at least 16 characters; a unique six-word phrase is recommended.");
  }
}

/** Creates the mobile v1 passphrase-encrypted JSON recovery kit. */
export async function exportRecoveryKitWithRandomValues(
  vaultId: string,
  vmk: Uint8Array,
  passphrase: string,
  randomBytes: RandomBytes,
): Promise<string> {
  assertVaultId(vaultId);
  assertVmk(vmk);
  assertRecoveryPassphrase(passphrase);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  if (salt.byteLength !== 16 || nonce.byteLength !== 12) throw new Error("Secure random source returned an invalid value");
  const saltEncoded = encodeBase64Url(salt);
  const kit = {
    format: RECOVERY_KIT_FORMAT,
    version: RECOVERY_KIT_VERSION,
    vaultId,
    kdf: RECOVERY_KIT_KDF,
    iterations: RECOVERY_KIT_ITERATIONS,
    cipher: RECOVERY_KIT_CIPHER,
    salt: saltEncoded,
    nonce: encodeBase64Url(nonce),
    ciphertext: "",
  };
  const aad = encoder.encode(`${kit.format}\n${kit.version}\n${kit.vaultId}\n${kit.kdf}\n${kit.iterations}\n${kit.salt}\n${kit.cipher}`);
  const key = await recoveryKey(passphrase, salt);
  try {
    kit.ciphertext = encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad), tagLength: 128 },
      key,
      toArrayBuffer(vmk),
    )));
    return JSON.stringify(kit);
  } finally {
    salt.fill(0);
    nonce.fill(0);
    aad.fill(0);
  }
}

export function exportRecoveryKit(vaultId: string, vmk: Uint8Array, passphrase: string): Promise<string> {
  return exportRecoveryKitWithRandomValues(vaultId, vmk, passphrase, secureRandomBytes);
}

/** Imports the mobile v1 passphrase-encrypted recovery kit; does not store the key. */
export async function importRecoveryKit(serialized: string, expectedVaultId: string, passphrase: string): Promise<Uint8Array> {
  assertVaultId(expectedVaultId);
  assertRecoveryPassphrase(passphrase);
  if (serialized.length > 4096) throw new TypeError("Recovery kit is malformed or too large");
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new TypeError("Recovery kit is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Recovery kit must be a JSON object");
  const kit = value as Record<string, unknown>;
  const keys = ["format", "version", "vaultId", "kdf", "iterations", "cipher", "salt", "nonce", "ciphertext"].sort();
  const actual = Object.keys(kit).sort();
  if (keys.length !== actual.length || keys.some((key, index) => key !== actual[index])) throw new TypeError("Recovery kit has missing or unknown fields");
  if (kit.format !== "benzene-vmk-recovery" || kit.version !== 1 || kit.kdf !== "PBKDF2-HMAC-SHA-256"
    || kit.iterations !== 600_000 || kit.cipher !== "AES-256-GCM") throw new TypeError("Unsupported recovery kit format or cryptographic parameters");
  if (kit.vaultId !== expectedVaultId) throw new Error("This recovery kit belongs to a different Vault");
  if (typeof kit.salt !== "string" || typeof kit.nonce !== "string" || typeof kit.ciphertext !== "string") {
    throw new TypeError("Recovery kit fields must be strings");
  }
  const salt = decodeBase64Url(kit.salt, "salt");
  const nonce = decodeBase64Url(kit.nonce, "nonce");
  const ciphertext = decodeBase64Url(kit.ciphertext, "ciphertext");
  if (salt.byteLength !== 16 || nonce.byteLength !== 12 || ciphertext.byteLength !== 48) throw new TypeError("Recovery kit has invalid cryptographic lengths");
  const aad = encoder.encode(`${kit.format}\n${kit.version}\n${kit.vaultId}\n${kit.kdf}\n${kit.iterations}\n${kit.salt}\n${kit.cipher}`);
  const key = await recoveryKey(passphrase, salt);
  const vmk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad), tagLength: 128 }, key, toArrayBuffer(ciphertext)));
  assertVmk(vmk);
  return vmk;
}
