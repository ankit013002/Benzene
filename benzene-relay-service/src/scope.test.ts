import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_RELAY_TICKET_SECONDS,
  validateRelayControlPlanePublicKey,
  verifyRelayScope,
  type RelayScope,
} from "./scope.js";
import { RELAY_SCOPE_VECTOR } from "./relayScopeVectors.js";

const NOW = 1_800_000_000;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privateKeyDer = privateKey.export({ format: "der", type: "pkcs8" });
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

function token(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(encoded), {
    key: privateKeyDer,
    format: "der",
    type: "pkcs8",
  }).toString("base64url");
  return `${encoded}.${signature}`;
}

function verify(payload: unknown = BASE_SCOPE) {
  return verifyRelayScope({ token: token(payload), controlPlanePublicKey: publicKeyBase64, now: NOW });
}

function nonCanonicalAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const remainder = value.length % 4;
  const unusedBits = remainder === 2 ? 4 : remainder === 3 ? 2 : 0;
  if (unusedBits === 0) throw new Error("encoded component has no unused base64url bits");
  const lastIndex = alphabet.indexOf(value[value.length - 1] ?? "");
  const alternative = alphabet[lastIndex + 1];
  if (lastIndex < 0 || alternative === undefined
    || (lastIndex >> unusedBits) !== (alphabet.indexOf(alternative) >> unusedBits)) {
    throw new Error("could not create a non-canonical base64url alias");
  }
  return `${value.slice(0, -1)}${alternative}`;
}

describe("relay ticket verification", () => {
  it("validates the configured key as canonical Ed25519 SPKI", () => {
    expect(() => validateRelayControlPlanePublicKey(publicKeyBase64)).not.toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ format: "der", type: "spki" }).toString("base64");
    expect(() => validateRelayControlPlanePublicKey(rsa)).toThrow(/Ed25519/);
    expect(() => validateRelayControlPlanePublicKey("not-a-key")).toThrow(/Ed25519/);
  });

  it("accepts the exact cross-package conformance vector", () => {
    expect(verifyRelayScope({
      token: RELAY_SCOPE_VECTOR.token,
      controlPlanePublicKey: RELAY_SCOPE_VECTOR.publicKey,
      now: RELAY_SCOPE_VECTOR.scope.exp - 60,
    })).toEqual({ ok: true, scope: RELAY_SCOPE_VECTOR.scope });
  });

  it("accepts only an exact signed ciphertext scope", () => {
    expect(verify()).toEqual({ ok: true, scope: BASE_SCOPE });
    expect(verify({ ...BASE_SCOPE, objectId: "b".repeat(64) }))
      .toEqual({ ok: false, reason: "invalid_scope" });
  });

  it("verifies before parsing and rejects tampering", () => {
    expect(verifyRelayScope({
      token: `${Buffer.from("not-json").toString("base64url")}.AA`,
      controlPlanePublicKey: publicKeyBase64,
      now: NOW,
    })).toEqual({ ok: false, reason: "bad_signature" });
    const signed = token(BASE_SCOPE).split(".");
    expect(verifyRelayScope({
      token: `${signed[0]}.${"A".repeat(86)}`,
      controlPlanePublicKey: publicKeyBase64,
      now: NOW,
    })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects non-canonical base64url encoding for either component", () => {
    const [payload, signature] = token(BASE_SCOPE).split(".") as [string, string];
    expect(verifyRelayScope({
      token: `${nonCanonicalAlias(payload)}.${signature}`,
      controlPlanePublicKey: publicKeyBase64,
      now: NOW,
    })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRelayScope({
      token: `${payload}.${nonCanonicalAlias(signature)}`,
      controlPlanePublicKey: publicKeyBase64,
      now: NOW,
    })).toEqual({ ok: false, reason: "malformed" });
  });

  it("enforces expiry and a five-minute maximum lifetime", () => {
    expect(verify({ ...BASE_SCOPE, exp: NOW })).toEqual({ ok: false, reason: "expired" });
    expect(verify({ ...BASE_SCOPE, exp: NOW + MAX_RELAY_TICKET_SECONDS + 1 }))
      .toEqual({ ok: false, reason: "lifetime_too_long" });
  });
});
