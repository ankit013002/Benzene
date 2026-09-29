import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GRANT_TEST_PRIVATE_KEY } from "./grantVectors.js";
import { RELAY_SCOPE_VECTOR } from "./relayScopeVectors.js";
import { issueRelayTicket, type RelayTicketScope } from "./relayTicket.js";

function decode(token: string): unknown {
  const payload = token.split(".")[0] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
}

function verifies(token: string): boolean {
  const [encoded, signature] = token.split(".") as [string, string];
  return verify(
    null,
    Buffer.from(encoded, "utf8"),
    createPublicKey({
      key: Buffer.from(RELAY_SCOPE_VECTOR.publicKey, "base64"),
      format: "der",
      type: "spki",
    }),
    Buffer.from(signature, "base64url")
  );
}

describe("relay ticket contract", () => {
  it("emits the shared node ticket vector byte for byte", () => {
    expect(issueRelayTicket(
      GRANT_TEST_PRIVATE_KEY,
      RELAY_SCOPE_VECTOR.scope,
      RELAY_SCOPE_VECTOR.scope.exp - 60
    )).toBe(RELAY_SCOPE_VECTOR.token);
    expect(verifies(RELAY_SCOPE_VECTOR.token)).toBe(true);
  });

  it("issues complementary one-use scopes with identical object and session bindings", () => {
    const base: RelayTicketScope = {
      v: 1,
      sessionId: "11111111-1111-4111-8111-111111111111",
      ticketId: "22222222-2222-4222-8222-222222222222",
      storageHash: "a".repeat(64),
      deviceId: "33333333-3333-4333-8333-333333333333",
      op: "get",
      role: "node",
      exp: 1_800_000_060,
      maxBytes: 512,
    };
    const nodeTicket = issueRelayTicket(GRANT_TEST_PRIVATE_KEY, base, 1_800_000_000);
    const clientTicket = issueRelayTicket(
      GRANT_TEST_PRIVATE_KEY,
      { ...base, ticketId: "44444444-4444-4444-8444-444444444444", role: "client" },
      1_800_000_000
    );
    const nodeScope = decode(nodeTicket) as RelayTicketScope;
    const clientScope = decode(clientTicket) as RelayTicketScope;
    expect(verifies(nodeTicket)).toBe(true);
    expect(verifies(clientTicket)).toBe(true);
    expect(nodeScope).toMatchObject({ ...base, role: "node" });
    expect(clientScope).toMatchObject({ ...base, ticketId: "44444444-4444-4444-8444-444444444444", role: "client" });
    expect({
      sessionId: clientScope.sessionId,
      storageHash: clientScope.storageHash,
      deviceId: clientScope.deviceId,
      op: clientScope.op,
      exp: clientScope.exp,
      maxBytes: clientScope.maxBytes,
    }).toEqual({
      sessionId: nodeScope.sessionId,
      storageHash: nodeScope.storageHash,
      deviceId: nodeScope.deviceId,
      op: nodeScope.op,
      exp: nodeScope.exp,
      maxBytes: nodeScope.maxBytes,
    });
  });

  it("rejects expired, overlong, malformed, and oversized ticket scopes", () => {
    const base: RelayTicketScope = { ...RELAY_SCOPE_VECTOR.scope };
    expect(() => issueRelayTicket(GRANT_TEST_PRIVATE_KEY, base, base.exp)).toThrow(/future/);
    expect(() => issueRelayTicket(GRANT_TEST_PRIVATE_KEY, base, base.exp - 301)).toThrow(/five minutes/);
    expect(() => issueRelayTicket(GRANT_TEST_PRIVATE_KEY, { ...base, maxBytes: 0 }, base.exp - 60))
      .toThrow(/scope/);
  });
});
