import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeBase64Url, encodeBase64Url } from './bytes';

const FORMAT = 'benzene-vmk-recovery';
const VERSION = 1;
const KDF = 'PBKDF2-HMAC-SHA-256';
const CIPHER = 'AES-256-GCM';
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const VMK_BYTES = 32;
const encoder = new TextEncoder();

type RecoveryKit = {
  format: typeof FORMAT;
  version: typeof VERSION;
  vaultId: string;
  kdf: typeof KDF;
  iterations: typeof ITERATIONS;
  cipher: typeof CIPHER;
  salt: string;
  nonce: string;
  ciphertext: string;
};

export type RandomBytes = (length: number) => Promise<Uint8Array>;

function assertVaultId(vaultId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(vaultId)) throw new TypeError('vaultId must be 1–128 ASCII letters, digits, _ or -');
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || [...passphrase].length < 16 || passphrase.trim().length === 0) {
    throw new TypeError('Use a recovery passphrase with at least 16 characters; a unique six-word phrase is recommended.');
  }
}

function aad(kit: Pick<RecoveryKit, 'vaultId' | 'iterations' | 'salt'>): Uint8Array {
  return encoder.encode(`${FORMAT}\n${VERSION}\n${kit.vaultId}\n${KDF}\n${kit.iterations}\n${kit.salt}\n${CIPHER}`);
}

async function recoveryKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return pbkdf2Async(sha256, passphrase, salt, { c: ITERATIONS, dkLen: VMK_BYTES, asyncTick: 8 });
}

/** Produces a portable, passphrase-encrypted JSON string. Treat it like a high-value secret. */
export async function exportRecoveryKitWithRandomValues(vaultId: string, vmk: Uint8Array, passphrase: string, randomBytes: RandomBytes): Promise<string> {
  assertVaultId(vaultId);
  if (!(vmk instanceof Uint8Array) || vmk.byteLength !== VMK_BYTES) throw new TypeError('Vault Master Key must be exactly 32 bytes');
  assertPassphrase(passphrase);
  const salt = await randomBytes(SALT_BYTES);
  const nonce = await randomBytes(NONCE_BYTES);
  if (!(salt instanceof Uint8Array) || salt.byteLength !== SALT_BYTES || !(nonce instanceof Uint8Array) || nonce.byteLength !== NONCE_BYTES) {
    throw new Error('Secure random source returned an invalid value');
  }
  const kit: RecoveryKit = {
    format: FORMAT,
    version: VERSION,
    vaultId,
    kdf: KDF,
    iterations: ITERATIONS,
    cipher: CIPHER,
    salt: encodeBase64Url(salt),
    nonce: encodeBase64Url(nonce),
    ciphertext: '',
  };
  const key = await recoveryKey(passphrase, salt);
  try {
    kit.ciphertext = encodeBase64Url(gcm(key, nonce, aad(kit)).encrypt(vmk));
    return JSON.stringify(kit);
  } finally {
    key.fill(0);
  }
}

/** Parses, bounds, authenticates, and decrypts a portable recovery kit. */
export async function importRecoveryKit(serialized: string, expectedVaultId: string, passphrase: string): Promise<Uint8Array> {
  assertVaultId(expectedVaultId);
  assertPassphrase(passphrase);
  if (typeof serialized !== 'string' || serialized.length > 4096) throw new TypeError('Recovery kit is malformed or too large');
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new TypeError('Recovery kit is not valid JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Recovery kit must be a JSON object');
  const kit = value as Partial<RecoveryKit>;
  const expectedKeys = ['format', 'version', 'vaultId', 'kdf', 'iterations', 'cipher', 'salt', 'nonce', 'ciphertext'].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) throw new TypeError('Recovery kit has missing or unknown fields');
  if (kit.format !== FORMAT || kit.version !== VERSION || kit.kdf !== KDF || kit.iterations !== ITERATIONS || kit.cipher !== CIPHER) {
    throw new TypeError('Unsupported recovery kit format or cryptographic parameters');
  }
  if (kit.vaultId !== expectedVaultId) throw new Error('This recovery kit belongs to a different Vault');
  if (typeof kit.salt !== 'string' || typeof kit.nonce !== 'string' || typeof kit.ciphertext !== 'string') throw new TypeError('Recovery kit fields must be strings');
  const salt = decodeBase64Url(kit.salt, 'salt');
  const nonce = decodeBase64Url(kit.nonce, 'nonce');
  const ciphertext = decodeBase64Url(kit.ciphertext, 'ciphertext');
  if (salt.byteLength !== SALT_BYTES || nonce.byteLength !== NONCE_BYTES || ciphertext.byteLength !== VMK_BYTES + 16) {
    throw new TypeError('Recovery kit contains invalid cryptographic lengths');
  }
  const key = await recoveryKey(passphrase, salt);
  try {
    const vmk = gcm(key, nonce, aad(kit as Pick<RecoveryKit, 'vaultId' | 'iterations' | 'salt'>)).decrypt(ciphertext);
    if (vmk.byteLength !== VMK_BYTES) throw new Error('Recovery kit did not contain a valid Vault key');
    return vmk;
  } finally {
    key.fill(0);
  }
}
