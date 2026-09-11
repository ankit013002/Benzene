import pool from "../db";
import { RefreshToken } from "../types/database";

/**
 * Creates a new refresh token for the specified credential ID, token hash, and expiration date.
 *
 * @param credentialId - The ID of the credential for which the refresh token is being created.
 * @param tokenHash - The hash of the refresh token to be stored in the database for later verification.
 * @param expiresAt - The expiration date and time for the refresh token, after which it will no longer be valid.
 * @returns A promise resolving to the created refresh token record from the database.
 */
export async function createRefreshToken(
  credentialId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<RefreshToken | null> {
  const result = await pool.query(
    `
      INSERT INTO refresh_tokens (credential_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
      RETURNING id`,
    [credentialId, tokenHash, expiresAt],
  );

  return result.rows[0];
}

/**
 * Retrieves a refresh token from the database based on the provided token hash and current date.
 *
 * @param refresh_token - The hash of the refresh token used to look up the corresponding entry in the database.
 * @param now - The current date and time used to check if the refresh token is still valid (not expired).
 * @returns A promise resolving to the refresh token record if found and valid, or null if not found or expired.
 */
export async function retrieveRefreshToken(
  tokenHash: string,
  now: Date,
): Promise<RefreshToken | null> {
  const result = await pool.query(
    `
            SELECT * FROM refresh_tokens
            WHERE token_hash = $1 AND expires_at > $2
        `,
    [tokenHash, now],
  );

  return result.rows[0];
}

/**
 * Atomically consumes a still-valid refresh token. PostgreSQL's DELETE lock
 * means concurrent refresh requests cannot both observe and consume it.
 */
export async function consumeRefreshToken(
  tokenHash: string,
  now: Date,
): Promise<RefreshToken | null> {
  const result = await pool.query(
    `
      DELETE FROM refresh_tokens
      WHERE token_hash = $1 AND expires_at > $2
      RETURNING *
    `,
    [tokenHash, now],
  );

  return result.rows[0] ?? null;
}

/**
 * Deletes a refresh token from the database based on the provided token ID.
 *
 * @param tokenId - The unique identifier of the refresh token to be deleted from the database.
 */
export async function deleteRefreshTokenWithId(tokenId: string): Promise<void> {
  await pool.query(
    `
      DELETE FROM refresh_tokens WHERE id = $1;
    `,
    [tokenId],
  );
}

/**
 * Deletes a refresh token from the database based on the provided token hash.
 * This function is used during the logout process to invalidate the refresh token,
 * ensuring that it can no longer be used to obtain new access tokens.
 */
export async function deleteRefreshTokenWithHash(
  tokenHash: string,
): Promise<void> {
  await pool.query(
    `
        DELETE FROM refresh_tokens WHERE token_hash = $1;
    `,
    [tokenHash],
  );
}

/**
 * Deletes all refresh tokens from the database associated with the provided credential ID.
 * This function is used after a password reset to invalidate all active sessions,
 * forcing the user to re-login on all devices.
 *
 * @param credentialId - The ID of the credential whose refresh tokens should be deleted.
 */
export async function deleteRefreshTokenWithCredentialId(
  credentialId: string,
): Promise<void> {
  await pool.query(
    `
        DELETE FROM refresh_tokens WHERE credential_id = $1;
    `,
    [credentialId],
  );
}
