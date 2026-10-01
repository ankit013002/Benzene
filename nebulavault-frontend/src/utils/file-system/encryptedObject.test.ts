import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decryptObject, encryptObjectWithRandomValues, type RandomBytes } from "./encryptedObject";

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
