import { sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GRANT_TEST_PRIVATE_KEY, GRANT_TEST_PUBLIC_KEY } from "./grantVectors.js";
import { RELAY_SCOPE_VECTOR } from "./relayScopeVectors.js";
import {
  MAX_RELAY_OBJECT_BYTES,
  MAX_RELAY_TICKET_SECONDS,
  RelaySessionRegistry,
  verifyRelayScope,
  type RelayScope,
} from "./relayScope.js";

const NOW = 1_800_000_000;
const BASE_SCOPE: RelayScope = {
  v: 1,
  sessionId: "11111111-1111-4111-8111-111111111111",
  ticketId: "22222222-2222-4222-8222-222222222222",
  storageHash: "a".repeat(64),
  deviceId: "33333333-3333-4333-8333-333333333333",
  op: "get",
  role: "node",
  exp: NOW + 60,
  maxBytes: 12,
};

function encode(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const privateKey = Buffer.from(GRANT_TEST_PRIVATE_KEY, "base64");
  const signature = sign(null, Buffer.from(encoded), {
    key: privateKey,
    format: "der",
    type: "pkcs8",
  }).toString("base64url");
  return `${encoded}.${signature}`;
}

function verify(scope: unknown = BASE_SCOPE) {
  return verifyRelayScope({
    token: encode(scope),
    controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
    now: NOW,
  });
}

describe("relay scope contract", () => {
  it("accepts the exact cross-package conformance vector", () => {
    expect(verifyRelayScope({
      token: RELAY_SCOPE_VECTOR.token,
      controlPlanePublicKey: RELAY_SCOPE_VECTOR.publicKey,
      now: RELAY_SCOPE_VECTOR.scope.exp - 60,
    })).toEqual({ ok: true, scope: RELAY_SCOPE_VECTOR.scope });
  });

  it("accepts a valid, short-lived scope", () => {
    expect(verify()).toEqual({ ok: true, scope: BASE_SCOPE });
  });

  it("verifies the signature before parsing the claims", () => {
    expect(verifyRelayScope({
      token: `${Buffer.from("not-json").toString("base64url")}.AA`,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      now: NOW,
    })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects non-canonical base64url payloads and signatures", () => {
    const canonical = encode(BASE_SCOPE);
    const [payload, signature] = canonical.split(".") as [string, string];
    const nonCanonicalAlias = (value: string): string => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const remainder = value.length % 4;
      const unusedBits = remainder === 2 ? 4 : remainder === 3 ? 2 : 0;
      if (unusedBits === 0) throw new Error("encoded component has no unused base64url bits");
      const last = value[value.length - 1];
      const lastIndex = alphabet.indexOf(last ?? "");
      const alternative = alphabet[lastIndex + 1];
      if (lastIndex < 0 || alternative === undefined
        || (lastIndex >> unusedBits) !== (alphabet.indexOf(alternative) >> unusedBits)) {
        throw new Error("could not create a non-canonical base64url alias");
      }
      return `${value.slice(0, -1)}${alternative}`;
    };

    expect(verifyRelayScope({
      token: `${nonCanonicalAlias(payload)}.${signature}`,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      now: NOW,
    })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRelayScope({
      token: `${payload}.${nonCanonicalAlias(signature)}`,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      now: NOW,
    })).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects malformed, expired, overlong, and oversized scopes", () => {
    expect(verifyRelayScope({ token: "x", controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY, now: NOW }))
      .toEqual({ ok: false, reason: "malformed" });
    expect(verify({ ...BASE_SCOPE, exp: NOW })).toEqual({ ok: false, reason: "expired" });
    expect(verify({ ...BASE_SCOPE, exp: NOW + MAX_RELAY_TICKET_SECONDS + 1 }))
      .toEqual({ ok: false, reason: "lifetime_too_long" });
    expect(verify({ ...BASE_SCOPE, maxBytes: MAX_RELAY_OBJECT_BYTES + 1 }))
      .toEqual({ ok: false, reason: "invalid_scope" });
  });

  it("rejects unsupported versions and invalid roles", () => {
    expect(verify({ ...BASE_SCOPE, v: 2 })).toEqual({ ok: false, reason: "unsupported_version" });
    expect(verify({ ...BASE_SCOPE, role: "server" })).toEqual({ ok: false, reason: "invalid_scope" });
  });
});

describe("relay session state", () => {
  const counterpart = (scope: RelayScope): RelayScope => ({
    ...scope,
    ticketId: "44444444-4444-4444-8444-444444444444",
    role: scope.role === "node" ? "client" : "node",
  });

  it("pairs only the opposite role for the identical object, device, operation, and limits", () => {
    const registry = new RelaySessionRegistry();
    expect(registry.reserve(BASE_SCOPE, NOW)).toEqual({ ok: true, state: "waiting" });
    expect(registry.reserve(counterpart(BASE_SCOPE), NOW)).toEqual({ ok: true, state: "paired" });
    expect(registry.reserve(counterpart(BASE_SCOPE), NOW)).toEqual({ ok: false, reason: "replayed_ticket" });
  });

  it("rejects a reused role and mismatched session binding", () => {
    const registry = new RelaySessionRegistry();
    expect(registry.reserve(BASE_SCOPE, NOW).ok).toBe(true);
    expect(registry.reserve({ ...BASE_SCOPE, ticketId: "55555555-5555-4555-8555-555555555555" }, NOW))
      .toEqual({ ok: false, reason: "duplicate_role" });
    expect(registry.reserve({ ...counterpart(BASE_SCOPE), storageHash: "b".repeat(64) }, NOW))
      .toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("accounts only the operation's sender and closes before exceeding the signed byte ceiling", () => {
    const registry = new RelaySessionRegistry();
    registry.reserve(BASE_SCOPE, NOW);
    registry.reserve(counterpart(BASE_SCOPE), NOW);
    expect(registry.accountBytes({ sessionId: BASE_SCOPE.sessionId, sender: "client", byteCount: 1, now: NOW }))
      .toEqual({ ok: false, reason: "wrong_sender" });
    expect(registry.accountBytes({ sessionId: BASE_SCOPE.sessionId, sender: "node", byteCount: 8, now: NOW }))
      .toEqual({ ok: true, totalBytes: 8, complete: false });
    expect(registry.accountBytes({ sessionId: BASE_SCOPE.sessionId, sender: "node", byteCount: 5, now: NOW }))
      .toEqual({ ok: false, reason: "size_exceeded" });
    expect(registry.accountBytes({ sessionId: BASE_SCOPE.sessionId, sender: "node", byteCount: 1, now: NOW }))
      .toEqual({ ok: false, reason: "closed" });
  });

  it("allows only the client to send bytes for a put rendezvous", () => {
    const putScope: RelayScope = {
      ...BASE_SCOPE,
      sessionId: "88888888-8888-4888-8888-888888888888",
      ticketId: "99999999-9999-4999-8999-999999999999",
      op: "put",
      role: "client",
      maxBytes: 4,
    };
    const registry = new RelaySessionRegistry();
    registry.reserve(putScope, NOW);
    registry.reserve(counterpart(putScope), NOW);
    expect(registry.accountBytes({ sessionId: putScope.sessionId, sender: "node", byteCount: 1, now: NOW }))
      .toEqual({ ok: false, reason: "wrong_sender" });
    expect(registry.accountBytes({ sessionId: putScope.sessionId, sender: "client", byteCount: 4, now: NOW }))
      .toEqual({ ok: true, totalBytes: 4, complete: true });
  });

  it("expires unpaired sessions and consumed ticket IDs", () => {
    const registry = new RelaySessionRegistry();
    registry.reserve(BASE_SCOPE, NOW);
    expect(registry.reserve(BASE_SCOPE, NOW)).toEqual({ ok: false, reason: "replayed_ticket" });
    expect(registry.reserve({ ...BASE_SCOPE, exp: NOW + 1 }, NOW + 1))
      .toEqual({ ok: false, reason: "expired" });
  });

  it("applies a hard concurrent-session capacity", () => {
    const registry = new RelaySessionRegistry(1);
    registry.reserve(BASE_SCOPE, NOW);
    expect(registry.reserve({
      ...BASE_SCOPE,
      sessionId: "66666666-6666-4666-8666-666666666666",
      ticketId: "77777777-7777-4777-8777-777777777777",
    }, NOW)).toEqual({ ok: false, reason: "capacity" });
  });

  it("retains a closed session tombstone until its ticket expires", () => {
    const registry = new RelaySessionRegistry(1);
    registry.reserve(BASE_SCOPE, NOW);
    registry.close(BASE_SCOPE.sessionId);
    expect(registry.reserve(counterpart(BASE_SCOPE), NOW)).toEqual({ ok: false, reason: "closed" });
    expect(registry.reserve({
      ...BASE_SCOPE,
      sessionId: "66666666-6666-4666-8666-666666666666",
      ticketId: "77777777-7777-4777-8777-777777777777",
    }, NOW)).toEqual({ ok: false, reason: "capacity" });
  });
});
