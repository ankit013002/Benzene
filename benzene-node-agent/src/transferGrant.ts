import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Verifies the control plane's authorisation to move one object.
 *
 * The control plane holds the signing half; this device received the public key
 * at enrollment. A grant names one object, one device, one operation and an
 * expiry, so a leaked grant exposes a single object for a few minutes rather
 * than the whole store for the life of the process.
 *
 * The encoding is pinned by shared test vectors, the same way request signing
 * is: the two packages are separate deployables and must not drift.
 */

export const GRANT_VERSION = 2;

export type TransferOperation = "put" | "get" | "delete";
export type TransferEncryption = "none" | "benzene-encrypted-object-v1";

export interface TransferGrantPayload {
  v: 1 | 2;
  objectHash: string;
  deviceId: string;
  op: TransferOperation;
  exp: number;
  size?: number;
  encryption?: TransferEncryption;
}

export type GrantRejection =
  | "malformed"
  | "bad_signature"
  | "unsupported_version"
  | "expired"
  | "wrong_device"
  | "wrong_object"
  | "wrong_operation";

export type GrantVerification =
  | { ok: true; payload: TransferGrantPayload }
  | { ok: false; reason: GrantRejection };

function fromBase64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Checks a grant against what is actually being asked for.
 *
 * The expected object, device and operation are supplied by the caller rather
 * than trusted from the grant, so a valid grant for one object cannot be
 * replayed to fetch another.
 */
export function verifyTransferGrant(input: {
  grant: string;
  controlPlanePublicKey: string;
  expected: {
    objectHash: string;
    deviceId: string;
    op: TransferOperation;
  };
  now?: number;
}): GrantVerification {
  const parts = input.grant.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed" };
  }
  const [encoded, signature] = parts as [string, string];

  let verified = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(input.controlPlanePublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    verified = cryptoVerify(
      null,
      Buffer.from(encoded, "utf8"),
      publicKey,
      fromBase64url(signature)
    );
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  // Signature first: never parse a payload that has not been authenticated.
  if (!verified) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(encoded).toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed" };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw["v"] !== 1 && raw["v"] !== GRANT_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  const v = raw["v"];
  const op = raw["op"];
  if (op !== "put" && op !== "get" && op !== "delete") {
    return { ok: false, reason: "malformed" };
  }
  const fields = Object.keys(raw).sort();
  const baseFields = ["deviceId", "exp", "objectHash", "op", "v"];
  const expectedFields = v === 1
    ? [...baseFields, ...(raw["size"] !== undefined ? ["size"] : [])]
    : op === "put"
      ? [...baseFields, "encryption", ...(raw["size"] !== undefined ? ["size"] : [])]
      : op === "get"
        ? [...baseFields, "encryption"]
        : baseFields;
  if (fields.length !== expectedFields.length
    || fields.some((field, index) => field !== expectedFields.slice().sort()[index])) {
    return { ok: false, reason: "malformed" };
  }
  if (v === 1 && raw["encryption"] !== undefined) {
    return { ok: false, reason: "malformed" };
  }
  // A legacy read can be treated as plaintext for compatibility, but a v1
  // write has no authenticated format marker and could mislabel ciphertext.
  if (v === 1 && op === "put") return { ok: false, reason: "unsupported_version" };
  if (v === GRANT_VERSION && op === "put" && raw["size"] === undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (raw["op"] === "put" || raw["op"] === "get") {
    if (v === GRANT_VERSION && raw["encryption"] !== "none"
      && raw["encryption"] !== "benzene-encrypted-object-v1") {
      return { ok: false, reason: "malformed" };
    }
  } else if (raw["encryption"] !== undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (raw["size"] !== undefined && (!Number.isSafeInteger(raw["size"]) || (raw["size"] as number) < 0)) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw["deviceId"] !== "string" || typeof raw["objectHash"] !== "string"
    || !Number.isSafeInteger(raw["exp"])) return { ok: false, reason: "malformed" };
  const payload: TransferGrantPayload = {
    v,
    objectHash: raw["objectHash"],
    deviceId: raw["deviceId"],
    op,
    exp: raw["exp"] as number,
    ...(raw["size"] !== undefined ? { size: raw["size"] as number } : {}),
    ...((raw["op"] === "put" || raw["op"] === "get")
      ? { encryption: v === 1 ? "none" : raw["encryption"] as TransferEncryption }
      : {}),
  };
  if (typeof payload.exp !== "number" || (input.now ?? Date.now()) / 1000 > payload.exp) {
    return { ok: false, reason: "expired" };
  }
  if (payload.deviceId !== input.expected.deviceId) {
    return { ok: false, reason: "wrong_device" };
  }
  if (payload.objectHash !== input.expected.objectHash) {
    return { ok: false, reason: "wrong_object" };
  }
  if (payload.op !== input.expected.op) {
    return { ok: false, reason: "wrong_operation" };
  }

  return { ok: true, payload };
}
