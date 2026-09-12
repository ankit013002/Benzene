import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  approveEnrollment,
  classifyDeviceOutages,
  listDevices,
  recordHeartbeat,
  requestEnrollment,
} from "./devices.service.js";
import { generateDeviceKeyPair } from "./deviceIdentity.js";
import {
  confirmReplica,
  getObjectProtection,
  listUnderProtectedObjects,
  reservePlacement,
  setPolicy,
} from "../placement/placement.service.js";
import { generateTransferSigningKeys } from "../placement/transferGrant.js";
import { planDownload } from "../placement/uploadTargets.service.js";

const OWNER = "auth|outage-owner";
const OFFLINE_SECONDS = 10;
const EXTENDED_SECONDS = 20;
const LOST_SECONDS = 30;

let db: NodePgDatabase<typeof schema>;
let databaseReady = false;

async function onlineDevice(name: string): Promise<string> {
  const keys = generateDeviceKeyPair();
  const enrollment = await requestEnrollment({
    publicKey: keys.publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(OWNER, enrollment.code, 1_000_000);
  await recordHeartbeat(device.id, { usedBytes: 0, advertisedUrl: `http://${name}.test` });
  return device.id;
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Observe PostgreSQL's lock queue instead of guessing with a timer. */
async function waitForLockWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await db.execute(sql`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event_type = 'Lock'
    `);
    const row = result.rows[0];
    if (Number(row?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} PostgreSQL lock waiter(s)`);
}

beforeAll(async () => {
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] ??= "mongodb://127.0.0.1:27017/unused";
  vi.stubEnv("DEVICE_OFFLINE_AFTER_SECONDS", String(OFFLINE_SECONDS));
  vi.stubEnv("DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS", String(EXTENDED_SECONDS));
  vi.stubEnv("DEVICE_SUSPECTED_LOST_AFTER_SECONDS", String(LOST_SECONDS));
  vi.stubEnv("TRANSFER_SIGNING_KEY", generateTransferSigningKeys().privateKey);
  resetConfigCache();
  db = await setupTestDb();
  databaseReady = true;
}, 120_000);

afterEach(async () => {
  vi.useRealTimers();
  if (databaseReady) await truncateAll(db);
});

afterAll(async () => {
  if (databaseReady) await teardownTestDb();
  vi.unstubAllEnvs();
  resetConfigCache();
}, 60_000);

describe("automatic device outage classification", () => {
  it("moves a quiet device through offline and extended-offline without declaring loss", async () => {
    const deviceId = await onlineDevice("quiet");
    const seenAt = Date.now();

    vi.setSystemTime(seenAt + (OFFLINE_SECONDS + 1) * 1000);
    await classifyDeviceOutages();
    expect((await listDevices(OWNER))[0]?.status).toBe("offline");

    vi.setSystemTime(seenAt + (EXTENDED_SECONDS + 1) * 1000);
    await classifyDeviceOutages();
    expect((await listDevices(OWNER))[0]?.status).toBe("extended_offline");

    const [stored] = await db
      .select({ status: schema.devices.status })
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId));
    expect(stored?.status).toBe("extended_offline");
  });

  it("keeps offline and extended-offline replicas durable but unavailable for download", async () => {
    const deviceId = await onlineDevice("unavailable");
    const objectHash = hashOf("offline durable object");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await reservePlacement(OWNER, { objectHash, sizeBytes: 10, deviceIds: [deviceId] });
    await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 10 });
    const seenAt = Date.now();

    vi.setSystemTime(seenAt + (OFFLINE_SECONDS + 1) * 1000);
    expect((await getObjectProtection(OWNER, objectHash)).healthyReplicas).toBe(1);
    expect(await planDownload(OWNER, objectHash)).toEqual([]);

    vi.setSystemTime(seenAt + (EXTENDED_SECONDS + 1) * 1000);
    expect((await getObjectProtection(OWNER, objectHash)).healthyReplicas).toBe(1);
    expect(await planDownload(OWNER, objectHash)).toEqual([]);
    const [replica] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(eq(schema.replicas.deviceId, deviceId));
    expect(replica?.status).toBe("healthy");
  });

  it("classifies the same stale device only once", async () => {
    const deviceId = await onlineDevice("idempotent");
    const [device] = await db
      .select({ vaultId: schema.devices.vaultId })
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId));
    if (!device) throw new Error("Expected device");
    const staleAt = Date.now() + (LOST_SECONDS + 1) * 1000;

    const first = await classifyDeviceOutages(device.vaultId, staleAt);
    const [afterFirst] = await db
      .select({ status: schema.devices.status, updatedAt: schema.devices.updatedAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId));
    const second = await classifyDeviceOutages(device.vaultId, staleAt);
    const [afterSecond] = await db
      .select({ status: schema.devices.status, updatedAt: schema.devices.updatedAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId));

    expect(first.suspectedLost).toBe(1);
    expect(second.suspectedLost).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("serializes a heartbeat with classification under the device row lock", async () => {
    const deviceId = await onlineDevice("contended");
    const seenAt = Date.now();
    vi.setSystemTime(seenAt + (LOST_SECONDS + 1) * 1000);

    let release!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.devices.id })
        .from(schema.devices)
        .where(eq(schema.devices.id, deviceId))
        .for("update");
      locked();
      await hold;
    });
    await lockReady;

    // The classifier queues first on the held device row. The heartbeat then
    // queues behind it, proving PostgreSQL serializes the state transition
    // rather than relying on a timing race.
    const classified = classifyDeviceOutages(undefined, Date.now());
    await waitForLockWaiters(1);
    const heartbeat = recordHeartbeat(deviceId, { usedBytes: 1 });
    await waitForLockWaiters(2);
    release();
    await Promise.all([holder, classified, heartbeat]);

    const [device] = await db
      .select({ status: schema.devices.status, lastSeenAt: schema.devices.lastSeenAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId));
    expect(device?.status).toBe("suspected_lost");
    expect(device?.lastSeenAt?.getTime()).toBe(seenAt + (LOST_SECONDS + 1) * 1000);
  });

  it("quarantines presumed loss, leaves replica metadata intact, and exposes a shortfall", async () => {
    const lost = await onlineDevice("lost");
    const keeper = await onlineDevice("keeper");
    const objectHash = hashOf("outage object");
    await setPolicy(OWNER, { mode: "protected" });
    await reservePlacement(OWNER, { objectHash, sizeBytes: 10, deviceIds: [lost, keeper] });
    await confirmReplica(OWNER, { objectHash, deviceId: lost, sizeBytes: 10 });
    await confirmReplica(OWNER, { objectHash, deviceId: keeper, sizeBytes: 10 });

    vi.setSystemTime(Date.now() + (LOST_SECONDS + 1) * 1000);
    const protection = await getObjectProtection(OWNER, objectHash);

    expect(protection.healthyReplicas).toBe(1);
    expect((await listUnderProtectedObjects(OWNER)).map((row) => row.objectHash)).toEqual([
      objectHash,
    ]);
    const [lostDevice] = await db
      .select({ status: schema.devices.status })
      .from(schema.devices)
      .where(eq(schema.devices.id, lost));
    const [lostReplica] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(eq(schema.replicas.deviceId, lost));
    expect(lostDevice?.status).toBe("suspected_lost");
    expect(lostReplica?.status).toBe("healthy");

    await recordHeartbeat(lost, { usedBytes: 10 });
    expect((await listDevices(OWNER)).find((row) => row.id === lost)?.status).toBe(
      "suspected_lost"
    );
  });
});
