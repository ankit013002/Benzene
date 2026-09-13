import { describe, it, expect, vi, beforeEach } from "vitest";
import resendVerification from "./resend-verification-controller";

// --- Mocks ---

vi.mock("../services/credentials.service", () => ({
  retrieveCredentialsByCredentialId: vi.fn(),
}));

vi.mock("../services/email-verification-token", () => ({
  replaceVerificationTokenAtomically: vi.fn(),
}));

vi.mock("../lib/mailer", () => ({
  sendVerificationEmail: vi.fn(),
}));

vi.mock("../lib/tokens", () => ({
  verifyAccessToken: vi.fn(),
  makeOpaqueToken: vi.fn(),
  hashToken: vi.fn(),
}));

// --- Imports after mocks ---

import { retrieveCredentialsByCredentialId } from "../services/credentials.service";
import { replaceVerificationTokenAtomically } from "../services/email-verification-token";
import { sendVerificationEmail } from "../lib/mailer";
import { verifyAccessToken, makeOpaqueToken, hashToken } from "../lib/tokens";

// --- Fixtures ---

const mockCredential = {
  id: "cred-uuid-123",
  email: "user@example.com",
  password_hash: "$2b$12$hashed",
  email_verified: false,
  created_at: new Date(),
  updated_at: new Date(),
};

// --- Tests ---

describe("resendVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws SessionTokenMissingError when no session cookie is provided", async () => {
    await expect(resendVerification({ session: "" })).rejects.toMatchObject({
      name: "SessionTokenMissingError",
    });
  });

  it("throws InvalidSessionTokenError when the JWT is invalid", async () => {
    vi.mocked(verifyAccessToken).mockImplementation(() => {
      throw new Error("jwt invalid");
    });

    await expect(
      resendVerification({ session: "bad-token" }),
    ).rejects.toMatchObject({ name: "InvalidSessionTokenError" });
  });

  it("throws InvalidSessionTokenError when the decoded token has no sub", async () => {
    vi.mocked(verifyAccessToken).mockReturnValue({ email: "user@example.com" });

    await expect(
      resendVerification({ session: "token-without-sub" }),
    ).rejects.toMatchObject({ name: "InvalidSessionTokenError" });
  });

  it("throws InvalidSessionTokenError when no credential is found for the sub", async () => {
    vi.mocked(verifyAccessToken).mockReturnValue({ sub: "cred-uuid-123" });
    vi.mocked(retrieveCredentialsByCredentialId).mockResolvedValue(null);

    await expect(
      resendVerification({ session: "valid-token" }),
    ).rejects.toMatchObject({ name: "InvalidSessionTokenError" });
  });

  it("throws EmailAlreadyVerifiedError when the email is already verified", async () => {
    vi.mocked(verifyAccessToken).mockReturnValue({ sub: "cred-uuid-123" });
    vi.mocked(retrieveCredentialsByCredentialId).mockResolvedValue({
      ...mockCredential,
      email_verified: true,
    });

    await expect(
      resendVerification({ session: "valid-token" }),
    ).rejects.toMatchObject({ name: "EmailAlreadyVerifiedError" });
  });

  it("replaces the token and sends the verification email", async () => {
    vi.mocked(verifyAccessToken).mockReturnValue({ sub: "cred-uuid-123" });
    vi.mocked(retrieveCredentialsByCredentialId).mockResolvedValue(
      mockCredential,
    );
    vi.mocked(makeOpaqueToken).mockReturnValue("raw-verification-token");
    vi.mocked(hashToken).mockReturnValue("hashed-verification-token");
    vi.mocked(replaceVerificationTokenAtomically).mockResolvedValue(undefined);
    vi.mocked(sendVerificationEmail).mockResolvedValue(undefined);

    await resendVerification({ session: "valid-token" });

    expect(replaceVerificationTokenAtomically).toHaveBeenCalledWith(
      "cred-uuid-123",
      "hashed-verification-token",
    );
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      "user@example.com",
      "raw-verification-token",
    );
  });
});
