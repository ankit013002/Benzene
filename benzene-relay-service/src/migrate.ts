import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const migrationPath = fileURLToPath(new URL("../migrations/001_relay_sessions.sql", import.meta.url));
const migrationSql = await readFile(migrationPath, "utf8");
const pool = new Pool({
  connectionString: required("DATABASE_URL"),
  max: 1,
  connectionTimeoutMillis: 5_000,
});

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize release jobs so two instances cannot race while applying DDL.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [194687492, 2]);
    await client.query(migrationSql);
    await client.query("COMMIT");
    process.stdout.write("Relay database migration applied successfully.\n");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
