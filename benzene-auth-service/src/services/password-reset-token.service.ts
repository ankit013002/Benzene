import pool from "../db";
import { PasswordResetToken } from "../types/database";

function invalidResetTokenError(): Error {
  const error = new Error("Invalid or expired reset link");
  error.name = "InvalidTokenError";
  return error;
}

/**
 * Deletes all password reset tokens from the database associated with the provided credential ID.
 * This is called before creating a new reset token to ensure only one active token exists per user.
 *
 * @param credentialId - The ID of the credential whose password reset tokens should be deleted.
 */
export async function deletePasswordResetToken(
  credentialId: string,
): Promise<void> {
  await pool.query(
    `
      DELETE FROM password_reset_tokens
      WHERE credential_id = $1
    `,
    [credentialId],
  );
}

/**
 * Creates a new password reset token for the specified credential ID and token hash.
 * The token expires 1 hour from the time of creation.
 *
 * @param credentialId - The ID of the credential for which the password reset token is being created.
 * @param tokenHash - The hash of the reset token to be stored in the database for later verification.
 */
export async function createPasswordResetToken(
  credentialId: string,
  tokenHash: string,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO password_reset_tokens (credential_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '1 hour')
    `,
    [credentialId, tokenHash],
  );
}

/**
 * Applies a password reset as one database transaction. The row lock makes a
 * concurrent request wait until the first request commits, after which the
 * used token no longer qualifies as valid.
 */
export async function resetPasswordAtomically(
  tokenHash: string,
  passwordHash: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tokenResult = await client.query<Pick<PasswordResetToken, "credential_id">>(
      `
        SELECT credential_id
        FROM password_reset_tokens
        WHERE token_hash = $1
          AND expires_at > $2
          AND used_at IS NULL
        FOR UPDATE
      `,
      [tokenHash, new Date()],
    );
    const credentialId = tokenResult.rows[0]?.credential_id;
    if (!credentialId) throw invalidResetTokenError();

    await client.query(
      `
        UPDATE credentials
        SET password_hash = $1, updated_at = now()
        WHERE id = $2
      `,
      [passwordHash, credentialId],
    );

    const consumed = await client.query(
      `
        UPDATE password_reset_tokens
        SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL
      `,
      [tokenHash],
    );
    if (consumed.rowCount !== 1) throw invalidResetTokenError();

    await client.query(
      "DELETE FROM refresh_tokens WHERE credential_id = $1",
      [credentialId],
    );

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error when rollback itself cannot complete.
    }
    throw error;
  } finally {
    client.release();
  }
}
