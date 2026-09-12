import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { config, resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  approveEnrollment,
  beginDeviceRemoval,
  recordHeartbeat,
  requestEnrollment,
} from "../devices/devices.service.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import { reconcileDeviceInventory } from "../devices/inventory.service.js";
import { GRANT_TEST_PRIVATE_KEY } from "./grantVectors.js";
import {
  confirmReplica,
  confirmReplicaForDevice,
  reservePlacement,
  setPolicy,
} from "./placement.service.js";
import {
  pollRepairForDevice,
  reportRepairSourceFailure,
} from "./repair.service.js";

const OWNER = "repair-owner";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

async function onlineDevice(
  name: string,
  advertisedUrl: string,
  usedBytes = 0,
  allocatedBytes = 10 * GB,
  ownerId = OWNER
): Promise<string> {
  const keys = await requestEnrollment({
    publicKey: generateDeviceKeyPair().publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(ownerId, keys.code, allocatedBytes);
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
    expect(rows[0]).toMatchObject({ status: "placing", repairSourceDeviceId: source });
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

  it("refreshes a near-expiry retry before accepting its failure report", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const objectHash = hashOf("near expiry repair");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 17, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 17 });

    const first = await pollRepairForDevice(target);
    if (!first) throw new Error("Expected a repair assignment");
    await db
      .update(schema.replicas)
      .set({
        updatedAt: new Date(
          Date.now() - config().transferGrantTtlSeconds * 1000 + 1
        ),
      })
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );

    const retried = await pollRepairForDevice(target);
    expect(retried?.repairAssignmentId).toBe(first.repairAssignmentId);
    if (!retried) throw new Error("Expected the retry assignment");
    const [refreshed] = await db
      .select({ updatedAt: schema.replicas.updatedAt })
      .from(schema.replicas)
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );
    expect(refreshed).toBeDefined();
    expect(
      Math.floor((refreshed?.updatedAt.getTime() ?? 0) / 1000) +
        config().transferGrantTtlSeconds
    ).toBe(Math.floor(Date.parse(retried.source.expiresAt) / 1000));
    await expect(
      reportRepairSourceFailure(target, {
        objectHash,
        sourceDeviceId: source,
        repairAssignmentId: first.repairAssignmentId,
      })
    ).resolves.toMatchObject({ status: "corrupt" });
  });

  it("quarantines a corrupt source so the next repair poll tries another healthy device", async () => {
    const badSource = await onlineDevice("bad-source", "http://192.168.1.10:7070");
    const goodSource = await onlineDevice("good-source", "http://192.168.1.11:7070");
    const target = await onlineDevice("target", "http://192.168.1.12:7070");
    await setPolicy(OWNER, { mode: "highly_protected" });
    const objectHash = hashOf("source quarantine");
    for (const deviceId of [badSource, goodSource]) {
      await reservePlacement(OWNER, { objectHash, sizeBytes: 19, deviceIds: [deviceId] });
      await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 19 });
    }

    const first = await pollRepairForDevice(target);
    expect(first?.source.deviceId).toBe(badSource);
    if (!first) throw new Error("Expected a repair assignment");
    await expect(
      reportRepairSourceFailure(target, {
        objectHash,
        sourceDeviceId: goodSource,
        repairAssignmentId: first.repairAssignmentId,
      })
    ).rejects.toThrow(/does not match the active assignment/);
    await reportRepairSourceFailure(target, {
      objectHash,
      sourceDeviceId: badSource,
      repairAssignmentId: first.repairAssignmentId,
    });
    await expect(
      reportRepairSourceFailure(target, {
        objectHash,
        sourceDeviceId: badSource,
        repairAssignmentId: first.repairAssignmentId,
      })
    ).rejects.toThrow(/No active repair reservation|does not match/);

    const [badRow] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(
        and(
          eq(schema.replicas.objectHash, objectHash),
          eq(schema.replicas.deviceId, badSource)
        )
      );
    expect(badRow?.status).toBe("corrupt");
    const [targetRow] = await db
      .select({ status: schema.replicas.status, repairSourceDeviceId: schema.replicas.repairSourceDeviceId })
      .from(schema.replicas)
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );
    expect(targetRow).toMatchObject({ status: "missing", repairSourceDeviceId: null });

    const second = await pollRepairForDevice(target);
    expect(second?.source.deviceId).toBe(goodSource);
  });

  it("resets a repair bound to a returning source when an empty inventory omits the object", async () => {
    const missingSource = await onlineDevice("missing-source", "http://192.168.1.10:7070");
    const healthySource = await onlineDevice("healthy-source", "http://192.168.1.11:7070");
    const target = await onlineDevice("target", "http://192.168.1.12:7070");
    await setPolicy(OWNER, { mode: "highly_protected" });
    const objectHash = hashOf("returning source inventory");
    for (const deviceId of [missingSource, healthySource]) {
      await reservePlacement(OWNER, { objectHash, sizeBytes: 23, deviceIds: [deviceId] });
      await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 23 });
    }

    const first = await pollRepairForDevice(target);
    expect(first?.source.deviceId).toBe(missingSource);
    await db
      .update(schema.devices)
      .set({ status: "suspected_lost" })
      .where(eq(schema.devices.id, missingSource));

    await expect(reconcileDeviceInventory(missingSource, [])).resolves.toMatchObject({
      status: "online",
      reconciled: 0,
      missing: 1,
    });
    const [resetTarget] = await db
      .select({ status: schema.replicas.status, repairSourceDeviceId: schema.replicas.repairSourceDeviceId })
      .from(schema.replicas)
      .where(and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target)));
    expect(resetTarget).toEqual({ status: "missing", repairSourceDeviceId: null });

    const second = await pollRepairForDevice(target);
    expect(second?.source.deviceId).toBe(healthySource);
  });

  it("isolates an empty inventory from a malformed cross-vault repair binding", async () => {
    const source = await onlineDevice("source", "http://192.168.1.20:7070");
    const otherTarget = await onlineDevice(
      "other-vault-target",
      "http://192.168.1.21:7070",
      0,
      10 * GB,
      "other-owner"
    );
    const objectHash = hashOf("cross-vault inventory");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 29, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 29 });
    await reservePlacement("other-owner", { objectHash, sizeBytes: 29, deviceIds: [otherTarget] });
    await db
      .update(schema.replicas)
      .set({ repairSourceDeviceId: source })
      .where(and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, otherTarget)));
    await db
      .update(schema.devices)
      .set({ status: "suspected_lost" })
      .where(eq(schema.devices.id, source));

    await reconcileDeviceInventory(source, []);

    const [otherRow] = await db
      .select({
        status: schema.replicas.status,
        repairSourceDeviceId: schema.replicas.repairSourceDeviceId,
      })
      .from(schema.replicas)
      .where(and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, otherTarget)));
    expect(otherRow).toEqual({ status: "placing", repairSourceDeviceId: source });
  });

  it("serializes inventory omission with a concurrent source-failure report", async () => {
    const source = await onlineDevice("source", "http://192.168.1.30:7070");
    const target = await onlineDevice("target", "http://192.168.1.31:7070");
    const objectHash = hashOf("inventory source race");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 37, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 37 });

    const assignment = await pollRepairForDevice(target);
    if (!assignment) throw new Error("Expected a repair assignment");
    await db
      .update(schema.devices)
      .set({ status: "suspected_lost" })
      .where(eq(schema.devices.id, source));

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const outcomes = await Promise.race([
      Promise.allSettled([
        reconcileDeviceInventory(source, []),
        reportRepairSourceFailure(target, {
          objectHash,
          sourceDeviceId: source,
          repairAssignmentId: assignment.repairAssignmentId,
        }),
      ]),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("inventory/source-failure race timed out")),
          5_000
        );
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    expect(outcomes).toHaveLength(2);

    const [sourceRow] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, source)));
    const [targetRow] = await db
      .select({
        status: schema.replicas.status,
        repairSourceDeviceId: schema.replicas.repairSourceDeviceId,
        repairAssignmentId: schema.replicas.repairAssignmentId,
      })
      .from(schema.replicas)
      .where(and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target)));
    expect(sourceRow?.status).toBe("missing");
    expect(targetRow).toEqual({ status: "missing", repairSourceDeviceId: null, repairAssignmentId: null });
  });

  it("does not let a stale possession report resurrect a failed repair reservation", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const objectHash = hashOf("stale possession");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 16, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 16 });

    const assignment = await pollRepairForDevice(target);
    if (!assignment) throw new Error("Expected a repair assignment");

    // Hold the replica row while the failure report queues first. The old
    // read-then-update possession path could read `placing`, then wait behind
    // the failure report and promote its newly `missing` row to `healthy`.
    let releaseHolder: (() => void) | undefined;
    let signalLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.replicas.id })
        .from(schema.replicas)
        .where(
          and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
        )
        .for("update");
      signalLocked?.();
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });
    await locked;

    const failure = reportRepairSourceFailure(target, {
      objectHash,
      sourceDeviceId: source,
      repairAssignmentId: assignment.repairAssignmentId,
    });
    let possession: Promise<Awaited<ReturnType<typeof confirmReplicaForDevice>>> | undefined;
    try {
      await waitForLockWaiters(1);
      possession = confirmReplicaForDevice(target, { objectHash, sizeBytes: 16 });
      // Observe the possession request itself waiting on the same held row.
      // This proves its read happened before the holder is released, which is
      // what distinguishes the fixed locking path from the old stale read.
      await waitForLockWaiters(2);
    } finally {
      // Never leave the transaction holding the row lock if a barrier fails;
      // otherwise afterEach cannot truncate the test database.
      releaseHolder?.();
      await holder;
      await Promise.allSettled([failure, ...(possession ? [possession] : [])]);
    }

    await expect(failure).resolves.toMatchObject({ status: "corrupt" });
    if (!possession) throw new Error("Possession request was not started");
    await expect(possession).rejects.toThrow(/No placement reserved/);

    const [targetRow] = await db
      .select({ status: schema.replicas.status, repairAssignmentId: schema.replicas.repairAssignmentId })
      .from(schema.replicas)
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );
    expect(targetRow).toEqual({ status: "missing", repairAssignmentId: null });
  });

  it("does not reopen a failed target when active copies already satisfy policy", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const secondSource = await onlineDevice("second-source", "http://192.168.1.11:7070");
    const target = await onlineDevice("target", "http://192.168.1.12:7070");
    const objectHash = hashOf("failed target already protected");
    for (const deviceId of [source, secondSource]) {
      await reservePlacement(OWNER, { objectHash, sizeBytes: 31, deviceIds: [deviceId] });
      await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 31 });
    }
    await reservePlacement(OWNER, { objectHash, sizeBytes: 31, deviceIds: [target] });
    await db
      .update(schema.replicas)
      .set({ status: "corrupt" })
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );

    expect(await pollRepairForDevice(target)).toBeNull();
    const [stored] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );
    expect(stored?.status).toBe("corrupt");
  });

  it("rejects an old failure report after the same source is reassigned", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const objectHash = hashOf("assignment nonce");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 16, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 16 });

    const first = await pollRepairForDevice(target);
    if (!first) throw new Error("Expected the first repair assignment");
    await reportRepairSourceFailure(target, {
      objectHash,
      sourceDeviceId: source,
      repairAssignmentId: first.repairAssignmentId,
    });

    // Model a later integrity scrub restoring the source. The target is then
    // assigned the same source again, but with a fresh opaque assignment id.
    await db
      .update(schema.replicas)
      .set({ status: "healthy", verifiedAt: new Date() })
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, source))
      );
    const second = await pollRepairForDevice(target);
    if (!second) throw new Error("Expected the replacement repair assignment");
    expect(second.source.deviceId).toBe(source);
    expect(second.repairAssignmentId).not.toBe(first.repairAssignmentId);

    await expect(
      reportRepairSourceFailure(target, {
        objectHash,
        sourceDeviceId: source,
        repairAssignmentId: first.repairAssignmentId,
      })
    ).rejects.toThrow(/does not match the active assignment/);
    const [sourceRow] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, source))
      );
    expect(sourceRow?.status).toBe("healthy");
  });

  it("serializes a concurrent drain and repair poll on the target device", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const objectHash = hashOf("drain versus repair");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 18, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 18 });

    const [removal, assignment] = await Promise.all([
      beginDeviceRemoval(OWNER, target),
      pollRepairForDevice(target),
    ]);
    expect(removal.status).toBe("draining");

    const [storedTarget] = await db
      .select({ status: schema.devices.status, updatedAt: schema.devices.updatedAt })
      .from(schema.devices)
      .where(eq(schema.devices.id, target));
    const [repairRow] = await db
      .select({ status: schema.replicas.status, createdAt: schema.replicas.createdAt })
      .from(schema.replicas)
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );

    // If the poll won the lock first, its reservation is ordered before the
    // drain transition. It must never be created after the target is draining.
    if (assignment) {
      expect(repairRow?.status).toBe("placing");
      expect(repairRow?.createdAt.getTime()).toBeLessThanOrEqual(
        storedTarget?.updatedAt.getTime() ?? 0
      );
    } else {
      expect(repairRow).toBeUndefined();
    }
    expect(storedTarget?.status).toBe("draining");
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

  it("treats a draining copy as leaving and repairs it from that device", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070");
    const objectHash = hashOf("draining source");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await reservePlacement(OWNER, { objectHash, sizeBytes: 15, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 15 });

    await expect(beginDeviceRemoval(OWNER, source)).resolves.toMatchObject({
      status: "draining",
    });
    const assignment = await pollRepairForDevice(target);

    expect(assignment).toMatchObject({
      objectHash,
      source: { deviceId: source },
    });
    expect(
      await db
        .select()
        .from(schema.replicas)
        .where(and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target)))
    ).toHaveLength(1);
  });

  it("blocks removal when no online target can restore protection", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    await onlineDevice("full-target", "http://192.168.1.11:7070", 10 * GB, 10 * GB);
    const objectHash = hashOf("cannot drain");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });

    await expect(beginDeviceRemoval(OWNER, source)).rejects.toThrow(
      /Insufficient capacity/
    );
    const [device] = await db
      .select({ status: schema.devices.status })
      .from(schema.devices)
      .where(eq(schema.devices.id, source));
    expect(device?.status).toBe("online");
  });

  it("blocks removal when individual targets fit but cumulative capacity does not", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    await onlineDevice("small-target", "http://192.168.1.11:7070", 0, 14);
    const firstHash = hashOf("first object");
    const secondHash = hashOf("second object");
    for (const objectHash of [firstHash, secondHash]) {
      await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
      await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });
    }

    await expect(beginDeviceRemoval(OWNER, source)).rejects.toThrow(
      /Insufficient capacity/
    );
  });

  it("counts existing placing reservations against removal capacity", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070", 0, 14);
    await onlineDevice("backup", "http://192.168.1.12:7070", 0, 14);
    const existingHash = hashOf("existing placement");
    const leavingHash = hashOf("leaving placement");
    await reservePlacement(OWNER, { objectHash: existingHash, sizeBytes: 14, deviceIds: [target] });
    await reservePlacement(OWNER, { objectHash: leavingHash, sizeBytes: 14, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash: leavingHash, deviceId: source, sizeBytes: 14 });

    await expect(beginDeviceRemoval(OWNER, source)).rejects.toThrow(
      /Insufficient capacity/
    );
  });

  it("does not assign a second repair while a target has no free space left", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070", 0, 14);
    const [queuedHash, reservedHash] = [hashOf("repair one"), hashOf("repair two")].sort();
    for (const objectHash of [queuedHash, reservedHash]) {
      await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
      await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });
    }
    // Keep the higher-sorted object in flight so polling the lower one must
    // account for this active reservation before creating another target row.
    await reservePlacement(OWNER, { objectHash: reservedHash, sizeBytes: 14, deviceIds: [target] });

    // The poll may retry the existing durable reservation. It must not create
    // a second reservation for the queued object while the target is full.
    await expect(pollRepairForDevice(target)).resolves.toMatchObject({
      objectHash: reservedHash,
    });
    const targetRows = await db
      .select()
      .from(schema.replicas)
      .where(eq(schema.replicas.deviceId, target));
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]?.objectHash).toBe(reservedHash);
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

  it("reopens an exact-size corrupt target even when the allocation is full", async () => {
    const source = await onlineDevice("source", "http://192.168.1.10:7070");
    const target = await onlineDevice("target", "http://192.168.1.11:7070", 0, 14);
    const objectHash = hashOf("full corrupt target");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [source] });
    await confirmReplica(OWNER, { objectHash, deviceId: source, sizeBytes: 14 });
    await reservePlacement(OWNER, { objectHash, sizeBytes: 14, deviceIds: [target] });
    await db
      .update(schema.replicas)
      .set({ status: "corrupt", verifiedAt: new Date(Date.now() - 2000) })
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );
    await recordHeartbeat(target, { usedBytes: 14 });

    const assignment = await pollRepairForDevice(target);
    expect(assignment).toMatchObject({ objectHash, sizeBytes: 14, source: { deviceId: source } });
    const [row] = await db
      .select({ status: schema.replicas.status, sizeBytes: schema.replicas.sizeBytes })
      .from(schema.replicas)
      .where(
        and(eq(schema.replicas.objectHash, objectHash), eq(schema.replicas.deviceId, target))
      );
    expect(row).toMatchObject({ status: "placing", sizeBytes: 14 });
  });
});
