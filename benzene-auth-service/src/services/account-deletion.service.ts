import bcrypt from "bcrypt";
import type { PoolClient } from "pg";
import pool from "../db";

export type AccountDeletionPhase =
  | "awaiting_cleanup_operator"
  | "user_profile"
  | "vault_metadata"
  | "stored_objects"
  | "device_data"
  | "billing_records"
  | "backups_and_logs"
  | "complete";

export interface AccountDeletionRequest {
  id: string;
  status: "cleanup_pending" | "blocked" | "completed";
  current_phase: AccountDeletionPhase;
  requested_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function invalidCredentialsError(): Error {
  const error = new Error("Invalid credentials");
  error.name = "InvalidCredentialsError";
  return error;
}

function invalidDeletionRequestError(): Error {
  const error = new Error("Account deletion request not found");
  error.name = "InvalidDeletionRequestError";
  return error;
}

async function verifyPassword(
  client: PoolClient,
  email: string,
  password: string,
) {
  const credentials = await client.query<{
    id: string;
    email: string;
    password_hash: string;
    account_status: "active" | "deletion_requested";
  }>(
    `
      SELECT id, email, password_hash, account_status
      FROM credentials
      WHERE email = $1
      FOR UPDATE
    `,
    [email.toLowerCase().trim()],
  );
  const credential = credentials.rows[0];

  if (
    !credential ||
    !(await bcrypt.compare(password, credential.password_hash || ""))
  ) {
    throw invalidCredentialsError();
  }

  return credential;
}

/**
 * Records a deletion request only after password reauthentication. This
 * transaction disables future sessions and writes the durable request together;
 * downstream data is deliberately left untouched for an explicit cleanup worker.
 */
export async function requestAccountDeletion(input: {
  email: string;
  password: string;
  idempotencyKey: string;
}): Promise<{ request: AccountDeletionRequest; created: boolean }> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const credential = await verifyPassword(
      client,
      input.email,
      input.password,
    );

    const existing = await client.query<AccountDeletionRequest>(
      `
        SELECT id, status, current_phase, requested_at, updated_at, completed_at
        FROM account_deletion_requests
        WHERE credential_id = $1
      `,
      [credential.id],
    );

    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { request: existing.rows[0], created: false };
    }

    if (credential.account_status !== "active") {
      throw invalidDeletionRequestError();
    }

    const updated = await client.query(
      `
        UPDATE credentials
        SET account_status = 'deletion_requested', updated_at = now()
        WHERE id = $1 AND account_status = 'active'
      `,
      [credential.id],
    );
    if (updated.rowCount !== 1) throw invalidDeletionRequestError();

    await client.query(
      "DELETE FROM refresh_tokens WHERE credential_id = $1",
      [credential.id],
    );
    await client.query(
      "DELETE FROM email_verification_tokens WHERE credential_id = $1",
      [credential.id],
    );
    await client.query(
      "DELETE FROM password_reset_tokens WHERE credential_id = $1",
      [credential.id],
    );

    const inserted = await client.query<AccountDeletionRequest>(
      `
        INSERT INTO account_deletion_requests (credential_id, idempotency_key)
        VALUES ($1, $2)
        RETURNING id, status, current_phase, requested_at, updated_at, completed_at
      `,
      [credential.id, input.idempotencyKey],
    );
    const request = inserted.rows[0];
    if (!request) throw new Error("Deletion request insert returned no row");

    await client.query("COMMIT");
    return { request, created: true };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original failure if rollback itself fails.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Reauthenticates before returning deletion progress to a signed-out user. */
export async function getAccountDeletionStatus(input: {
  email: string;
  password: string;
}): Promise<AccountDeletionRequest> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const credential = await verifyPassword(
      client,
      input.email,
      input.password,
    );
    const result = await client.query<AccountDeletionRequest>(
      `
        SELECT id, status, current_phase, requested_at, updated_at, completed_at
        FROM account_deletion_requests
        WHERE credential_id = $1
      `,
      [credential.id],
    );
    const request = result.rows[0];
    if (!request) throw invalidDeletionRequestError();
    await client.query("COMMIT");
    return request;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original failure if rollback itself fails.
    }
    throw error;
  } finally {
    client.release();
  }
}
