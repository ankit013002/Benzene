import { describe, it, expect, vi, beforeEach } from "vitest";
import createUser from "./signup.controller";

// --- Mocks ---

vi.mock("../services/credentials.service", () => ({
  retrieveCredentialsByEmail: vi.fn(),
}));

vi.mock("../services/signup.service", () => ({
  createCredentials: vi.fn(),
}));

vi.mock("../services/email-verification-token", () => ({
  createVerificationToken: vi.fn(),
}));

vi.mock("../services/refresh.service", () => ({
  createRefreshToken: vi.fn(),
}));

vi.mock("../lib/mailer", () => ({
  sendVerificationEmail: vi.fn(),
}));

vi.mock("../lib/tokens", () => ({
  makeOpaqueToken: vi.fn(),
  hashToken: vi.fn(),
  signAccessToken: vi.fn(),
}));

vi.mock("bcrypt", () => ({
  default: {
    hash: vi.fn(),
  },
}));

// --- Imports after mocks ---

import { retrieveCredentialsByEmail } from "../services/credentials.service";
import { createCredentials } from "../services/signup.service";
import { createVerificationToken } from "../services/email-verification-token";
import { createRefreshToken } from "../services/refresh.service";
import { sendVerificationEmail } from "../lib/mailer";
import { makeOpaqueToken, hashToken, signAccessToken } from "../lib/tokens";
import bcrypt from "bcrypt";

// --- Fixtures ---

const mockCredential = {
  id: "cred-uuid-123",
  email: "user@example.com",
  password_hash: "$2b$12$hashed",
  email_verified: false,
  account_status: "active" as const,
  created_at: new Date(),
  updated_at: new Date(),
};

// --- Tests ---

describe("createUser (signup controller)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws UserExistsError when a user with that email already exists", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(mockCredential);

    await expect(
      createUser({ email: "user@example.com", password: "password123" }),
    ).rejects.toMatchObject({ name: "UserExistsError" });
  });

  it("throws UserCreationError when createCredentials returns null", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue("hashed-password" as never);
    vi.mocked(createCredentials).mockResolvedValue(null);

    await expect(
      createUser({ email: "user@example.com", password: "password123" }),
    ).rejects.toMatchObject({ name: "UserCreationError" });
  });

  it("creates the user, sends verification email, and returns tokens on success", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue("hashed-password" as never);
    vi.mocked(createCredentials).mockResolvedValue(mockCredential);
    vi.mocked(makeOpaqueToken)
      .mockReturnValueOnce("raw-verification-token")
      .mockReturnValueOnce("raw-refresh-token");
    vi.mocked(hashToken)
      .mockReturnValueOnce("hashed-verification-token")
      .mockReturnValueOnce("hashed-refresh-token");
    vi.mocked(signAccessToken).mockReturnValue("access-token");
    vi.mocked(sendVerificationEmail).mockResolvedValue(undefined);
    vi.mocked(createVerificationToken).mockResolvedValue(undefined);
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    const result = await createUser({
      email: "user@example.com",
      password: "password123",
    });

    expect(result).toEqual({
      accessToken: "access-token",
      refreshToken: "raw-refresh-token",
    });
  });

  it("hashes the password before storing it", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue("hashed-password" as never);
    vi.mocked(createCredentials).mockResolvedValue(mockCredential);
    vi.mocked(makeOpaqueToken).mockReturnValue("some-token");
    vi.mocked(hashToken).mockReturnValue("some-hash");
    vi.mocked(signAccessToken).mockReturnValue("access-token");
    vi.mocked(sendVerificationEmail).mockResolvedValue(undefined);
    vi.mocked(createVerificationToken).mockResolvedValue(undefined);
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    await createUser({ email: "user@example.com", password: "password123" });

    expect(createCredentials).toHaveBeenCalledWith(
      "user@example.com",
      "hashed-password",
    );
  });

  it("sends the verification email with the raw (unhashed) token", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue("hashed-password" as never);
    vi.mocked(createCredentials).mockResolvedValue(mockCredential);
    vi.mocked(makeOpaqueToken)
      .mockReturnValueOnce("raw-verification-token")
      .mockReturnValueOnce("raw-refresh-token");
    vi.mocked(hashToken).mockReturnValue("some-hash");
    vi.mocked(signAccessToken).mockReturnValue("access-token");
    vi.mocked(sendVerificationEmail).mockResolvedValue(undefined);
    vi.mocked(createVerificationToken).mockResolvedValue(undefined);
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    await createUser({ email: "user@example.com", password: "password123" });

    expect(sendVerificationEmail).toHaveBeenCalledWith(
      "user@example.com",
      "raw-verification-token",
    );
  });
});
