import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  approveEnrollment,
  recordHeartbeat,
  requestEnrollment,
} from "../devices/devices.service.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import { GRANT_TEST_PRIVATE_KEY } from "./grantVectors.js";
import { confirmReplica, reservePlacement, setPolicy } from "./placement.service.js";
import { pollRepairForDevice } from "./repair.service.js";

const OWNER = "repair-owner";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function onlineDevice(
  name: string,
  advertisedUrl: string,
  usedBytes = 0,
  allocatedBytes = 10 * GB
): Promise<string> {
  const keys = await requestEnrollment({
    publicKey: generateDeviceKeyPair().publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(OWNER, keys.code, allocatedBytes);
  await recordHeartbeat(device.id, { advertisedUrl, usedBytes });
  return device.id;
}

beforeAll(async () => {
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] ??= "mongodb://127.0.0.1:27017/unused";
  process.env["TRANSFER_SIGNING_KEY"] = GRANT_TEST_PRIVATE_KEY;
  resetConfigCache();
  db = await setupTestDb();
}, 120_000);

afterAll(async () => {
  await teardownTestDb();
  delete process.env["TRANSFER_SIGNING_KEY"];
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await truncateAll(db);
});

describe("whole-file repair assignments", () => {
  it("assigns one healthy reachable source to an online target", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const objectHash = hashOf("repair payload");
    await setPolicy(OWNER, { mode: "protected" });
    await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });

    const assignment = await pollRepairForDevice(target);
    expect(assignment).toMatchObject({
      objectHash,
      sizeBytes: 14,
      source: { deviceId: source, url: `http://192.168.1.10:7070/objects/${objectHash}` },
    });
    expect(assignment?.source.grant).toBeTruthy();

    const rows = await db
      .select()
      .from(schema.replicas)
      .where(and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("placing");
  });

  it("returns the same durable work on a retry and does not duplicate rows", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const objectHash = hashOf("idempotent repair");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 17, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 17 });

    const first = await pollRepairForDevice(target);
    const second = await pollRepairForDevice(target);
    expect(second).toMatchObject({ objectHash, source: { deviceId: source } });
    expect(first?.source.url).toBe(second?.source.url);
    expect(
      await db
        .select()
        .from(schema.replicas)
        .where(eq(schema.replicas.objectHash, objectHash))
    ).toHaveLength(2);
  });

  it("counts another target's active reservation toward protection", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const firstTarget = await onlineDevice("first-target", "http://192.168.1.11:7070");
    const secondTarget = await onlineDevice("second-target", "http://192.168.1.12:7070");
    const objectHash = hashOf("active reservation");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 17, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 17 });

    await expect(pollRepairForDevice(firstTarget)).resolves.toMatchObject({ objectHash });
    await expect(pollRepairForDevice(secondTarget)).resolves.toBeNull();
    expect(
      await db
        .select()
        .from(schema.replicas)
        .where(eq(schema.replicas.objectHash, objectHash))
    ).toHaveLength(2);
  });

  it("expires an abandoned target reservation before selecting new work", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const abandonedTarget = await onlineDevice("abandoned-target", "http://192.168.1.11:7070");
    const retryTarget = await onlineDevice("retry-target", "http://192.168.1.12:7070");
    const objectHash = hashOf("abandoned reservation");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 21, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 21 });

    await expect(pollRepairForDevice(abandonedTarget)).resolves.toMatchObject({ objectHash });
    await db
      .update(schema.replicas)
      .set({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(
        and(
          eq(schema.replicas.objectHash, objectHash),
          eq(schema.replicas.deviceId, abandonedTarget)
        )
      );

    await expect(pollRepairForDevice(retryTarget)).resolves.toMatchObject({ objectHash });
    const rows = await db
      .select()
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(rows.map((row) => row.deviceId)).toEqual(
      expect.arrayContaining([source, retryTarget])
    );
    expect(rows.some((row) => row.deviceId === abandonedTarget)).toBe(false);
  });

  it("does not assign a corrupt source", async () => {
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const objectHash = hashOf("unusable source");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });

    await db
      .update(schema.replicas)
      .set({ status: "corrupt" })
      .where(eq(schema.replicas.deviceId, source));
    expect(await pollRepairForDevice(target)).toBeNull();
  });

  it("does not assign an offline source", async () => {
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const objectHash = hashOf("offline source");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });

    await db
      .update(schema.devices)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(schema.devices.id, source));

    expect(await pollRepairForDevice(target)).toBeNull();
  });

  it("does not assign a source without an advertised transfer URL", async () => {
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const objectHash = hashOf("unreachable source");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 18, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 18 });

    await db
      .update(schema.devices)
      .set({ advertisedUrl: null })
      .where(eq(schema.devices.id, source));

    expect(await pollRepairForDevice(target)).toBeNull();
  });

  it("does not assign a target with no remaining capacity", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("full-target", "http://192.168.1.11:7070", 10 * GB, 10 * GB);
    const objectHash = hashOf("full target");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });

    expect(await pollRepairForDevice(target)).toBeNull();
    expect(
      await db.select().from(schema.replicas).where(eq(schema.replicas.deviceId, target))
    ).toEqual([]);
  });
});
