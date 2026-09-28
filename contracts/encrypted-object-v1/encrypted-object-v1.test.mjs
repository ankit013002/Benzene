import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decryptObject, encryptObject } from './encrypted-object-v1.mjs';

const vector = JSON.parse(await readFile(new URL('./vectors.json', import.meta.url), 'utf8'));
const fromHex = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));
const fromB64Url = (value) => new Uint8Array(Buffer.from(value, 'base64url'));
const toB64Url = (value) => Buffer.from(value).toString('base64url');
const vectorCiphertext = fromB64Url(vector.ciphertextBase64Url);

test('opens the deterministic v1 cross-implementation vector', async () => {
  const plaintext = await decryptObject(vector.metadata, vectorCiphertext, fromHex(vector.vaultMasterKeyHex));
  assert.equal(toB64Url(plaintext), vector.plaintextBase64Url);
  assert.equal(createHash('sha256').update(plaintext).digest('hex'), vector.objectId);
  assert.equal(vector.metadata.storageHash, vector.storageHash);
  assert.equal(createHash('sha256').update(vectorCiphertext).digest('hex'), vector.storageHash);
  assert.equal(Object.hasOwn(vector.metadata, 'payloadCiphertext'), false);
});

test('matches the vector when independently applying the specified WebCrypto operations', async () => {
  const plaintext = fromB64Url(vector.plaintextBase64Url);
  const objectKeyBytes = fromHex(vector.objectKeyHex);
  const vaultId = vector.vaultId;
  const objectId = createHash('sha256').update(plaintext).digest('hex');
  assert.equal(objectId, vector.objectId);

  const encoder = new TextEncoder();
  const vmk = await webcrypto.subtle.importKey('raw', fromHex(vector.vaultMasterKeyHex), 'HKDF', false, ['deriveKey']);
  const wrappingKey = await webcrypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(`benzene/v1/vault/${vaultId}`),
    info: encoder.encode(`benzene/v1/object-key-wrap/${objectId}`),
  }, vmk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const payloadKey = await webcrypto.subtle.importKey('raw', objectKeyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const payloadNonce = fromB64Url(vector.metadata.payloadNonce);
  const wrappedKeyNonce = fromB64Url(vector.metadata.wrappedKeyNonce);
  const payloadCiphertext = await webcrypto.subtle.encrypt({
    name: 'AES-GCM', iv: payloadNonce,
    additionalData: encoder.encode(`benzene/encrypted-object/v1\n${vaultId}\n${objectId}\n${plaintext.byteLength}`),
    tagLength: 128,
  }, payloadKey, plaintext);
  const wrappedKeyCiphertext = await webcrypto.subtle.encrypt({
    name: 'AES-GCM', iv: wrappedKeyNonce,
    additionalData: encoder.encode(`benzene/object-key-wrap/v1\n${vaultId}\n${objectId}`),
    tagLength: 128,
  }, wrappingKey, objectKeyBytes);

  assert.equal(toB64Url(payloadCiphertext), vector.ciphertextBase64Url);
  assert.equal(toB64Url(wrappedKeyCiphertext), vector.metadata.wrappedKeyCiphertext);
  assert.equal(createHash('sha256').update(new Uint8Array(payloadCiphertext)).digest('hex'), vector.storageHash);
});

test('encrypts and decrypts empty and non-empty whole objects', async () => {
  const vmk = fromHex(vector.vaultMasterKeyHex);
  for (const plaintext of [new Uint8Array(), new TextEncoder().encode('replica bytes')]) {
    const encrypted = await encryptObject(plaintext, vmk, 'vault_01');
    assert.equal(Object.hasOwn(encrypted.metadata, 'ciphertext'), false);
    assert.equal(Object.hasOwn(encrypted.metadata, 'payloadCiphertext'), false);
    assert.deepEqual(await decryptObject(encrypted.metadata, encrypted.ciphertext, vmk), plaintext);
    assert.equal(encrypted.metadata.plaintextSize, plaintext.byteLength);
    assert.equal(encrypted.ciphertext.byteLength, plaintext.byteLength + 16);
  }
});

test('uses fresh data keys and nonces for repeated encryption', async () => {
  const plaintext = fromB64Url(vector.plaintextBase64Url);
  const vmk = fromHex(vector.vaultMasterKeyHex);
  const first = await encryptObject(plaintext, vmk, vector.vaultId);
  const second = await encryptObject(plaintext, vmk, vector.vaultId);
  assert.notEqual(first.metadata.payloadNonce, second.metadata.payloadNonce);
  assert.notEqual(first.metadata.wrappedKeyNonce, second.metadata.wrappedKeyNonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.metadata.storageHash, second.metadata.storageHash);
  assert.equal(first.metadata.storageHash, createHash('sha256').update(first.ciphertext).digest('hex'));
  assert.equal(second.metadata.storageHash, createHash('sha256').update(second.ciphertext).digest('hex'));
  assert.equal(first.metadata.objectId, second.metadata.objectId);
  assert.deepEqual(await decryptObject(first.metadata, first.ciphertext, vmk), plaintext);
  assert.deepEqual(await decryptObject(second.metadata, second.ciphertext, vmk), plaintext);
});

test('rejects wrong Vault Master Keys and authenticated-field or ciphertext changes', async () => {
  const vmk = fromHex(vector.vaultMasterKeyHex);
  const wrongKey = new Uint8Array(vmk);
  wrongKey[0] ^= 0xff;
  await assert.rejects(decryptObject(vector.metadata, vectorCiphertext, wrongKey));

  const tampered = [
    { ...vector.metadata, vaultId: 'other-vault' },
    { ...vector.metadata, objectId: '0'.repeat(64) },
    { ...vector.metadata, storageHash: '0'.repeat(64) },
    { ...vector.metadata, wrappedKeyCiphertext: `${vector.metadata.wrappedKeyCiphertext.slice(0, -1)}A` },
  ];
  for (const metadata of tampered) await assert.rejects(decryptObject(metadata, vectorCiphertext, vmk));
  const modifiedCiphertext = new Uint8Array(vectorCiphertext);
  modifiedCiphertext[0] ^= 0xff;
  await assert.rejects(decryptObject(vector.metadata, modifiedCiphertext, vmk), /storageHash/);
  await assert.rejects(
    decryptObject({ ...vector.metadata, plaintextSize: vector.metadata.plaintextSize + 1 }, vectorCiphertext, vmk),
    /payload length must equal plaintextSize/,
  );
});

test('rejects malformed metadata and noncanonical encodings before decrypting', async () => {
  const vmk = fromHex(vector.vaultMasterKeyHex);
  await assert.rejects(decryptObject({ ...vector.metadata, extra: true }, vectorCiphertext, vmk), /missing or unknown fields/);
  await assert.rejects(decryptObject({ ...vector.metadata, payloadNonce: '***' }, vectorCiphertext, vmk), /base64url/);
  await assert.rejects(decryptObject({ ...vector.metadata, wrappedKeyNonce: 'AA' }, vectorCiphertext, vmk), /12 bytes/);
  await assert.rejects(decryptObject({ ...vector.metadata, version: 2 }, vectorCiphertext, vmk), /Unsupported/);
  await assert.rejects(decryptObject(vector.metadata, new Uint8Array(1), vmk), /payload length must equal plaintextSize/);
  await assert.rejects(encryptObject(new Uint8Array(), new Uint8Array(31), 'vault'), /exactly 32 bytes/);
  await assert.rejects(encryptObject(new Uint8Array(), vmk, 'vault\nother'), /vaultId/);
});
