import { hashToken, makeOpaqueToken, signAccessToken } from "../lib/tokens";
import { retrieveCredentialsByCredentialId } from "../services/credentials.service";
import {
  consumeRefreshToken,
  createRefreshToken,
} from "../services/refresh.service";

/**
 * Handles the refresh token flow by validating the provided refresh token,
 * generating a new access token and refresh token for the httpOnly cookies.
 * If the refresh token is missing or invalid, it throws an appropriate error.
 * The function atomically consumes the old refresh token before creating a new
 * one, so concurrent uses of the same token cannot both succeed.
 *
 * @param data - An object that may contain the refresh token to be used for generating new tokens.
 * @returns An object containing the new access token and refresh token for the route.
 * @throws {RefreshTokenMissingError} If the refresh token is not provided in the request.
 * @throws {InvalidTokenError} If the provided refresh token is invalid or does not exist in the database.
 */
async function refreshRefreshToken(data: { refreshToken?: string }) {
  if (!data.refreshToken) {
    const error = new Error("Refresh token not provided");
    error.name = "RefreshTokenMissingError";
    throw error;
  }

  const hashedRefreshToken = hashToken(data.refreshToken);

  const refresh_token_entry = await consumeRefreshToken(
    hashedRefreshToken,
    new Date(),
  );

  if (!refresh_token_entry) {
    const error = new Error("Invalid refresh token");
    error.name = "InvalidTokenError";
    throw error;
  }

  const credentialId = refresh_token_entry.credential_id;

  const credentials = await retrieveCredentialsByCredentialId(credentialId);

  if (!credentials) {
    const error = new Error("Invalid refresh token");
    error.name = "InvalidTokenError";
    throw error;
  }

  const accessToken = signAccessToken(credentials.id, credentials.email);

  const rawRefreshToken = makeOpaqueToken();
  const hashedRefreshTokenNew = hashToken(rawRefreshToken);

  await createRefreshToken(
    credentials.id,
    hashedRefreshTokenNew,
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  );

  return { accessToken, refreshToken: rawRefreshToken };
}

export default refreshRefreshToken;
