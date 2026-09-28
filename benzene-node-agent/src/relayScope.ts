import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/** Relay scopes are a separate contract from device transfer grants. */
export const RELAY_SCOPE_VERSION = 1;
export const MAX_RELAY_OBJECT_BYTES = 1024 * 1024 * 1024;
export const MAX_RELAY_TICKET_SECONDS = 5 * 60;
const MAX_TOKEN_LENGTH = 8192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type RelayOperation = "get" | "put";
export type RelayRole = "node" | "client";

/**
 * A control-plane-signed, one-party capability. The node and client receive
 * separate tickets with the same session binding and opposite roles.
 */
export interface RelayScope {
  v: number;
  sessionId: string;
  ticketId: string;
  storageHash: string;
  deviceId: string;
  op: RelayOperation;
  role: RelayRole;
  exp: number;
  maxBytes: number;
}

export type RelayScopeRejection =
  | "malformed"
  | "bad_signature"
  | "unsupported_version"
  | "invalid_scope"
  | "expired"
  | "lifetime_too_long";

export type RelayScopeVerification =
  | { ok: true; scope: RelayScope }
  | { ok: false; reason: RelayScopeRejection };

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function isCanonicalBase64url(value: string): boolean {
  return BASE64URL_PATTERN.test(value) && fromBase64url(value).toString("base64url") === value;
}

function isRelayScope(value: unknown): value is RelayScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.v === RELAY_SCOPE_VERSION
    && typeof scope.sessionId === "string" && UUID_PATTERN.test(scope.sessionId)
    && typeof scope.ticketId === "string" && UUID_PATTERN.test(scope.ticketId)
    && typeof scope.storageHash === "string" && HASH_PATTERN.test(scope.storageHash)
    && typeof scope.deviceId === "string" && UUID_PATTERN.test(scope.deviceId)
    && (scope.op === "get" || scope.op === "put")
    && (scope.role === "node" || scope.role === "client")
    && Number.isSafeInteger(scope.exp)
    && Number.isSafeInteger(scope.maxBytes)
    && (scope.maxBytes as number) > 0
    && (scope.maxBytes as number) <= MAX_RELAY_OBJECT_BYTES;
}

/** Verify the signature before parsing any scope fields. */
export function verifyRelayScope(input: {
  token: string;
  controlPlanePublicKey: string;
  now?: number;
}): RelayScopeVerification {
  if (input.token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = input.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]
    || !isCanonicalBase64url(parts[0]) || !isCanonicalBase64url(parts[1])) {
    return { ok: false, reason: "malformed" };
  }
  const [encoded, signature] = parts as [string, string];

  let validSignature = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(input.controlPlanePublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    validSignature = cryptoVerify(null, Buffer.from(encoded, "utf8"), publicKey, fromBase64url(signature));
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!validSignature) return { ok: false, reason: "bad_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64url(encoded).toString("utf8")) as unknown;
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
  if (payload.exp > now + MAX_RELAY_TICKET_SECONDS) {
    return { ok: false, reason: "lifetime_too_long" };
  }
  return { ok: true, scope: payload };
}

export type RelayReserveResult =
  | { ok: true; state: "waiting" | "paired" }
  | { ok: false; reason: "expired" | "replayed_ticket" | "duplicate_role" | "scope_mismatch" | "capacity" | "closed" };

export type RelayByteResult =
  | { ok: true; totalBytes: number; complete: boolean }
  | { ok: false; reason: "not_paired" | "wrong_sender" | "invalid_byte_count" | "size_exceeded" | "closed" };

interface SessionRecord {
  readonly binding: Omit<RelayScope, "role" | "ticketId">;
  readonly roles: Set<RelayRole>;
  expiresAt: number;
  bytesForwarded: number;
  closed: boolean;
}

/**
 * Small deterministic state core for a future relay transport.
 *
 * This registry is intentionally in-memory; production requires a durable,
 * shared atomic ticket-claim store before tickets can be considered one-use
 * across restarts or multiple relay instances.
 */
export class RelaySessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly consumedTickets = new Map<string, number>();

  constructor(private readonly maxSessions = 10_000) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
      throw new Error("maxSessions must be a positive safe integer");
    }
  }

  reserve(scope: RelayScope, now = Math.floor(Date.now() / 1000)): RelayReserveResult {
    this.expire(now);
    if (scope.exp <= now) return { ok: false, reason: "expired" };
    if (this.consumedTickets.has(scope.ticketId)) return { ok: false, reason: "replayed_ticket" };

    let session = this.sessions.get(scope.sessionId);
    const binding = {
      v: scope.v,
      sessionId: scope.sessionId,
      storageHash: scope.storageHash,
      deviceId: scope.deviceId,
      op: scope.op,
      exp: scope.exp,
      maxBytes: scope.maxBytes,
    };
    if (session && !this.sameBinding(session.binding, binding)) {
      return { ok: false, reason: "scope_mismatch" };
    }
    if (session?.closed) return { ok: false, reason: "closed" };
    if (session?.roles.has(scope.role)) return { ok: false, reason: "duplicate_role" };
    if (!session) {
      if (this.sessions.size >= this.maxSessions) return { ok: false, reason: "capacity" };
      session = { binding, roles: new Set(), expiresAt: scope.exp, bytesForwarded: 0, closed: false };
      this.sessions.set(scope.sessionId, session);
    }

    this.consumedTickets.set(scope.ticketId, scope.exp);
    session.roles.add(scope.role);
    return { ok: true, state: session.roles.size === 2 ? "paired" : "waiting" };
  }

  /** Count bytes before forwarding them so a transport can stop at the signed ceiling. */
  accountBytes(input: {
    sessionId: string;
    sender: RelayRole;
    byteCount: number;
    now?: number;
  }): RelayByteResult {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    this.expire(now);
    const session = this.sessions.get(input.sessionId);
    if (!session) return { ok: false, reason: "closed" };
    if (session.closed) return { ok: false, reason: "closed" };
    if (session.roles.size !== 2) return { ok: false, reason: "not_paired" };
    const expectedSender: RelayRole = session.binding.op === "get" ? "node" : "client";
    if (input.sender !== expectedSender) return { ok: false, reason: "wrong_sender" };
    if (!Number.isSafeInteger(input.byteCount) || input.byteCount < 1) {
      return { ok: false, reason: "invalid_byte_count" };
    }
    if (session.bytesForwarded + input.byteCount > session.binding.maxBytes) {
      session.closed = true;
      return { ok: false, reason: "size_exceeded" };
    }
    session.bytesForwarded += input.byteCount;
    return {
      ok: true,
      totalBytes: session.bytesForwarded,
      complete: session.bytesForwarded === session.binding.maxBytes,
    };
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.closed = true;
  }

  private expire(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      // Keep closed tombstones until expiry so a later ticket cannot reopen a
      // consumed session, and closed sessions still count against the cap.
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
    for (const [ticketId, expiresAt] of this.consumedTickets) {
      if (expiresAt <= now) this.consumedTickets.delete(ticketId);
    }
  }

  private sameBinding(left: SessionRecord["binding"], right: SessionRecord["binding"]): boolean {
    return left.v === right.v
      && left.sessionId === right.sessionId
      && left.storageHash === right.storageHash
      && left.deviceId === right.deviceId
      && left.op === right.op
      && left.exp === right.exp
      && left.maxBytes === right.maxBytes;
  }
}
