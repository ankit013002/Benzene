import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

import { setDb } from "../db/client.js";
import * as schema from "../db/schema.js";

/**
 * Tests run against a real PostgreSQL instance rather than a fake.
 *
 * The behaviour under test lives largely in the database — partial unique
 * indexes, foreign keys, `for update` locking, aggregate filters — none of
 * which an in-memory substitute reproduces faithfully. A test that passes
 * against a fake and fails against Postgres is worse than no test.
 *
 * Each test file gets its own throwaway database. Vitest runs files in
 * parallel, and sharing one database means each file's cleanup truncates
 * another file's fixtures mid-run.
 */

let pool: Pool | undefined;
let createdDatabase: string | undefined;

function baseUrl(): string {
  const url = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL (or DATABASE_URL) must point at a PostgreSQL server"
    );
  }
  return url;
}

/** Same server, different database — used to CREATE/DROP the per-file one. */
function urlForDatabase(name: string): string {
  const url = new URL(baseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlForDatabase("postgres") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function setupTestDb(): Promise<NodePgDatabase<typeof schema>> {
  createdDatabase = `benzene_test_${randomBytes(6).toString("hex")}`;

  await withAdminClient(async (client) => {
    // Identifier, not a value, so it cannot be parameterised — the name is
    // generated here from hex, never from input.
    await client.query(`create database "${createdDatabase}"`);
  });

  pool = new Pool({ connectionString: urlForDatabase(createdDatabase), max: 5 });
  const db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: "./drizzle" });
  setDb(db);
  return db;
}

export async function teardownTestDb(): Promise<void> {
  setDb(undefined);
  await pool?.end();
  pool = undefined;

  if (createdDatabase) {
    const name = createdDatabase;
    createdDatabase = undefined;
    await withAdminClient(async (client) => {
      // FORCE terminates any connection the pool has not finished closing.
      await client.query(`drop database if exists "${name}" with (force)`);
    });
  }
}

/**
 * Truncating with CASCADE and restarting identities gives each test a clean
 * slate without paying to re-run migrations between them.
 */
export async function truncateAll(
  db: NodePgDatabase<typeof schema>
): Promise<void> {
  await db.execute(
    sql`truncate table
      ${schema.deviceRequestReplays},
      ${schema.replicas},
      ${schema.storagePolicies},
      ${schema.deviceEnrollments},
      ${schema.deviceStorageAllocations},
      ${schema.devices},
      ${schema.vaults}
      restart identity cascade`
  );
}
