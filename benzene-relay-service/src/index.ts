import "dotenv/config";
import { Pool } from "pg";
import { createRelayServer } from "./relayServer.js";
import { validateRelayControlPlanePublicKey } from "./scope.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

const publicKey = required("RELAY_CONTROL_PLANE_PUBLIC_KEY");
validateRelayControlPlanePublicKey(publicKey);
const pool = new Pool({
  connectionString: required("DATABASE_URL"),
  max: positiveInteger("RELAY_DB_POOL_SIZE", 20, 200),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
const app = createRelayServer({
  host: process.env.RELAY_HOST?.trim() || "127.0.0.1",
  port: positiveInteger("RELAY_PORT", 8090, 65_535),
  publicKey,
  instanceId: required("RELAY_INSTANCE_ID"),
  maxSessions: positiveInteger("RELAY_MAX_SESSIONS", 1000, 100_000),
  maxFrameBytes: positiveInteger("RELAY_MAX_FRAME_BYTES", 64 * 1024, 64 * 1024),
  idleTimeoutMs: positiveInteger("RELAY_IDLE_TIMEOUT_MS", 30_000, 5 * 60_000),
  authTimeoutMs: positiveInteger("RELAY_AUTH_TIMEOUT_MS", 5_000, 30_000),
  pool,
  readinessCheck: async () => { await pool.query("SELECT 1"); },
});

await app.listen();
process.stdout.write(`Benzene relay listening on ${process.env.RELAY_HOST || "127.0.0.1"}:${process.env.RELAY_PORT || "8090"}\n`);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } finally {
    await pool.end();
  }
};

process.once("SIGINT", () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });
process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });
