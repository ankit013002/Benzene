import pool from "../db";

function invalidVerificationTokenError(): Error {
  const error = new Error("Invalid or expired verification token");
  error.name = "InvalidTokenError";
  return error;
}

function emailAlreadyVerifiedError(): Error {
  const error = new Error("Email already verified");
  error.name = "EmailAlreadyVerifiedError";
  return error;
}

/**
 * Creates the initial verification token for a newly signed-up credential.
 * Existing tokens must use replaceVerificationTokenAtomically instead.
 */
export async function createVerificationToken(
  credentialId: string,
  tokenHash: string,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO email_verification_tokens (credential_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
    `,
    [credentialId, tokenHash, new Date(Date.now() + 24 * 60 * 60 * 1000)],
  );
}

/**
 * Replaces every outstanding verification token for a credential in one
 * transaction. The credential lock gives concurrent resends a deterministic
 * last-writer-wins result and lets verification serialize with replacement.
 */
export async function replaceVerificationTokenAtomically(
  credentialId: string,
  tokenHash: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const credential = await client.query<{ email_verified: boolean }>(
      "SELECT email_verified FROM credentials WHERE id = $1 FOR UPDATE",
      [credentialId],
    );
    if (credential.rowCount !== 1) throw invalidVerificationTokenError();
    if (credential.rows[0].email_verified) {
      throw emailAlreadyVerifiedError();
    }

    await client.query(
      "DELETE FROM email_verification_tokens WHERE credential_id = $1",
      [credentialId],
    );
    await client.query(
      `
        INSERT INTO email_verification_tokens (credential_id, token_hash, expires_at)
        VALUES ($1, $2, $3)
      `,
      [credentialId, tokenHash, new Date(Date.now() + 24 * 60 * 60 * 1000)],
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

/**
 * Consumes a valid verification token and marks its credential verified in
 * one transaction. Both operations lock the credential before token rows so
 * replacement and consumption cannot deadlock each other.
 */
export async function consumeVerificationTokenAtomically(
  tokenHash: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const candidate = await client.query<{ credential_id: string }>(
      `
        SELECT credential_id
        FROM email_verification_tokens
        WHERE token_hash = $1 AND expires_at > $2
      `,
      [tokenHash, new Date()],
    );
    const credentialId = candidate.rows[0]?.credential_id;
    if (!credentialId) throw invalidVerificationTokenError();

    const credential = await client.query(
      "SELECT id FROM credentials WHERE id = $1 FOR UPDATE",
      [credentialId],
    );
    if (credential.rowCount !== 1) throw invalidVerificationTokenError();

    const token = await client.query(
      `
        SELECT credential_id
        FROM email_verification_tokens
        WHERE token_hash = $1 AND expires_at > $2
        FOR UPDATE
      `,
      [tokenHash, new Date()],
    );
    if (token.rowCount !== 1) throw invalidVerificationTokenError();

    await client.query(
      `
        UPDATE credentials
        SET email_verified = true, updated_at = now()
        WHERE id = $1
      `,
      [credentialId],
    );

    const consumed = await client.query(
      "DELETE FROM email_verification_tokens WHERE credential_id = $1",
      [credentialId],
    );
    if (!consumed.rowCount) throw invalidVerificationTokenError();

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
