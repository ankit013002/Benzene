import { describe, it, expect, vi, beforeEach } from "vitest";
import forgotPassword from "./forgot-password.controller";

// --- Mocks ---

vi.mock("../services/credentials.service", () => ({
  retrieveCredentialsByEmail: vi.fn(),
}));

vi.mock("../services/password-reset-token.service", () => ({
  deletePasswordResetToken: vi.fn(),
  createPasswordResetToken: vi.fn(),
}));

vi.mock("../lib/mailer", () => ({
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("../lib/tokens", () => ({
  makeOpaqueToken: vi.fn(),
  hashToken: vi.fn(),
}));

// --- Imports after mocks ---

import { retrieveCredentialsByEmail } from "../services/credentials.service";
import {
  deletePasswordResetToken,
  createPasswordResetToken,
} from "../services/password-reset-token.service";
import { sendPasswordResetEmail } from "../lib/mailer";
import { makeOpaqueToken, hashToken } from "../lib/tokens";

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

describe("forgotPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns without doing anything when the email does not exist (anti-enumeration)", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(null);

    await expect(
      forgotPassword({ email: "noone@example.com" }),
    ).resolves.toBeUndefined();

    expect(deletePasswordResetToken).not.toHaveBeenCalled();
    expect(createPasswordResetToken).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("deletes existing reset tokens before creating a new one", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(mockCredential);
    vi.mocked(makeOpaqueToken).mockReturnValue("raw-reset-token");
    vi.mocked(hashToken).mockReturnValue("hashed-reset-token");
    vi.mocked(deletePasswordResetToken).mockResolvedValue(undefined);
    vi.mocked(createPasswordResetToken).mockResolvedValue(true);
    vi.mocked(sendPasswordResetEmail).mockResolvedValue(undefined);

    await forgotPassword({ email: "user@example.com" });

    expect(deletePasswordResetToken).toHaveBeenCalledWith(mockCredential.id);
    expect(createPasswordResetToken).toHaveBeenCalledWith(
      mockCredential.id,
      "hashed-reset-token",
    );
  });

  it("sends the reset email with the raw (unhashed) token", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(mockCredential);
    vi.mocked(makeOpaqueToken).mockReturnValue("raw-reset-token");
    vi.mocked(hashToken).mockReturnValue("hashed-reset-token");
    vi.mocked(deletePasswordResetToken).mockResolvedValue(undefined);
    vi.mocked(createPasswordResetToken).mockResolvedValue(true);
    vi.mocked(sendPasswordResetEmail).mockResolvedValue(undefined);

    await forgotPassword({ email: "user@example.com" });

    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      "user@example.com",
      "raw-reset-token",
    );
  });

  it("returns without throwing when the mailer fails (anti-enumeration)", async () => {
    vi.mocked(retrieveCredentialsByEmail).mockResolvedValue(mockCredential);
    vi.mocked(makeOpaqueToken).mockReturnValue("raw-reset-token");
    vi.mocked(hashToken).mockReturnValue("hashed-reset-token");
    vi.mocked(deletePasswordResetToken).mockResolvedValue(undefined);
    vi.mocked(createPasswordResetToken).mockResolvedValue(true);
    vi.mocked(sendPasswordResetEmail).mockRejectedValue(
      new Error("SMTP error"),
    );

    await expect(
      forgotPassword({ email: "user@example.com" }),
    ).resolves.toBeUndefined();
  });
});
