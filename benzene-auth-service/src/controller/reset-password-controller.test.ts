import { describe, it, expect, vi, beforeEach } from "vitest";
import resetPassword from "./reset-password-controller";

// --- Mocks ---

vi.mock("../services/password-reset-token.service", () => ({
  resetPasswordAtomically: vi.fn(),
}));

vi.mock("../lib/tokens", () => ({
  hashToken: vi.fn(),
}));

vi.mock("bcrypt", () => ({
  default: {
    hash: vi.fn(),
  },
}));

// --- Imports after mocks ---

import { resetPasswordAtomically } from "../services/password-reset-token.service";
import { hashToken } from "../lib/tokens";
import bcrypt from "bcrypt";

// --- Tests ---

describe("resetPassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws InvalidTokenError when the reset token is not found or expired", async () => {
    vi.mocked(hashToken).mockReturnValue("hashed-token");
    const error = new Error("Invalid or expired reset link");
    error.name = "InvalidTokenError";
    vi.mocked(resetPasswordAtomically).mockRejectedValue(error);

    await expect(
      resetPassword({ token: "raw-token", newPassword: "newpassword123" }),
    ).rejects.toMatchObject({ name: "InvalidTokenError" });
  });

  it("hashes the new password and delegates the atomic reset", async () => {
    vi.mocked(hashToken).mockReturnValue("hashed-token");
    vi.mocked(bcrypt.hash).mockResolvedValue("new-hashed-password" as never);
    vi.mocked(resetPasswordAtomically).mockResolvedValue(undefined);

    await resetPassword({ token: "raw-token", newPassword: "newpassword123" });

    expect(resetPasswordAtomically).toHaveBeenCalledWith(
      "hashed-token",
      "new-hashed-password",
    );
  });
});
