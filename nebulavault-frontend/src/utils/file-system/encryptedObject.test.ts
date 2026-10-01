import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  decryptObject,
  exportRecoveryKitWithRandomValues,
  encryptObjectWithRandomValues,
  importRecoveryKit,
  type RandomBytes,
} from "./encryptedObject";

interface Vector {
  vaultMasterKeyHex: string;
  objectKeyHex: string;
  vaultId: string;
  objectId: string;
  storageHash: string;
  plaintextBase64Url: string;
  ciphertextBase64Url: string;
  metadata: Parameters<typeof decryptObject>[0];
}

const vector = JSON.parse(readFileSync(new URL("../../../../contracts/encrypted-object-v1/vectors.json", import.meta.url), "utf8")) as Vector;
const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const fromBase64Url = (encoded: string) => Uint8Array.from(Buffer.from(encoded, "base64url"));

test("browser AES-GCM and HKDF match the shared encrypted-object v1 contract vector", async () => {
  const randomValues = [vector.objectKeyHex, "404142434445464748494a4b", "4c4d4e4f5051525354555657"].map(fromHex);
  const randomBytes: RandomBytes = (length) => {
    const next = randomValues.shift();
    assert.ok(next);
    assert.equal(next.byteLength, length);
    return next;
  };
  const plaintext = fromBase64Url(vector.plaintextBase64Url);
  const encrypted = await encryptObjectWithRandomValues(plaintext, fromHex(vector.vaultMasterKeyHex), vector.vaultId, randomBytes);

  assert.deepEqual(encrypted.ciphertext, fromBase64Url(vector.ciphertextBase64Url));
  assert.deepEqual(encrypted.metadata, vector.metadata);
  assert.equal(encrypted.metadata.objectId, vector.objectId);
  assert.equal(encrypted.metadata.storageHash, vector.storageHash);
  assert.deepEqual(await decryptObject(encrypted.metadata, encrypted.ciphertext, fromHex(vector.vaultMasterKeyHex)), plaintext);
});

test("browser decryption rejects changed ciphertext and a wrong Vault key", async () => {
  const randomValues = [vector.objectKeyHex, "404142434445464748494a4b", "4c4d4e4f5051525354555657"].map(fromHex);
  const encrypted = await encryptObjectWithRandomValues(
    fromBase64Url(vector.plaintextBase64Url),
    fromHex(vector.vaultMasterKeyHex),
    vector.vaultId,
    (length) => {
      const next = randomValues.shift();
      assert.ok(next);
      assert.equal(next.byteLength, length);
      return next;
    },
  );
  const changed = encrypted.ciphertext.slice();
  changed[0] = (changed[0] ?? 0) ^ 1;
  await assert.rejects(decryptObject(encrypted.metadata, changed, fromHex(vector.vaultMasterKeyHex)), /storageHash/);
  await assert.rejects(decryptObject(encrypted.metadata, encrypted.ciphertext, new Uint8Array(32).fill(9)));
});

test("browser recovery-kit export matches the mobile v1 format and imports the exact key", async () => {
  const vmk = fromHex(vector.vaultMasterKeyHex);
  const randomValues = [Uint8Array.from({ length: 16 }, (_, index) => index), Uint8Array.from({ length: 12 }, (_, index) => index + 16)];
  const kit = await exportRecoveryKitWithRandomValues(vector.vaultId, vmk, "correct horse battery staple", (length) => {
    const next = randomValues.shift();
    assert.ok(next);
    assert.equal(next.byteLength, length);
    return next;
  });
  const record = JSON.parse(kit) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ["format", "version", "vaultId", "kdf", "iterations", "cipher", "salt", "nonce", "ciphertext"].sort());
  assert.equal(record.format, "benzene-vmk-recovery");
  assert.equal(record.kdf, "PBKDF2-HMAC-SHA-256");
  assert.equal(record.iterations, 600_000);
  assert.equal(record.cipher, "AES-256-GCM");
  assert.deepEqual(await importRecoveryKit(kit, vector.vaultId, "correct horse battery staple"), vmk);
  await assert.rejects(importRecoveryKit(kit, vector.vaultId, "wrong passphrase but long enough"));
});

test("browser recovery-kit export rejects weak passphrases and invalid randomness", async () => {
  await assert.rejects(exportRecoveryKitWithRandomValues(vector.vaultId, new Uint8Array(32), "too short", () => new Uint8Array(16)), /at least 16 characters/);
  await assert.rejects(exportRecoveryKitWithRandomValues(vector.vaultId, new Uint8Array(32), "correct horse battery staple", () => new Uint8Array(1)), /invalid value/);
});
