import { describe, it, expect, vi, beforeEach } from "vitest";
import loginController from "./login.controller";

// --- Mocks ---

vi.mock("../services/credentials.service", () => ({
  retrieveCredentialsByEmail: vi.fn(),
}));

vi.mock("../services/refresh.service", () => ({
  createRefreshToken: vi.fn(),
}));

vi.mock("../lib/tokens", () => ({
  makeOpaqueToken: vi.fn(),
  hashToken: vi.fn(),
  signAccessToken: vi.fn(),
}));

vi.mock("bcrypt", () => ({
  default: {
    compare: vi.fn(),
  },
}));

// --- Imports after mocks ---

import { retrieveCredentialsByEmail } from "../services/credentials.service";
import { createRefreshToken } from "../services/refresh.service";
import { makeOpaqueToken, hashToken, signAccessToken } from "../lib/tokens";
import bcrypt from "bcrypt";

// --- Fixtures ---

const mockCredential = {
  id: "cred-uuid-123",
  email: "user@example.com",
  password_hash: "$2b$12$hashed",
  email_verified: true,
  account_status: "active" as const,
  created_at: new Date(),
  updated_at: new Date(),
};

// --- Tests ---

describe("loginController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws InvalidCredentialsError when no user is found for that email", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(null);

    await expect(
      loginController({ email: "noone@example.com", password: "password123" }),
    ).rejects.toMatchObject({ name: "InvalidCredentialsError" });
  });

  it("throws InvalidCredentialsError when the password is wrong", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(mockCredential);
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    await expect(
      loginController({
        email: "user@example.com",
        password: "wrong-password",
      }),
    ).rejects.toMatchObject({ name: "InvalidCredentialsError" });
  });

  it("returns accessToken, refreshToken, and emailVerified on successful login", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(mockCredential);
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    vi.mocked(signAccessToken).mockReturnValue("access-token");
    vi.mocked(makeOpaqueToken).mockReturnValue("raw-refresh-token");
    vi.mocked(hashToken).mockReturnValue("hashed-refresh-token");
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    const result = await loginController({
      email: "user@example.com",
      password: "correct-password",
    });

    expect(result).toEqual({
      accessToken: "access-token",
      refreshToken: "raw-refresh-token",
      emailVerified: true,
    });
  });

  it("returns emailVerified as false when the user has not verified their email", async () => {
    const unverifiedCredential = { ...mockCredential, email_verified: false };
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(
      unverifiedCredential,
    );
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    vi.mocked(signAccessToken).mockReturnValue("access-token");
    vi.mocked(makeOpaqueToken).mockReturnValue("raw-refresh-token");
    vi.mocked(hashToken).mockReturnValue("hashed-refresh-token");
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    const result = await loginController({
      email: "user@example.com",
      password: "correct-password",
    });

    expect(result.emailVerified).toBe(false);
  });

  it("stores a hashed refresh token, not the raw one", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(mockCredential);
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    vi.mocked(signAccessToken).mockReturnValue("access-token");
    vi.mocked(makeOpaqueToken).mockReturnValue("raw-refresh-token");
    vi.mocked(hashToken).mockReturnValue("hashed-refresh-token");
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    await loginController({
      email: "user@example.com",
      password: "correct-password",
    });

    expect(createRefreshToken).toHaveBeenCalledWith(
      mockCredential.id,
      "hashed-refresh-token",
      expect.any(Date),
    );
  });
});
