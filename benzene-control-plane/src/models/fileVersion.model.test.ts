import { createHash } from "node:crypto";

import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import FileVersionModel from "./fileVersion.model.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function versionFields() {
  return {
    nodeId: new mongoose.Types.ObjectId(),
    ownerId: "owner",
    version: 1,
    bytes: 9,
    status: "pending" as const,
    uploadedBy: "owner",
    isCurrent: false,
  };
}

describe("FileVersion storage compatibility", () => {
  it("continues to accept legacy plaintext versions without an encryption marker", async () => {
    const legacy = new FileVersionModel({
      ...versionFields(),
      sha256: digest("plaintext"),
      objectHash: digest("plaintext"),
    });

    await expect(legacy.validate()).resolves.toBeUndefined();
    expect(legacy.storageFormat).toBeUndefined();
    expect(legacy.encryptedObject).toBeUndefined();
  });

  it("requires encrypted metadata and physical storage identity to agree", async () => {
    const storageHash = digest("ciphertext");
    const encrypted = new FileVersionModel({
      ...versionFields(),
      bytes: 9,
      storageBytes: 25,
      objectHash: storageHash,
      storageFormat: "benzene-encrypted-object-v1",
      encryptedObject: {
        format: "benzene-encrypted-object",
        version: 1,
        payloadAlgorithm: "AES-256-GCM",
        keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
        vaultId: "vault_123",
        objectId: digest("plaintext"),
        storageHash,
        plaintextSize: 9,
        payloadNonce: "AAAAAAAAAAAAAAAA",
        wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
        wrappedKeyCiphertext: "C".repeat(64),
      },
    });
    await expect(encrypted.validate()).resolves.toBeUndefined();

    encrypted.objectHash = digest("wrong physical address");
    await expect(encrypted.validate()).rejects.toThrow("physical storageHash");
  });

  it("rejects malformed encrypted metadata even for internal model writers", async () => {
    const storageHash = digest("ciphertext");
    const encrypted = new FileVersionModel({
      ...versionFields(),
      bytes: 9,
      storageBytes: 25,
      objectHash: storageHash,
      storageFormat: "benzene-encrypted-object-v1",
      encryptedObject: {
        format: "benzene-encrypted-object",
        version: 1,
        payloadAlgorithm: "AES-256-GCM",
        keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
        vaultId: "vault_123",
        objectId: digest("plaintext"),
        storageHash,
        plaintextSize: 9.5,
        payloadNonce: "too-short",
        wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
        wrappedKeyCiphertext: "C".repeat(64),
      },
    });

    await expect(encrypted.validate()).rejects.toThrow("encryptedObject");
  });
});
