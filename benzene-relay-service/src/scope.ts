import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export const RELAY_SCOPE_VERSION = 1;
export const MAX_RELAY_OBJECT_BYTES = 1024 * 1024 * 1024;
export const MAX_RELAY_TICKET_SECONDS = 5 * 60;
export const MAX_RELAY_TOKEN_CHARS = 8192;

export type RelayOperation = "get" | "put";
export type RelayRole = "node" | "client";

/** Signed capabilities contain physical encrypted-object identity only. */
export interface RelayScope {
  v: 1;
  sessionId: string;
  ticketId: string;
  storageHash: string;
  deviceId: string;
  op: RelayOperation;
  role: RelayRole;
  exp: number;
  maxBytes: number;
}

export type ScopeRejection =
  | "malformed"
  | "bad_signature"
  | "unsupported_version"
  | "invalid_scope"
  | "expired"
  | "lifetime_too_long";

export type ScopeVerification =
  | { ok: true; scope: RelayScope }
  | { ok: false; reason: ScopeRejection };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SCOPE_FIELDS = ["v", "sessionId", "ticketId", "storageHash", "deviceId", "op", "role", "exp", "maxBytes"];

function decodeBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function isCanonicalBase64url(value: string): boolean {
  return BASE64URL.test(value) && decodeBase64url(value).toString("base64url") === value;
}

export function validateRelayControlPlanePublicKey(encodedKey: string): void {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) throw new Error("invalid base64");
    const keyBytes = Buffer.from(encodedKey, "base64");
    if (keyBytes.toString("base64") !== encodedKey) throw new Error("non-canonical base64");
    const key = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("unexpected public key type");
    if (key.export({ format: "der", type: "spki" }).toString("base64") !== encodedKey) {
      throw new Error("non-canonical SPKI");
    }
  } catch {
    throw new Error("RELAY_CONTROL_PLANE_PUBLIC_KEY must be a canonical base64 DER SPKI Ed25519 public key");
  }
}

function isRelayScope(value: unknown): value is RelayScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  const fields = Object.keys(scope).sort();
  if (fields.length !== SCOPE_FIELDS.length || fields.some((field, index) => field !== SCOPE_FIELDS.slice().sort()[index])) {
    return false;
  }
  return scope.v === RELAY_SCOPE_VERSION
    && typeof scope.sessionId === "string" && UUID.test(scope.sessionId)
    && typeof scope.ticketId === "string" && UUID.test(scope.ticketId)
    && typeof scope.storageHash === "string" && HASH.test(scope.storageHash)
    && typeof scope.deviceId === "string" && UUID.test(scope.deviceId)
    && (scope.op === "get" || scope.op === "put")
    && (scope.role === "node" || scope.role === "client")
    && Number.isSafeInteger(scope.exp)
    && Number.isSafeInteger(scope.maxBytes)
    && (scope.maxBytes as number) > 0
    && (scope.maxBytes as number) <= MAX_RELAY_OBJECT_BYTES;
}

/** Ed25519 signatures are checked before payload decoding or JSON parsing. */
export function verifyRelayScope(input: {
  token: string;
  controlPlanePublicKey: string;
  now?: number;
}): ScopeVerification {
  if (input.token.length > MAX_RELAY_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const parts = input.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]
    || !isCanonicalBase64url(parts[0]) || !isCanonicalBase64url(parts[1])) {
    return { ok: false, reason: "malformed" };
  }
  const [encoded, encodedSignature] = parts as [string, string];

  let validSignature = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(input.controlPlanePublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    validSignature = cryptoVerify(null, Buffer.from(encoded, "utf8"), key, decodeBase64url(encodedSignature));
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!validSignature) return { ok: false, reason: "bad_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64url(encoded).toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)
    && (payload as Record<string, unknown>).v !== RELAY_SCOPE_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (!isRelayScope(payload)) return { ok: false, reason: "invalid_scope" };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (payload.exp > now + MAX_RELAY_TICKET_SECONDS) return { ok: false, reason: "lifetime_too_long" };
  return { ok: true, scope: payload };
}
