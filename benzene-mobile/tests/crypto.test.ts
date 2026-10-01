import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decryptObject, encryptObjectWithRandomValues, type EncryptedObjectMetadata } from '../src/crypto/encryptedObjectCore';
import { decodeBase64Url, encodeBase64Url, hexToBytes } from '../src/crypto/bytes';
import { exportRecoveryKitWithRandomValues, importRecoveryKit } from '../src/crypto/recoveryKit';
import { createVaultKeyStore } from '../src/crypto/vaultKeysCore';

type Vector = {
  vaultMasterKeyHex: string;
  objectKeyHex: string;
  plaintextBase64Url: string;
  vaultId: string;
  objectId: string;
  storageHash: string;
  ciphertextBase64Url: string;
  metadata: EncryptedObjectMetadata;
};

const vector = JSON.parse(readFileSync('../contracts/encrypted-object-v1/vectors.json', 'utf8')) as Vector;
const vmk = hexToBytes(vector.vaultMasterKeyHex, 'VMK');
const objectKey = hexToBytes(vector.objectKeyHex, 'object key');
const plaintext = decodeBase64Url(vector.plaintextBase64Url, 'plaintext');

test('mobile AES-GCM and HKDF produce the shared encrypted-object v1 vector byte for byte', async () => {
  const material = [objectKey, decodeBase64Url(vector.metadata.payloadNonce, 'payloadNonce'), decodeBase64Url(vector.metadata.wrappedKeyNonce, 'wrappedKeyNonce')];
  let index = 0;
  const encrypted = await encryptObjectWithRandomValues(plaintext, vmk, vector.vaultId, async (length) => {
    const next = material[index++];
    assert.ok(next);
    assert.equal(next.byteLength, length);
    return next;
  });
  assert.deepEqual(encrypted.metadata, vector.metadata);
  assert.equal(encodeBase64Url(encrypted.ciphertext), vector.ciphertextBase64Url);
  assert.deepEqual(decryptObject(vector.metadata, decodeBase64Url(vector.ciphertextBase64Url, 'ciphertext'), vmk), plaintext);
});

test('decryption fails closed on altered metadata, ciphertext, or the wrong VMK', () => {
  const ciphertext = decodeBase64Url(vector.ciphertextBase64Url, 'ciphertext');
  const changed = ciphertext.slice();
  changed[0] = (changed[0] ?? 0) ^ 1;
  assert.throws(() => decryptObject(vector.metadata, changed, vmk), /storageHash/);
  assert.throws(() => decryptObject({ ...vector.metadata, vaultId: 'another-vault' }, ciphertext, vmk), /storageHash|invalid tag/i);
  assert.throws(() => decryptObject(vector.metadata, ciphertext, new Uint8Array(32).fill(9)), /invalid tag/i);
  assert.throws(() => decryptObject({ ...vector.metadata, extra: 'not allowed' } as EncryptedObjectMetadata, ciphertext, vmk), /unknown fields/);
});

test('recovery kit round-trips independently of account passwords and rejects tampering', async () => {
  const passphrase = 'correct horse battery staple';
  let counter = 0;
  const kit = await exportRecoveryKitWithRandomValues(vector.vaultId, vmk, passphrase, async (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (counter++ + index) & 0xff;
    return bytes;
  });
  assert.deepEqual(await importRecoveryKit(kit, vector.vaultId, passphrase), vmk);
  await assert.rejects(importRecoveryKit(kit, vector.vaultId, 'a different sufficiently long passphrase'), /invalid tag/i);
  await assert.rejects(importRecoveryKit(kit, 'other-vault', passphrase), /different Vault/);
  const tampered: unknown = JSON.parse(kit);
  assert.ok(tampered !== null && typeof tampered === 'object');
  const priorCiphertext = String((tampered as Record<string, unknown>).ciphertext);
  const replacement = priorCiphertext.endsWith('A') ? 'B' : 'A';
  const damaged = { ...(tampered as Record<string, unknown>), ciphertext: `${priorCiphertext.slice(0, -1)}${replacement}` };
  await assert.rejects(importRecoveryKit(JSON.stringify(damaged), vector.vaultId, passphrase), /invalid tag/i);
  await assert.rejects(exportRecoveryKitWithRandomValues(vector.vaultId, vmk, 'short', async (length) => new Uint8Array(length)), /at least 16 characters/);
});

test('base64url decoding requires canonical unpadded input', () => {
  assert.deepEqual(decodeBase64Url('AQID', 'sample'), new Uint8Array([1, 2, 3]));
  assert.throws(() => decodeBase64Url('AQID=', 'sample'), /canonical/);
  assert.throws(() => decodeBase64Url('AB', 'sample'), /canonical/);
});

test('Vault Master Keys are generated once and persist only as an opaque SecureStore value', async () => {
  const entries = new Map<string, string>();
  const storage = {
    async getItem(key: string) { return entries.get(key) ?? null; },
    async setItem(key: string, value: string) { entries.set(key, value); },
    async deleteItem(key: string) { entries.delete(key); },
  };
  let generations = 0;
  const keyStore = createVaultKeyStore(storage, async (length) => {
    generations += 1;
    return new Uint8Array(length).fill(17);
  });
  const [first, concurrent] = await Promise.all([
    keyStore.getOrCreateVaultMasterKey('vault-1'),
    keyStore.getOrCreateVaultMasterKey('vault-1'),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(generations, 1);
  assert.equal(entries.get('benzene.vmk.v1.vault-1'), encodeBase64Url(first));
  assert.deepEqual(await keyStore.loadVaultMasterKey('vault-1'), first);
  await keyStore.markRecoveryAcknowledged('vault-1');
  assert.equal(await keyStore.recoveryAcknowledged('vault-1'), true);
  await keyStore.deleteVaultMasterKey('vault-1');
  assert.equal(await keyStore.loadVaultMasterKey('vault-1'), null);
  assert.equal(await keyStore.recoveryAcknowledged('vault-1'), false);
  await keyStore.markRecoveryAcknowledged('vault-1');
  const regenerated = await keyStore.getOrCreateVaultMasterKey('vault-1');
  assert.equal(regenerated.byteLength, 32);
  assert.equal(generations, 2);
  assert.equal(await keyStore.recoveryAcknowledged('vault-1'), false);
});

test('recovery import cannot replace an existing different Vault key', async () => {
  const entries = new Map<string, string>();
  const storage = {
    async getItem(key: string) { return entries.get(key) ?? null; },
    async setItem(key: string, value: string) { entries.set(key, value); },
    async deleteItem(key: string) { entries.delete(key); },
  };
  const keyStore = createVaultKeyStore(storage, async (length) => new Uint8Array(length));
  const current = vmk.slice();
  const other = new Uint8Array(32).fill(9);
  await keyStore.importVaultMasterKey('vault-3', current);
  await keyStore.markRecoveryAcknowledged('vault-3');

  await assert.rejects(keyStore.importVaultMasterKey('vault-3', other), /different key.*not replaced/);
  assert.deepEqual(await keyStore.loadVaultMasterKey('vault-3'), current);
  assert.equal(await keyStore.recoveryAcknowledged('vault-3'), true);
});

test('concurrent recovery imports serialize and preserve the first valid Vault key', async () => {
  const entries = new Map<string, string>();
  const storage = {
    async getItem(key: string) { return entries.get(key) ?? null; },
    async setItem(key: string, value: string) { entries.set(key, value); },
    async deleteItem(key: string) { entries.delete(key); },
  };
  const keyStore = createVaultKeyStore(storage, async (length) => new Uint8Array(length));
  const first = vmk.slice();
  const second = new Uint8Array(32).fill(9);

  const results = await Promise.allSettled([
    keyStore.importVaultMasterKey('vault-5', first),
    keyStore.importVaultMasterKey('vault-5', second),
  ]);

  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'rejected');
  if (results[1]?.status === 'rejected') assert.match(String(results[1].reason), /different key.*not replaced/);
  assert.deepEqual(await keyStore.loadVaultMasterKey('vault-5'), first);
});

test('failed Vault key writes clear prior recovery confirmation first', async () => {
  const entries = new Map<string, string>([
    ['benzene.vmk.recovery-ack.v1.vault-4', 'confirmed'],
  ]);
  const storage = {
    async getItem(key: string) { return entries.get(key) ?? null; },
    async setItem(key: string, value: string) {
      if (key === 'benzene.vmk.v1.vault-4') throw new Error('secure storage unavailable');
      entries.set(key, value);
    },
    async deleteItem(key: string) { entries.delete(key); },
  };
  const keyStore = createVaultKeyStore(storage, async (length) => new Uint8Array(length));

  await assert.rejects(keyStore.importVaultMasterKey('vault-4', vmk), /secure storage unavailable/);
  assert.equal(entries.has('benzene.vmk.v1.vault-4'), false);
  assert.equal(await keyStore.recoveryAcknowledged('vault-4'), false);
});

test('damaged Vault keys preserve bytes but invalidate recovery confirmation until explicit import', async () => {
  const entries = new Map<string, string>([
    ['benzene.vmk.v1.vault-2', 'not-canonical='],
    ['benzene.vmk.recovery-ack.v1.vault-2', 'confirmed'],
  ]);
  const storage = {
    async getItem(key: string) { return entries.get(key) ?? null; },
    async setItem(key: string, value: string) { entries.set(key, value); },
    async deleteItem(key: string) { entries.delete(key); },
  };
  const keyStore = createVaultKeyStore(storage, async (length) => new Uint8Array(length));
  await assert.rejects(keyStore.loadVaultMasterKey('vault-2'), /damaged/);
  assert.equal(entries.get('benzene.vmk.v1.vault-2'), 'not-canonical=');
  assert.equal(await keyStore.recoveryAcknowledged('vault-2'), false);
  await keyStore.importVaultMasterKey('vault-2', vmk);
  assert.equal(entries.get('benzene.vmk.v1.vault-2'), encodeBase64Url(vmk));
  assert.deepEqual(await keyStore.loadVaultMasterKey('vault-2'), vmk);
  assert.throws(() => keyStore.importVaultMasterKey('vault-2', new Uint8Array(31)), /exactly 32 bytes/);
});
