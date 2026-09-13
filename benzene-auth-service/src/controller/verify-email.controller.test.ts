import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleVerifyEmail } from "./verify-email.controller";

// --- Mocks ---

vi.mock("../services/email-verification-token", () => ({
  consumeVerificationTokenAtomically: vi.fn(),
}));

vi.mock("../lib/tokens", () => ({
  hashToken: vi.fn(),
}));

// --- Imports after mocks ---

import { consumeVerificationTokenAtomically } from "../services/email-verification-token";
import { hashToken } from "../lib/tokens";

// --- Tests ---

describe("handleVerifyEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws MissingTokenError when no token is provided", async () => {
    await expect(handleVerifyEmail(undefined)).rejects.toMatchObject({
      name: "MissingTokenError",
    });
  });

  it("throws MissingTokenError when token is not a string", async () => {
    await expect(handleVerifyEmail(12345)).rejects.toMatchObject({
      name: "MissingTokenError",
    });
  });

  it("throws InvalidTokenError when the token is not found in the database", async () => {
    vi.mocked(hashToken).mockReturnValue("hashed-token");
    const error = new Error("Invalid or expired verification token");
    error.name = "InvalidTokenError";
    vi.mocked(consumeVerificationTokenAtomically).mockRejectedValue(error);

    await expect(handleVerifyEmail("raw-token")).rejects.toMatchObject({
      name: "InvalidTokenError",
    });
  });

  it("delegates verification and token consumption atomically", async () => {
    vi.mocked(hashToken).mockReturnValue("hashed-token");
    vi.mocked(consumeVerificationTokenAtomically).mockResolvedValue(undefined);

    await handleVerifyEmail("raw-token");

    expect(consumeVerificationTokenAtomically).toHaveBeenCalledWith(
      "hashed-token",
    );
  });
});
