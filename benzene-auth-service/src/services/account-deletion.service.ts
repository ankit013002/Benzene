import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
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
  last_error_code?: string | null;
}

export const ACCOUNT_DELETION_CLEANUP_PHASES = [
  "user_profile",
  "stored_objects",
  "device_data",
  "vault_metadata",
  "billing_records",
  "backups_and_logs",
] as const satisfies readonly AccountDeletionPhase[];

export type AccountDeletionCleanupPhase =
  (typeof ACCOUNT_DELETION_CLEANUP_PHASES)[number];

export interface ClaimedAccountDeletionPhase {
  requestId: string;
  credentialId: string;
  phase: AccountDeletionCleanupPhase;
  leaseToken: string;
  attempt: number;
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
        SELECT id, status, current_phase, requested_at, updated_at, completed_at, last_error_code
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
        SELECT id, status, current_phase, requested_at, updated_at, completed_at, last_error_code
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

/**
 * Claims one cleanup phase across worker replicas. External phase handlers must
 * be idempotent: a process can finish its side effect and crash before it
 * records that result here, in which case the same phase is retried.
 */
export async function claimNextAccountDeletionPhase(
  requestId?: string,
): Promise<ClaimedAccountDeletionPhase | null> {
  const client = await pool.connect();
  const leaseToken = randomUUID();

  try {
    await client.query("BEGIN");
    const candidate = await client.query<{
      id: string;
      credential_id: string;
      current_phase: AccountDeletionPhase;
      attempt_count: number;
    }>(
      `
        SELECT id, credential_id, current_phase, attempt_count
        FROM account_deletion_requests
        WHERE status IN ('cleanup_pending', 'blocked')
          AND credential_id IS NOT NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          AND (retry_after IS NULL OR retry_after <= now())
          AND current_phase <> 'complete'
          AND ($1::uuid IS NULL OR id = $1)
        ORDER BY requested_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
      [requestId ?? null],
    );
    const request = candidate.rows[0];
    if (!request?.credential_id) {
      await client.query("COMMIT");
      return null;
    }

    const phase =
      request.current_phase === "awaiting_cleanup_operator"
        ? ACCOUNT_DELETION_CLEANUP_PHASES[0]
        : request.current_phase;
    if (!ACCOUNT_DELETION_CLEANUP_PHASES.includes(phase as AccountDeletionCleanupPhase)) {
      await client.query("COMMIT");
      return null;
    }

    const claimed = await client.query(
      `
        UPDATE account_deletion_requests
        SET current_phase = $2,
            status = 'cleanup_pending',
            lease_token = $3,
            lease_expires_at = now() + interval '2 minutes',
            retry_after = NULL,
            attempt_count = attempt_count + 1,
            phase_started_at = COALESCE(phase_started_at, now()),
            updated_at = now(),
            last_error_code = NULL
        WHERE id = $1
        RETURNING attempt_count
      `,
      [request.id, phase, leaseToken],
    );
    await client.query("COMMIT");
    return {
      requestId: request.id,
      credentialId: request.credential_id,
      phase: phase as AccountDeletionCleanupPhase,
      leaseToken,
      attempt: Number(claimed.rows[0]?.attempt_count ?? request.attempt_count + 1),
    };
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

/** Advances only the exact still-live claim and only to the next declared phase. */
export async function completeAccountDeletionPhase(
  claim: ClaimedAccountDeletionPhase,
): Promise<AccountDeletionPhase> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const nextIndex = ACCOUNT_DELETION_CLEANUP_PHASES.indexOf(claim.phase) + 1;
    const nextPhase: AccountDeletionPhase =
      nextIndex === ACCOUNT_DELETION_CLEANUP_PHASES.length
        ? "complete"
        : ACCOUNT_DELETION_CLEANUP_PHASES[nextIndex] ?? "complete";
    const result = await client.query(
      `
        UPDATE account_deletion_requests
        SET current_phase = $4,
            status = CASE WHEN $4 = 'complete' THEN 'completed' ELSE 'cleanup_pending' END,
            completed_at = CASE WHEN $4 = 'complete' THEN now() ELSE NULL END,
            lease_token = NULL,
            lease_expires_at = NULL,
            retry_after = NULL,
            phase_started_at = NULL,
            updated_at = now(),
            last_error_code = NULL
        WHERE id = $1
          AND credential_id = $2
          AND current_phase = $3
          AND lease_token = $5
          AND lease_expires_at > now()
          AND status = 'cleanup_pending'
      `,
      [claim.requestId, claim.credentialId, claim.phase, nextPhase, claim.leaseToken],
    );
    if (result.rowCount !== 1) {
      const error = new Error("Account deletion phase lease is stale");
      error.name = "StaleAccountDeletionLeaseError";
      throw error;
    }
    await client.query("COMMIT");
    return nextPhase;
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

/** Makes a failed phase retryable without leaking downstream error details. */
export async function blockAccountDeletionPhase(
  claim: ClaimedAccountDeletionPhase,
  errorCode: "phase_handler_unavailable" | "phase_execution_failed",
): Promise<boolean> {
  const result = await pool.query(
    `
      UPDATE account_deletion_requests
      SET status = 'blocked',
          lease_token = NULL,
          lease_expires_at = NULL,
          retry_after = now() + interval '5 minutes',
          updated_at = now(),
          last_error_code = $4
      WHERE id = $1
        AND credential_id = $2
        AND current_phase = $3
        AND lease_token = $5
        AND lease_expires_at > now()
        AND status = 'cleanup_pending'
    `,
    [claim.requestId, claim.credentialId, claim.phase, errorCode, claim.leaseToken],
  );
  return result.rowCount === 1;
}
