import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  encryptedObjectStorageBytes,
  encryptedObjectV1MetadataSchema,
} from "./encryptedObjectV1.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("encrypted object v1 metadata boundary", () => {
  it("keeps the plaintext identity separate from the ciphertext storage address", () => {
    const metadata = encryptedObjectV1MetadataSchema.parse({
      format: "benzene-encrypted-object",
      version: 1,
      payloadAlgorithm: "AES-256-GCM",
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
      vaultId: "vault_123",
      objectId: digest("plaintext"),
      storageHash: digest("ciphertext"),
      plaintextSize: 9,
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    });

    expect(metadata.objectId).not.toBe(metadata.storageHash);
    expect(encryptedObjectStorageBytes(metadata)).toBe(25);
  });

  it("rejects payload bytes and unknown fields at the metadata-only API boundary", () => {
    const result = encryptedObjectV1MetadataSchema.safeParse({
      format: "benzene-encrypted-object",
      version: 1,
      payloadAlgorithm: "AES-256-GCM",
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
      vaultId: "vault_123",
      objectId: digest("plaintext"),
      storageHash: digest("ciphertext"),
      plaintextSize: 9,
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
      ciphertext: "bytes must stay on the data plane",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsafe size overflow and malformed base64url at the API boundary", () => {
    const result = encryptedObjectV1MetadataSchema.safeParse({
      format: "benzene-encrypted-object",
      version: 1,
      payloadAlgorithm: "AES-256-GCM",
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
      vaultId: "vault_123",
      objectId: digest("plaintext"),
      storageHash: digest("ciphertext"),
      plaintextSize: Number.MAX_SAFE_INTEGER,
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    });
    expect(result.success).toBe(false);

    const malformedNonce = encryptedObjectV1MetadataSchema.safeParse({
      format: "benzene-encrypted-object",
      version: 1,
      payloadAlgorithm: "AES-256-GCM",
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
      vaultId: "vault_123",
      objectId: digest("plaintext"),
      storageHash: digest("ciphertext"),
      plaintextSize: 9,
      payloadNonce: "AAAAAAAAAAAAAAA=",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    });
    expect(malformedNonce.success).toBe(false);
  });
});
