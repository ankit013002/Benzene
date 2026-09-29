import type { Pool, PoolClient } from "pg";
import type { RelayScope, RelayRole } from "./scope.js";

export type ClaimFailure = "expired" | "replayed_ticket" | "duplicate_role" | "scope_mismatch" | "capacity" | "closed" | "wrong_instance";
export type ClaimResult = { ok: true; state: "waiting" | "paired" }
  | { ok: false; reason: ClaimFailure };
export type AccountResult = { ok: true; totalBytes: number; complete: boolean }
  | { ok: false; reason: "not_paired" | "wrong_sender" | "invalid_byte_count" | "size_exceeded" | "closed" };

export interface RelaySessionStore {
  claim(scope: RelayScope, now?: number): Promise<ClaimResult>;
  accountBytes(input: { sessionId: string; sender: RelayRole; byteCount: number; now?: number }): Promise<AccountResult>;
  closeSession(sessionId: string): Promise<void>;
}

interface SessionRow {
  session_id: string;
  storage_hash: string;
  device_id: string;
  operation: "get" | "put";
  expires_at: string;
  max_bytes: string;
  bytes_forwarded: string;
  state: "waiting" | "paired" | "closed";
  owner_instance: string;
}

export class PostgresRelaySessionStore implements RelaySessionStore {
  constructor(
    private readonly pool: Pool,
    private readonly instanceId: string,
    private readonly maxSessions: number,
  ) {
    if (!instanceId.trim()) throw new Error("RELAY_INSTANCE_ID must not be empty");
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
      throw new Error("RELAY_MAX_SESSIONS must be a positive safe integer");
    }
  }

  async claim(scope: RelayScope, testNow?: number): Promise<ClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize claims across relay instances to enforce the global cap and
      // make ticket/session uniqueness decisions against a stable snapshot.
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [194687492, 1]);
      const now = testNow ?? Math.floor(Date.now() / 1000);
      if (scope.exp <= now) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "expired" };
      }
      await client.query("DELETE FROM relay_sessions WHERE expires_at <= $1", [now]);
      const replay = await client.query("SELECT 1 FROM relay_ticket_claims WHERE ticket_id = $1", [scope.ticketId]);
      if (replay.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "replayed_ticket" };
      }

      const existing = await client.query<SessionRow>(
        "SELECT * FROM relay_sessions WHERE session_id = $1 FOR UPDATE",
        [scope.sessionId],
      );
      let state: SessionRow["state"] = "waiting";
      if (existing.rowCount === 0) {
        const active = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM relay_sessions WHERE expires_at > $1",
          [now],
        );
        if (Number(active.rows[0]?.count ?? 0) >= this.maxSessions) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "capacity" };
        }
        await client.query(
          `INSERT INTO relay_sessions
             (session_id, storage_hash, device_id, operation, expires_at, max_bytes, state, owner_instance)
           VALUES ($1, $2, $3, $4, $5, $6, 'waiting', $7)`,
          [scope.sessionId, scope.storageHash, scope.deviceId, scope.op, scope.exp, scope.maxBytes, this.instanceId],
        );
      } else {
        const row = existing.rows[0];
        if (!row || row.storage_hash.trim() !== scope.storageHash || row.device_id !== scope.deviceId
          || row.operation !== scope.op || Number(row.expires_at) !== scope.exp
          || Number(row.max_bytes) !== scope.maxBytes) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "scope_mismatch" };
        }
        if (row.state === "closed") {
          await client.query("ROLLBACK");
          return { ok: false, reason: "closed" };
        }
        if (row.owner_instance !== this.instanceId) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "wrong_instance" };
        }
        state = row.state;
      }

      const sameRole = await client.query(
        "SELECT 1 FROM relay_ticket_claims WHERE session_id = $1 AND role = $2",
        [scope.sessionId, scope.role],
      );
      if (sameRole.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "duplicate_role" };
      }
      await client.query(
        "INSERT INTO relay_ticket_claims (ticket_id, session_id, role, expires_at) VALUES ($1, $2, $3, $4)",
        [scope.ticketId, scope.sessionId, scope.role, scope.exp],
      );
      const roles = await client.query<{ role: RelayRole }>(
        "SELECT role FROM relay_ticket_claims WHERE session_id = $1",
        [scope.sessionId],
      );
      if (roles.rows.length > 2) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "duplicate_role" };
      }
      if (roles.rows.length === 2) {
        if (roles.rows[0]?.role === roles.rows[1]?.role) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "duplicate_role" };
        }
        await client.query(
          "UPDATE relay_sessions SET state = 'paired', updated_at = now() WHERE session_id = $1",
          [scope.sessionId],
        );
        state = "paired";
      }
      await client.query("COMMIT");
      return { ok: true, state };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async accountBytes(input: {
    sessionId: string;
    sender: RelayRole;
    byteCount: number;
    now?: number;
  }): Promise<AccountResult> {
    if (!Number.isSafeInteger(input.byteCount) || input.byteCount < 1) {
      return { ok: false, reason: "invalid_byte_count" };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<SessionRow>(
        "SELECT * FROM relay_sessions WHERE session_id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = result.rows[0];
      if (!session || session.state === "closed") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "closed" };
      }
      if (Number(session.expires_at) <= (input.now ?? Math.floor(Date.now() / 1000))) {
        await client.query(
          "UPDATE relay_sessions SET state = 'closed', updated_at = now() WHERE session_id = $1",
          [input.sessionId],
        );
        await client.query("COMMIT");
        return { ok: false, reason: "closed" };
      }
      if (session.state !== "paired") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "not_paired" };
      }
      const expectedSender: RelayRole = session.operation === "get" ? "node" : "client";
      if (input.sender !== expectedSender) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "wrong_sender" };
      }
      const current = Number(session.bytes_forwarded);
      const ceiling = Number(session.max_bytes);
      if (current + input.byteCount > ceiling) {
        await client.query(
          "UPDATE relay_sessions SET state = 'closed', updated_at = now() WHERE session_id = $1",
          [input.sessionId],
        );
        await client.query("COMMIT");
        return { ok: false, reason: "size_exceeded" };
      }
      const totalBytes = current + input.byteCount;
      await client.query(
        `UPDATE relay_sessions
         SET bytes_forwarded = $2,
             state = CASE WHEN $2 = max_bytes THEN 'closed' ELSE state END,
             updated_at = now()
         WHERE session_id = $1`,
        [input.sessionId, totalBytes],
      );
      await client.query("COMMIT");
      return { ok: true, totalBytes, complete: totalBytes === ceiling };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      "UPDATE relay_sessions SET state = 'closed', updated_at = now() WHERE session_id = $1 AND state <> 'closed'",
      [sessionId],
    );
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original query failure is the useful error; a dead connection may
      // also reject the best-effort rollback.
    }
  }
}
