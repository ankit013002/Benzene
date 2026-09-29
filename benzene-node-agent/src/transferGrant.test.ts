import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GRANT_TEST_PRIVATE_KEY, GRANT_TEST_PUBLIC_KEY, GRANT_VECTORS } from "./grantVectors.js";
import { verifyTransferGrant } from "./transferGrant.js";

const FUTURE = 4_102_444_800; // 2100-01-01

function b64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints a grant the way the control plane does, for cases the vectors omit. */
function mint(
  payload: Record<string, unknown>,
  privateKeyB64 = GRANT_TEST_PRIVATE_KEY
): string {
  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(null, Buffer.from(encoded, "utf8"), {
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return `${encoded}.${b64url(signature)}`;
}

describe("grant contract", () => {
  // The control plane asserts against this same vector file.
  it.each(GRANT_VECTORS)("accepts the grant the control plane emits for $payload.op", (vector) => {
    const result = verifyTransferGrant({
      grant: vector.grant,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: {
        objectHash: vector.payload.objectHash,
        deviceId: vector.payload.deviceId,
        op: vector.payload.op,
      },
      now: 1_757_000_000_000,
    });

    expect(result).toEqual({ ok: true, payload: vector.payload });
  });
});

describe("scoping", () => {
  const base = {
    v: 2,
    objectHash: "a".repeat(64),
    deviceId: "device-1",
    op: "put" as const,
    exp: FUTURE,
    size: 1,
    encryption: "none" as const,
  };

  function verify(overrides: Partial<typeof base>, expected?: Partial<typeof base>) {
    return verifyTransferGrant({
      grant: mint({ ...base, ...overrides }),
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: {
        objectHash: expected?.objectHash ?? base.objectHash,
        deviceId: expected?.deviceId ?? base.deviceId,
        op: expected?.op ?? base.op,
      },
    });
  }

  it("accepts a grant that matches the request exactly", () => {
    expect(verify({})).toMatchObject({ ok: true });
  });

  // A grant for one object must not be usable to reach another — this is the
  // whole point of scoping, versus the shared token it replaced.
  it("refuses a grant issued for a different object", () => {
    expect(verify({ objectHash: "b".repeat(64) })).toEqual({
      ok: false,
      reason: "wrong_object",
    });
  });

  it("refuses a grant issued for a different device", () => {
    expect(verify({ deviceId: "someone-else" })).toEqual({
      ok: false,
      reason: "wrong_device",
    });
  });

  // A read grant must not authorise a write.
  it("refuses a grant issued for a different operation", () => {
    expect(verify({ op: "get", size: undefined }, { op: "put" })).toEqual({
      ok: false,
      reason: "wrong_operation",
    });
  });

  it("refuses an expired grant", () => {
    expect(verify({ exp: 1 })).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a grant with an unknown version", () => {
    expect(verify({ v: 99 })).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("accepts a legacy v1 plaintext GET only as encryption none", () => {
    const legacy = mint({ ...base, v: 1, op: "get", encryption: undefined });
    const result = verifyTransferGrant({
      grant: legacy,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: { objectHash: base.objectHash, deviceId: base.deviceId, op: "get" },
    });
    expect(result).toMatchObject({ ok: true, payload: { v: 1, encryption: "none" } });
  });

  it("rejects legacy v1 writes and any attempt to attach an encryption label", () => {
    const legacyPut = mint({ ...base, v: 1, encryption: undefined });
    expect(verifyTransferGrant({
      grant: legacyPut,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: { objectHash: base.objectHash, deviceId: base.deviceId, op: "put" },
    })).toEqual({ ok: false, reason: "unsupported_version" });
    const legacyEncrypted = mint({ ...base, v: 1, encryption: "benzene-encrypted-object-v1" });
    expect(verifyTransferGrant({
      grant: legacyEncrypted,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: { objectHash: base.objectHash, deviceId: base.deviceId, op: "put" },
    })).toEqual({ ok: false, reason: "malformed" });
  });

  it("requires an explicit storage format on v2 PUT and GET grants", () => {
    expect(verifyTransferGrant({
      grant: mint({ ...base, encryption: undefined }),
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: { objectHash: base.objectHash, deviceId: base.deviceId, op: "put" },
    })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTransferGrant({
      grant: mint({ ...base, op: "get", encryption: undefined }),
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: { objectHash: base.objectHash, deviceId: base.deviceId, op: "get" },
    })).toEqual({ ok: false, reason: "malformed" });
  });

  it("requires a signed size on v2 PUT grants", () => {
    expect(verifyTransferGrant({
      grant: mint({ ...base, size: undefined }),
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      expected: { objectHash: base.objectHash, deviceId: base.deviceId, op: "put" },
    })).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("forgery", () => {
  const payload = {
    v: 1,
    objectHash: "a".repeat(64),
    deviceId: "device-1",
    op: "put" as const,
    exp: FUTURE,
  };
  const expected = {
    objectHash: payload.objectHash,
    deviceId: payload.deviceId,
    op: payload.op,
  };

  it("refuses a grant signed by a different key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const foreign = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

    expect(
      verifyTransferGrant({
        grant: mint(payload, foreign),
        controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
        expected,
      })
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  // Editing the payload invalidates the signature over it.
  it("refuses a grant whose payload was edited after signing", () => {
    const [encoded, signature] = mint(payload).split(".") as [string, string];
    const tampered = b64url(
      Buffer.from(JSON.stringify({ ...payload, objectHash: "c".repeat(64) }), "utf8")
    );

    expect(
      verifyTransferGrant({
        grant: `${tampered}.${signature}`,
        controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
        expected: { ...expected, objectHash: "c".repeat(64) },
      })
    ).toEqual({ ok: false, reason: "bad_signature" });
    void encoded;
  });

  it.each([
    ["empty", ""],
    ["no separator", "abcdef"],
    ["too many parts", "a.b.c"],
    ["empty signature", "abc."],
  ])("refuses a %s grant", (_label, grant) => {
    expect(
      verifyTransferGrant({
        grant,
        controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
        expected,
      })
    ).toMatchObject({ ok: false });
  });

  it("refuses when the public key itself is malformed", () => {
    expect(
      verifyTransferGrant({
        grant: mint(payload),
        controlPlanePublicKey: "not-a-key",
        expected,
      })
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});
