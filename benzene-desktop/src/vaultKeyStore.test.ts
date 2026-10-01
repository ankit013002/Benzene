import assert from "node:assert/strict";
import test from "node:test";

import {
  canUseSafeStorage,
  decryptVaultKeyRecord,
  encryptVaultKeyRecord,
  encryptedKeyFilename,
  isTrustedVaultRequest,
  parseVaultKey,
  saveVaultKeySafely,
  serializeVaultKey,
  CorruptStoredVaultKeyError,
  VaultKeyScopeMismatchError,
  validateVaultKeyHex,
} from "./vaultKeyStore.js";

const vaultId = "vault-123";
const keyHex = "ab".repeat(32);
const appOrigin = "https://vault.example";

test("binds the encrypted payload and filename to both the app origin and Vault", () => {
  const serialized = serializeVaultKey(appOrigin, vaultId, keyHex);
  assert.equal(parseVaultKey(serialized, appOrigin, vaultId), keyHex);
  assert.throws(() => parseVaultKey(serialized, appOrigin, "another-vault"), VaultKeyScopeMismatchError);
  assert.throws(() => parseVaultKey(serialized, "https://attacker.example", vaultId), VaultKeyScopeMismatchError);
  assert.equal(encryptedKeyFilename(appOrigin, vaultId).length, 68);
  assert.notEqual(encryptedKeyFilename(appOrigin, vaultId), encryptedKeyFilename(appOrigin, "another-vault"));
  assert.notEqual(encryptedKeyFilename(appOrigin, vaultId), encryptedKeyFilename("https://attacker.example", vaultId));
});

test("persists only bytes returned by the OS encryption provider", () => {
  const encrypt = (plaintext: string): Buffer => Buffer.from([...Buffer.from(plaintext)].map((byte) => byte ^ 0xa5));
  const decrypt = (ciphertext: Buffer): string => Buffer.from([...ciphertext].map((byte) => byte ^ 0xa5)).toString();
  const stored = encryptVaultKeyRecord(appOrigin, vaultId, keyHex, encrypt);
  assert.equal(stored.includes(keyHex), false);
  assert.equal(decryptVaultKeyRecord(stored, appOrigin, vaultId, decrypt), keyHex);
  assert.throws(() => decryptVaultKeyRecord(keyHex, appOrigin, vaultId, decrypt));
});

test("a recovery import repairs corrupt storage but never replaces a different valid key", async () => {
  let stored = "corrupt";
  let replacements = 0;
  const operations = {
    async load() {
      if (stored === "corrupt") throw new CorruptStoredVaultKeyError();
      return stored;
    },
    async writeNew() { stored = keyHex; },
    async replaceCorrupt() { replacements += 1; stored = keyHex; },
  };
  assert.equal(await saveVaultKeySafely(keyHex, operations), "repaired");
  assert.equal(replacements, 1);
  assert.equal(stored, keyHex);
  await assert.rejects(saveVaultKeySafely("cd".repeat(32), operations), /different key is already saved/);
  assert.equal(replacements, 1);
  assert.equal(stored, keyHex);
  await assert.rejects(saveVaultKeySafely(keyHex, {
    async load() { throw new VaultKeyScopeMismatchError(); },
    async writeNew() { assert.fail("scope mismatch must not create a replacement record"); },
    async replaceCorrupt() { assert.fail("scope mismatch is not corruption"); },
  }), VaultKeyScopeMismatchError);
});

test("rejects malformed or unsafe vault keys and identifiers", () => {
  assert.throws(() => validateVaultKeyHex("not-a-key"), /exactly 32 bytes/);
  assert.throws(() => serializeVaultKey(appOrigin, "bad\u0000vault", keyHex), /Vault identifier/);
});

test("requires a real OS credential backend for persistent key storage", () => {
  assert.equal(canUseSafeStorage({ available: true }, "darwin"), true);
  assert.equal(canUseSafeStorage({ available: true }, "win32"), true);
  assert.equal(canUseSafeStorage({ available: true, backend: "gnome_libsecret" }, "linux"), true);
  assert.equal(canUseSafeStorage({ available: true, backend: "basic_text" }, "linux"), false);
  assert.equal(canUseSafeStorage({ available: false, backend: "kwallet6" }, "linux"), false);
});

test("accepts key IPC only from the configured top-level Vault origin", () => {
  assert.equal(isTrustedVaultRequest(7, 7, "https://vault.example/files", true, "https://vault.example"), true);
  assert.equal(isTrustedVaultRequest(7, 8, "https://vault.example/files", true, "https://vault.example"), false);
  assert.equal(isTrustedVaultRequest(7, 7, "https://attacker.example/files", true, "https://vault.example"), false);
  assert.equal(isTrustedVaultRequest(7, 7, "https://vault.example.evil/files", true, "https://vault.example"), false);
  assert.equal(isTrustedVaultRequest(7, 7, "https://vault.example/frame", false, "https://vault.example"), false);
  assert.equal(isTrustedVaultRequest(7, 7, "file:///tmp/app.html", true, "https://vault.example"), false);
});
