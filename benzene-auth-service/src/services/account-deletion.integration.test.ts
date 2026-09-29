import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { STORED_OBJECTS_DELETION_GRACE_SECONDS } from "../lib/account-deletion-timing";
import { hashToken } from "../lib/tokens";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)("account deletion request foundation", () => {
  let pool: typeof import("../db").default;
  let requestAccountDeletion: typeof import("./account-deletion.service").requestAccountDeletion;
  let getAccountDeletionStatus: typeof import("./account-deletion.service").getAccountDeletionStatus;
  let loginController: typeof import("../controller/login.controller").default;
  let createRefreshToken: typeof import("./refresh.service").createRefreshToken;
  const createdCredentialIds: string[] = [];
  const createdDeletionRequestIds: string[] = [];
  const password = "account-deletion-test-password";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ default: pool } = await import("../db"));
    ({ requestAccountDeletion, getAccountDeletionStatus } = await import(
      "./account-deletion.service"
    ));
    ({ default: loginController } = await import(
      "../controller/login.controller"
    ));
    ({ createRefreshToken } = await import("./refresh.service"));
  });

  afterAll(async () => {
    if (pool) {
      await Promise.all(
        createdDeletionRequestIds.map((id) =>
          pool.query("DELETE FROM auth_account_deletion_tombstones WHERE deletion_request_id = $1", [id]),
        ),
      );
      await Promise.all(
        createdDeletionRequestIds.map((id) =>
          pool.query("DELETE FROM account_deletion_requests WHERE id = $1", [id]),
        ),
      );
      await Promise.all(
        createdCredentialIds.map((id) =>
          pool.query("DELETE FROM credentials WHERE id = $1", [id]),
        ),
      );
      await pool.end();
    }
  });

  async function createCredential() {
    const email = `account-delete-${randomUUID()}@example.com`;
    const passwordHash = await bcrypt.hash(password, 4);
    const result = await pool.query(
      `
        INSERT INTO credentials (email, password_hash, email_verified)
        VALUES ($1, $2, true)
        RETURNING id
      `,
      [email, passwordHash],
    );
    const id = result.rows[0].id as string;
    createdCredentialIds.push(id);
    await pool.query(
      `
        INSERT INTO refresh_tokens (credential_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '1 hour')
      `,
      [id, hashToken(`account-delete-refresh-${id}`)],
    );
    await pool.query(
      `
        INSERT INTO email_verification_tokens (credential_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '1 hour')
      `,
      [id, hashToken(`account-delete-verify-${id}`)],
    );
    await pool.query(
      `
        INSERT INTO password_reset_tokens (credential_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '1 hour')
      `,
      [id, hashToken(`account-delete-reset-${id}`)],
    );
    return { id, email };
  }

  it("records one cleanup-pending request and disables future auth sessions atomically", async () => {
    const account = await createCredential();
    const result = await requestAccountDeletion({
      email: account.email,
      password,
      idempotencyKey: "stable-deletion-operation-key",
    });
    createdDeletionRequestIds.push(result.request.id);

    expect(result.created).toBe(true);
    expect(result.request).toMatchObject({
      status: "cleanup_pending",
      current_phase: "awaiting_cleanup_operator",
      completed_at: null,
    });

    const persisted = await pool.query(
      `
        SELECT c.account_status, r.status, r.current_phase,
          (SELECT count(*) FROM refresh_tokens WHERE credential_id = c.id) AS refresh_count,
          (SELECT count(*) FROM email_verification_tokens WHERE credential_id = c.id) AS verification_count,
          (SELECT count(*) FROM password_reset_tokens WHERE credential_id = c.id) AS reset_count
        FROM credentials c
        JOIN account_deletion_requests r ON r.credential_id = c.id
        WHERE c.id = $1
      `,
      [account.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      account_status: "deletion_requested",
      status: "cleanup_pending",
      current_phase: "awaiting_cleanup_operator",
      refresh_count: "0",
      verification_count: "0",
      reset_count: "0",
    });

    await expect(
      loginController({ email: account.email, password }),
    ).rejects.toMatchObject({ name: "InvalidCredentialsError" });
    await expect(
      createRefreshToken(account.id, hashToken("late-session-token"), new Date(Date.now() + 60_000)),
    ).rejects.toMatchObject({ name: "AccountDeletionRequestedError" });

    const duplicate = await requestAccountDeletion({
      email: account.email,
      password,
      idempotencyKey: "different-retry-key-is-still-one-request",
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.request.id).toBe(result.request.id);

    const status = await getAccountDeletionStatus({
      email: account.email,
      password,
    });
    expect(status.id).toBe(result.request.id);
    expect(status.completed_at).toBeNull();
  });

  it("does not create a request or revoke sessions when reauthentication fails", async () => {
    const account = await createCredential();

    await expect(
      requestAccountDeletion({
        email: account.email,
        password: "incorrect-password",
        idempotencyKey: "stable-deletion-operation-key",
      }),
    ).rejects.toMatchObject({ name: "InvalidCredentialsError" });

    const persisted = await pool.query(
      `
        SELECT c.account_status,
          (SELECT count(*) FROM account_deletion_requests WHERE credential_id = c.id) AS request_count,
          (SELECT count(*) FROM refresh_tokens WHERE credential_id = c.id) AS refresh_count
        FROM credentials c
        WHERE c.id = $1
      `,
      [account.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      account_status: "active",
      request_count: "0",
      refresh_count: "1",
    });
  });

  it("serializes simultaneous requests into one pending deletion record", async () => {
    const account = await createCredential();
    const results = await Promise.all([
      requestAccountDeletion({
        email: account.email,
        password,
        idempotencyKey: "parallel-first-request-key",
      }),
      requestAccountDeletion({
        email: account.email,
        password,
        idempotencyKey: "parallel-second-request-key",
      }),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]?.request.id).toBe(results[1]?.request.id);

    const records = await pool.query(
      "SELECT id FROM account_deletion_requests WHERE credential_id = $1",
      [account.id],
    );
    expect(records.rows).toHaveLength(1);
    const firstResult = results[0];
    if (!firstResult) throw new Error("Expected a deletion request result");
    createdDeletionRequestIds.push(firstResult.request.id);
  });

  it("leases cleanup one phase at a time and cannot complete before all phases succeed", async () => {
    const account = await createCredential();
    const result = await requestAccountDeletion({
      email: account.email,
      password,
      idempotencyKey: "phase-runner-key",
    });
    createdDeletionRequestIds.push(result.request.id);

    const {
      claimNextAccountDeletionPhase,
      completeAccountDeletionPhase,
      blockAccountDeletionPhase,
    } = await import("./account-deletion.service");

    const claim = await claimNextAccountDeletionPhase(result.request.id);
    expect(claim).toMatchObject({
      requestId: result.request.id,
      credentialId: account.id,
      requestedAt: result.request.requested_at,
      phase: "user_profile",
      attempt: 1,
    });
    if (!claim) throw new Error("Expected the first cleanup phase to be claimable");

    const competingClaim = await claimNextAccountDeletionPhase(result.request.id);
    expect(competingClaim).toBeNull();

    expect(await blockAccountDeletionPhase(claim, "phase_execution_failed")).toBe(true);
    const blocked = await pool.query(
      `SELECT status, current_phase, completed_at, last_error_code,
              retry_after > now() AS retry_delayed
       FROM account_deletion_requests WHERE id = $1`,
      [result.request.id],
    );
    expect(blocked.rows[0]).toMatchObject({
      status: "blocked",
      current_phase: "user_profile",
      completed_at: null,
      last_error_code: "phase_execution_failed",
      retry_delayed: true,
    });

    await expect(
      claimNextAccountDeletionPhase(result.request.id),
    ).resolves.toBeNull();
    await pool.query(
      `UPDATE account_deletion_requests
       SET retry_after = now() - interval '1 second' WHERE id = $1`,
      [result.request.id],
    );

    const retry = await claimNextAccountDeletionPhase(result.request.id);
    expect(retry).toMatchObject({ phase: "user_profile", attempt: 2 });
    if (!retry) throw new Error("Expected the failed cleanup phase to be retryable");
    await completeAccountDeletionPhase(retry);

    const advanced = await pool.query(
      `SELECT status, current_phase, completed_at
       FROM account_deletion_requests WHERE id = $1`,
      [result.request.id],
    );
    expect(advanced.rows[0]).toMatchObject({
      status: "cleanup_pending",
      current_phase: "stored_objects",
      completed_at: null,
    });
  });

  it("leaves stored-object cleanup pending until the persisted token grace has elapsed", async () => {
    const account = await createCredential();
    const result = await requestAccountDeletion({
      email: account.email,
      password,
      idempotencyKey: "stored-object-grace-gate-key",
    });
    createdDeletionRequestIds.push(result.request.id);

    await pool.query(
      `UPDATE account_deletion_requests
       SET current_phase = 'stored_objects', status = 'cleanup_pending',
           requested_at = now(), retry_after = NULL, last_error_code = NULL
       WHERE id = $1`,
      [result.request.id],
    );

    const { claimNextAccountDeletionPhase } = await import("./account-deletion.service");
    await expect(claimNextAccountDeletionPhase(result.request.id)).resolves.toBeNull();

    const waiting = await pool.query(
      `SELECT status, current_phase, last_error_code, lease_token
       FROM account_deletion_requests WHERE id = $1`,
      [result.request.id],
    );
    expect(waiting.rows[0]).toMatchObject({
      status: "cleanup_pending",
      current_phase: "stored_objects",
      last_error_code: null,
      lease_token: null,
    });

    await pool.query(
      `UPDATE account_deletion_requests
       SET requested_at = now() - (($2::int + 1) * interval '1 second')
       WHERE id = $1`,
      [result.request.id, STORED_OBJECTS_DELETION_GRACE_SECONDS],
    );
    const eligible = await claimNextAccountDeletionPhase(result.request.id);
    expect(eligible).toMatchObject({
      requestId: result.request.id,
      credentialId: account.id,
      phase: "stored_objects",
      requestedAt: expect.any(Date),
    });
  });

  it("cannot report completion before the terminal credential-erasure phase", async () => {
    const account = await createCredential();
    const result = await requestAccountDeletion({
      email: account.email,
      password,
      idempotencyKey: "credential-erasure-gate-key",
    });
    createdDeletionRequestIds.push(result.request.id);

    const leaseToken = randomUUID();
    await pool.query(
      `UPDATE account_deletion_requests
       SET current_phase = 'backups_and_logs',
           status = 'cleanup_pending',
           lease_token = $2,
           lease_expires_at = now() + interval '2 minutes'
       WHERE id = $1`,
      [result.request.id, leaseToken],
    );

    const {
      claimNextAccountDeletionPhase,
      completeAccountDeletionPhase,
      blockAccountDeletionPhase,
    } = await import("./account-deletion.service");
    const next = await completeAccountDeletionPhase({
      requestId: result.request.id,
      credentialId: account.id,
      requestedAt: result.request.requested_at,
      phase: "backups_and_logs",
      leaseToken,
      attempt: 1,
    });
    expect(next).toBe("auth_credential");

    const credentialClaim = await claimNextAccountDeletionPhase(result.request.id);
    expect(credentialClaim).toMatchObject({ phase: "auth_credential" });
    if (!credentialClaim) throw new Error("Expected credential erasure to be claimable");
    expect(await blockAccountDeletionPhase(credentialClaim, "phase_handler_unavailable")).toBe(true);

    const persisted = await pool.query(
      `SELECT r.status, r.current_phase, r.completed_at,
              EXISTS (SELECT 1 FROM credentials c WHERE c.id = $2) AS credential_exists
       FROM account_deletion_requests r WHERE r.id = $1`,
      [result.request.id, account.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "blocked",
      current_phase: "auth_credential",
      completed_at: null,
      credential_exists: true,
    });
  });

  it("erases credentials and commits the completion tombstone atomically", async () => {
    const account = await createCredential();
    const result = await requestAccountDeletion({
      email: account.email,
      password,
      idempotencyKey: "terminal-credential-deletion-key",
    });
    createdDeletionRequestIds.push(result.request.id);
    const leaseToken = randomUUID();
    await pool.query(
      `UPDATE account_deletion_requests
       SET current_phase = 'auth_credential', status = 'cleanup_pending',
           lease_token = $2, lease_expires_at = now() + interval '2 minutes'
       WHERE id = $1`,
      [result.request.id, leaseToken],
    );

    const { completeAccountDeletionPhase } = await import("./account-deletion.service");
    await expect(
      completeAccountDeletionPhase({
        requestId: result.request.id,
        credentialId: account.id,
        requestedAt: result.request.requested_at,
        phase: "auth_credential",
        leaseToken,
        attempt: 1,
      }),
    ).resolves.toBe("complete");

    const persisted = await pool.query(
      `SELECT r.status, r.current_phase, r.completed_at, r.credential_id,
              t.credential_id AS tombstoned_credential_id,
              EXISTS (SELECT 1 FROM credentials c WHERE c.id = $2) AS credential_exists,
              (SELECT count(*) FROM refresh_tokens WHERE credential_id = $2) AS refresh_count,
              (SELECT count(*) FROM email_verification_tokens WHERE credential_id = $2) AS verification_count,
              (SELECT count(*) FROM password_reset_tokens WHERE credential_id = $2) AS reset_count
       FROM account_deletion_requests r
       LEFT JOIN auth_account_deletion_tombstones t ON t.deletion_request_id = r.id
       WHERE r.id = $1`,
      [result.request.id, account.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "completed",
      current_phase: "complete",
      credential_id: null,
      tombstoned_credential_id: account.id,
      credential_exists: false,
      refresh_count: "0",
      verification_count: "0",
      reset_count: "0",
    });
    expect(persisted.rows[0]?.completed_at).toBeInstanceOf(Date);

    const { createCredentials } = await import("./signup.service");
    const replacement = await createCredentials(
      `  ${account.email.toUpperCase()}  `,
      "new-password-hash",
    );
    expect(replacement?.id).toBeDefined();
    expect(replacement?.id).not.toBe(account.id);
    expect(replacement?.email).toBe(account.email);

    const oldTokens = await pool.query(
      `SELECT
         (SELECT count(*) FROM refresh_tokens WHERE credential_id = $1) AS refresh_count,
         (SELECT count(*) FROM email_verification_tokens WHERE credential_id = $1) AS verification_count,
         (SELECT count(*) FROM password_reset_tokens WHERE credential_id = $1) AS reset_count,
         (SELECT count(*) FROM credentials WHERE id = $1) AS old_credential_count,
         (SELECT count(*) FROM auth_account_deletion_tombstones WHERE deletion_request_id = $2) AS tombstone_count,
         (SELECT count(*) FROM account_deletion_requests WHERE id = $2 AND status = 'completed') AS completed_request_count`,
      [account.id, result.request.id],
    );
    expect(oldTokens.rows[0]).toMatchObject({
      refresh_count: "0",
      verification_count: "0",
      reset_count: "0",
      old_credential_count: "0",
      tombstone_count: "1",
      completed_request_count: "1",
    });
  });

  it("serializes concurrent terminal retries and retains one completed receipt", async () => {
    const account = await createCredential();
    const result = await requestAccountDeletion({
      email: account.email,
      password,
      idempotencyKey: "terminal-concurrency-key",
    });
    createdDeletionRequestIds.push(result.request.id);
    const leaseToken = randomUUID();
    await pool.query(
      `UPDATE account_deletion_requests
       SET current_phase = 'auth_credential', status = 'cleanup_pending',
           lease_token = $2, lease_expires_at = now() + interval '2 minutes'
       WHERE id = $1`,
      [result.request.id, leaseToken],
    );
    const { completeAccountDeletionPhase } = await import("./account-deletion.service");
    const claim = {
      requestId: result.request.id,
      credentialId: account.id,
      requestedAt: result.request.requested_at,
      phase: "auth_credential" as const,
      leaseToken,
      attempt: 1,
    };
    const outcomes = await Promise.allSettled([
      completeAccountDeletionPhase(claim),
      completeAccountDeletionPhase(claim),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const persisted = await pool.query(
      `SELECT r.status, r.current_phase, r.completed_at,
              (SELECT count(*) FROM auth_account_deletion_tombstones WHERE deletion_request_id = r.id) AS tombstone_count,
              (SELECT count(*) FROM credentials WHERE id = $2) AS credential_count
       FROM account_deletion_requests r WHERE r.id = $1`,
      [result.request.id, account.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "completed",
      current_phase: "complete",
      tombstone_count: "1",
      credential_count: "0",
    });
    expect(persisted.rows[0]?.completed_at).toBeInstanceOf(Date);
  });
});
