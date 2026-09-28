import { describe, it, expect, vi } from "vitest";
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  signAccessToken,
  makeOpaqueToken,
  hashToken,
  verifyAccessToken,
} from "./tokens";
import jwt from "jsonwebtoken";

describe("hashToken", () => {
  it("returns the same hash for the same input", () => {
    const hash1 = hashToken("my-secret-token");
    const hash2 = hashToken("my-secret-token");
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", () => {
    const hash1 = hashToken("token-a");
    const hash2 = hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });

  it("returns a 64-character hex string (SHA-256 output)", () => {
    const hash = hashToken("any-token");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("makeOpaqueToken", () => {
  it("returns a 128-character hex string", () => {
    const token = makeOpaqueToken();
    expect(token).toHaveLength(128);
    expect(token).toMatch(/^[0-9a-f]{128}$/);
  });

  it("returns a different value on each call", () => {
    const token1 = makeOpaqueToken();
    const token2 = makeOpaqueToken();
    expect(token1).not.toBe(token2);
  });
});

describe("signAccessToken", () => {
  it("returns a non-empty string", () => {
    const token = signAccessToken("cred-id-123", "user@example.com");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("encodes the correct sub and email in the payload", () => {
    const token = signAccessToken("cred-id-123", "user@example.com");
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.sub).toBe("cred-id-123");
    expect(decoded.email).toBe("user@example.com");
  });

  it("includes the roles array with a default role of 'user'", () => {
    const token = signAccessToken("cred-id-123", "user@example.com");
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.roles).toEqual(["user"]);
  });

  it("sets the advertised short expiry on the token", () => {
    const token = signAccessToken("cred-id-123", "user@example.com");
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.exp).toBe((decoded.iat ?? 0) + ACCESS_TOKEN_LIFETIME_SECONDS);
  });
});

describe("verifyAccessToken", () => {
  it("returns the decoded payload for a valid token", () => {
    const token = signAccessToken("cred-id-123", "user@example.com");
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe("cred-id-123");
    expect(decoded.email).toBe("user@example.com");
  });

  it("throws for a tampered token", () => {
    const token = signAccessToken("cred-id-123", "user@example.com");
    const tampered = token.slice(0, -5) + "xxxxx";
    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it("throws for a completely invalid string", () => {
    expect(() => verifyAccessToken("not-a-jwt")).toThrow();
  });

  it("throws for an expired token", () => {
    const token = signAccessToken("cred-id-123", "user@example.com");

    // Advance time past the 15 minute expiry
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20 * 60 * 1000);

    expect(() => verifyAccessToken(token)).toThrow();

    vi.useRealTimers();
  });
});
