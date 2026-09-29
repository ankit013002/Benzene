import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GRANT_TEST_PRIVATE_KEY, GRANT_TEST_PUBLIC_KEY, GRANT_VECTORS } from "./grantVectors.js";
import {
  generateTransferSigningKeys,
  issueTransferGrant,
  publicKeyFor,
} from "./transferGrant.js";

function decode(grant: string): Record<string, unknown> {
  const encoded = grant.split(".")[0] ?? "";
  const json = Buffer.from(
    encoded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

function signatureVerifies(grant: string, publicKeyB64: string): boolean {
  const [encoded, signature] = grant.split(".") as [string, string];
  return cryptoVerify(
    null,
    Buffer.from(encoded, "utf8"),
    createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    }),
    Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  );
}

describe("grant contract", () => {
  // The node agent asserts against this same vector file. These two suites are
  // the contract: this proves the control plane emits exactly these bytes.
  it.each(GRANT_VECTORS)("emits the agreed grant for $payload.op", (vector) => {
    const { v, ...rest } = vector.payload;
    expect(v).toBe(2);

    expect(issueTransferGrant(GRANT_TEST_PRIVATE_KEY, rest)).toBe(vector.grant);
  });

  it.each(GRANT_VECTORS)("emits a grant that verifies for $payload.op", (vector) => {
    expect(signatureVerifies(vector.grant, GRANT_TEST_PUBLIC_KEY)).toBe(true);
  });
});

describe("issuing", () => {
  const keys = generateTransferSigningKeys();

  it("scopes a grant to one object, device and operation", () => {
    const grant = issueTransferGrant(keys.privateKey, {
      objectHash: "a".repeat(64),
      deviceId: "device-1",
      op: "put",
      exp: 4_102_444_800,
      size: 99,
      encryption: "none",
    });

    expect(decode(grant)).toEqual({
      v: 2,
      objectHash: "a".repeat(64),
      deviceId: "device-1",
      op: "put",
      exp: 4_102_444_800,
      size: 99,
      encryption: "none",
    });
  });

  it("produces a signature that verifies against the matching public key", () => {
    const grant = issueTransferGrant(keys.privateKey, {
      objectHash: "b".repeat(64),
      deviceId: "device-2",
      op: "get",
      exp: 4_102_444_800,
      encryption: "benzene-encrypted-object-v1",
    });

    expect(signatureVerifies(grant, keys.publicKey)).toBe(true);
  });

  it("does not verify against a different key", () => {
    const other = generateTransferSigningKeys();
    const grant = issueTransferGrant(keys.privateKey, {
      objectHash: "c".repeat(64),
      deviceId: "device-3",
      op: "get",
      exp: 4_102_444_800,
    });

    expect(signatureVerifies(grant, other.publicKey)).toBe(false);
  });

  // Grants differ per object, so one can never stand in for another.
  it("issues distinct grants for distinct objects", () => {
    const base = { deviceId: "d", op: "get" as const, exp: 4_102_444_800 };
    expect(
      issueTransferGrant(keys.privateKey, { ...base, objectHash: "a".repeat(64) })
    ).not.toBe(
      issueTransferGrant(keys.privateKey, { ...base, objectHash: "b".repeat(64) })
    );
  });

  it("emits url-safe base64 with no padding", () => {
    const grant = issueTransferGrant(keys.privateKey, {
      objectHash: "d".repeat(64),
      deviceId: "device-4",
      op: "delete",
      exp: 4_102_444_800,
    });

    expect(grant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("public key derivation", () => {
  it("derives the public half from the private key", () => {
    const keys = generateTransferSigningKeys();

    expect(publicKeyFor(keys.privateKey)).toBe(keys.publicKey);
  });

  it("matches the fixture's public key", () => {
    expect(publicKeyFor(GRANT_TEST_PRIVATE_KEY)).toBe(GRANT_TEST_PUBLIC_KEY);
  });

  it("refuses a key that is not Ed25519", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

    expect(() => publicKeyFor(pkcs8)).toThrow(/Ed25519/);
  });
});
