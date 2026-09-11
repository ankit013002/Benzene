import { describe, it, expect, vi, beforeEach } from "vitest";
import refreshRefreshToken from "./refresh.controller";

// --- Mocks ---

vi.mock("../services/refresh.service", () => ({
  consumeRefreshToken: vi.fn(),
  createRefreshToken: vi.fn(),
}));

vi.mock("../services/credentials.service", () => ({
  retrieveCredentialsByCredentialId: vi.fn(),
}));

vi.mock("../lib/tokens", () => ({
  hashToken: vi.fn(),
  makeOpaqueToken: vi.fn(),
  signAccessToken: vi.fn(),
}));

// --- Imports after mocks ---

import {
  consumeRefreshToken,
  createRefreshToken,
} from "../services/refresh.service";
import { retrieveCredentialsByCredentialId } from "../services/credentials.service";
import { hashToken, makeOpaqueToken, signAccessToken } from "../lib/tokens";

// --- Fixtures ---

const mockCredential = {
  id: "cred-uuid-123",
  email: "user@example.com",
  password_hash: "$2b$12$hashed",
  email_verified: true,
  created_at: new Date(),
  updated_at: new Date(),
};

const mockRefreshTokenEntry = {
  id: "rt-uuid-456",
  credential_id: "cred-uuid-123",
  token_hash: "hashed-refresh-token",
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  created_at: new Date(),
};

// --- Tests ---

describe("refreshRefreshToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws RefreshTokenMissingError when no token is provided", async () => {
    await expect(refreshRefreshToken({})).rejects.toMatchObject({
      name: "RefreshTokenMissingError",
    });
  });

  it("throws InvalidTokenError when the token is not found in the database", async () => {
    vi.mocked(hashToken).mockReturnValue("hashed-token");
    vi.mocked(consumeRefreshToken).mockResolvedValue(null);

    await expect(
      refreshRefreshToken({ refreshToken: "raw-token" }),
    ).rejects.toMatchObject({ name: "InvalidTokenError" });
  });

  it("throws InvalidTokenError when the associated credential is not found", async () => {
    vi.mocked(hashToken).mockReturnValue("hashed-token");
    vi.mocked(consumeRefreshToken).mockResolvedValue(mockRefreshTokenEntry);
    vi.mocked(retrieveCredentialsByCredentialId).mockResolvedValue(null);

    await expect(
      refreshRefreshToken({ refreshToken: "raw-token" }),
    ).rejects.toMatchObject({ name: "InvalidTokenError" });
  });

  it("returns a new access token and refresh token on success", async () => {
    vi.mocked(hashToken).mockReturnValueOnce("hashed-old-token");
    vi.mocked(consumeRefreshToken).mockResolvedValue(mockRefreshTokenEntry);
    vi.mocked(retrieveCredentialsByCredentialId).mockResolvedValue(
      mockCredential,
    );
    vi.mocked(signAccessToken).mockReturnValue("new-access-token");
    vi.mocked(makeOpaqueToken).mockReturnValue("new-raw-refresh-token");
    vi.mocked(hashToken).mockReturnValueOnce("new-hashed-refresh-token");
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    const result = await refreshRefreshToken({ refreshToken: "old-raw-token" });

    expect(result).toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-raw-refresh-token",
    });
  });

  it("consumes the old refresh token before issuing a new one (rotation)", async () => {
    vi.mocked(hashToken).mockReturnValue("hashed-token");
    vi.mocked(consumeRefreshToken).mockResolvedValue(mockRefreshTokenEntry);
    vi.mocked(retrieveCredentialsByCredentialId).mockResolvedValue(
      mockCredential,
    );
    vi.mocked(signAccessToken).mockReturnValue("new-access-token");
    vi.mocked(makeOpaqueToken).mockReturnValue("new-raw-refresh-token");
    vi.mocked(createRefreshToken).mockResolvedValue(null);

    await refreshRefreshToken({ refreshToken: "old-raw-token" });

    expect(consumeRefreshToken).toHaveBeenCalledWith(
      "hashed-token",
      expect.any(Date),
    );
  });
});
