import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresRelaySessionStore } from "./sessionStore.js";
import type { RelayScope } from "./scope.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const postgresDescribe = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = 1_800_000_000;

function scope(input: Partial<RelayScope> = {}): RelayScope {
  return {
    v: 1,
    sessionId: randomUUID(),
    ticketId: randomUUID(),
    storageHash: "d".repeat(64),
    deviceId: randomUUID(),
    op: "get",
    role: "node",
    exp: NOW + 60,
    maxBytes: 4,
    ...input,
  };
}

describe("relay claim-time expiry", () => {
  it("rechecks expiry after acquiring the transaction lock and before claiming state", async () => {
    const statements: string[] = [];
    const fakeClient = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined,
    };
    const fakePool = { connect: async () => fakeClient } as unknown as Pool;
    const store = new PostgresRelaySessionStore(fakePool, "relay-test", 1);

    await expect(store.claim(scope({ exp: NOW }), NOW)).resolves.toEqual({ ok: false, reason: "expired" });
    expect(statements).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock($1, $2)",
      "ROLLBACK",
    ]);
  });
});

postgresDescribe("Postgres relay claims", () => {
  let adminPool: Pool;
  let relayPool: Pool;
  let schemaName: string;
  let storeA: PostgresRelaySessionStore;
  let storeB: PostgresRelaySessionStore;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
    schemaName = `relay_test_${randomUUID().replace(/-/g, "")}`;
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    relayPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
      max: 10,
    });
    const migration = await readFile(new URL("../migrations/001_relay_sessions.sql", import.meta.url), "utf8");
    await relayPool.query(migration);
    storeA = new PostgresRelaySessionStore(relayPool, "relay-a", 2);
    storeB = new PostgresRelaySessionStore(relayPool, "relay-b", 2);
  });

  afterAll(async () => {
    if (relayPool) await relayPool.end();
    if (adminPool && schemaName) {
      await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  afterEach(async () => {
    if (relayPool) await relayPool.query("TRUNCATE relay_sessions CASCADE");
  });

  it("keeps ticket claims across store recreation and relay instances", async () => {
    const node = scope();
    const client = scope({ ...node, ticketId: randomUUID(), role: "client" });
    expect(await storeA.claim(node, NOW)).toEqual({ ok: true, state: "waiting" });

    const restartedStore = new PostgresRelaySessionStore(relayPool, "relay-a", 2);
    expect(await restartedStore.claim(node, NOW)).toEqual({ ok: false, reason: "replayed_ticket" });
    expect(await storeB.claim(client, NOW)).toEqual({ ok: false, reason: "wrong_instance" });
    expect(await storeA.claim(client, NOW)).toEqual({ ok: true, state: "paired" });
    expect(await storeB.claim(client, NOW)).toEqual({ ok: false, reason: "replayed_ticket" });
  });

  it("rejects a scope that expires while waiting for the serialized claim transaction", async () => {
    const expired = scope({ exp: NOW });
    expect(await storeA.claim(expired, NOW)).toEqual({ ok: false, reason: "expired" });
    const found = await relayPool.query("SELECT 1 FROM relay_sessions WHERE session_id = $1", [expired.sessionId]);
    expect(found.rowCount).toBe(0);
  });

  it("serializes duplicate role claims and enforces byte direction and limits", async () => {
    const node = scope({ maxBytes: 4 });
    const client = scope({ ...node, ticketId: randomUUID(), role: "client" });
    await storeA.claim(node, NOW);
    await storeA.claim(client, NOW);
    expect(await storeA.claim(scope({ ...node, ticketId: randomUUID() }), NOW))
      .toEqual({ ok: false, reason: "duplicate_role" });
    expect(await storeA.accountBytes({ sessionId: node.sessionId, sender: "client", byteCount: 1 }))
      .toEqual({ ok: false, reason: "wrong_sender" });
    expect(await storeA.accountBytes({ sessionId: node.sessionId, sender: "node", byteCount: 4 }))
      .toEqual({ ok: true, totalBytes: 4, complete: true });
    expect(await storeA.accountBytes({ sessionId: node.sessionId, sender: "node", byteCount: 1 }))
      .toEqual({ ok: false, reason: "closed" });
  });

  it("enforces the session cap shared by stores", async () => {
    const limitedStoreA = new PostgresRelaySessionStore(relayPool, "relay-cap-a", 1);
    const limitedStoreB = new PostgresRelaySessionStore(relayPool, "relay-cap-b", 1);
    const first = scope();
    const second = scope();
    expect(await limitedStoreA.claim(first, NOW)).toEqual({ ok: true, state: "waiting" });
    expect(await limitedStoreB.claim(second, NOW)).toEqual({ ok: false, reason: "capacity" });
  });
});
