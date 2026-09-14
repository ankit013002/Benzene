import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  approveEnrollment,
  beginDeviceRemoval,
  recordHeartbeat,
  requestEnrollment,
} from "../devices/devices.service.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import { ensureVaultForOwner } from "../vaults/vaults.service.js";
import { pollGarbageCollection } from "./garbageCollection.service.js";
import {
  confirmReplica,
  confirmReplicaForDevice,
  reservePlacement,
  setPolicy,
} from "./placement.service.js";
import {
  completeRebalancingDeletion,
  pollRebalancingForDevice,
} from "./rebalancing.service.js";
import { reportRepairSourceFailure } from "./repair.service.js";
import { GRANT_TEST_PRIVATE_KEY } from "./grantVectors.js";

const OWNER = "rebalance-owner";
const ALLOCATION = 1_000;
let db: NodePgDatabase<typeof schema>;

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function onlineDevice(name: string, usedBytes: number): Promise<string> {
  const ticket = await requestEnrollment({
    publicKey: generateDeviceKeyPair().publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(OWNER, ticket.code, ALLOCATION);
  await recordHeartbeat(device.id, {
    usedBytes,
    advertisedUrl: `http://${name}.lan:7070`,
  });
  return device.id;
}

async function referencedReplica(
  deviceId: string,
  objectHash: string,
  sizeBytes: number
): Promise<void> {
  const vault = await ensureVaultForOwner(OWNER);
  await db.insert(schema.objectReferences).values({
    versionId: `version-${objectHash}`,
    vaultId: vault.id,
    objectHash,
  });
  await reservePlacement(OWNER, { objectHash, sizeBytes, deviceIds: [deviceId] });
  await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes });
}

beforeAll(async () => {
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] ??= "mongodb://127.0.0.1:27017/unused";
  process.env["TRANSFER_SIGNING_KEY"] = GRANT_TEST_PRIVATE_KEY;
  process.env["REBALANCE_INTERVAL_SECONDS"] = "300";
  process.env["REBALANCE_MIN_USAGE_DELTA_PERCENT"] = "10";
  resetConfigCache();
  db = await setupTestDb();
}, 120_000);

afterAll(async () => {
  await teardownTestDb();
  delete process.env["TRANSFER_SIGNING_KEY"];
  delete process.env["REBALANCE_INTERVAL_SECONDS"];
  delete process.env["REBALANCE_MIN_USAGE_DELTA_PERCENT"];
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await truncateAll(db);
});

describe("whole-file rebalancing", () => {
  it("copies before issuing a durable exact deletion for the old source", async () => {
    const source = await onlineDevice("full", 700);
    const target = await onlineDevice("empty", 100);
    const objectHash = hashOf("move me");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await referencedReplica(source, objectHash, 200);

    const first = await pollRebalancingForDevice(target);
    expect(first).toMatchObject({
      action: "copy",
      objectHash,
      sizeBytes: 200,
      source: { deviceId: source },
    });
    const retried = await pollRebalancingForDevice(target);
    expect(retried).toMatchObject({
      action: "copy",
      assignmentId: first?.assignmentId,
    });

    await confirmReplicaForDevice(target, { objectHash, sizeBytes: 200 });
    const rowsAfterCopy = await db
      .select({
        deviceId: schema.replicas.deviceId,
        status: schema.replicas.status,
        assignmentId: schema.replicas.rebalanceAssignmentId,
      })
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(rowsAfterCopy).toEqual(
      expect.arrayContaining([
        { deviceId: target, status: "healthy", assignmentId: null },
        { deviceId: source, status: "deleting", assignmentId: first?.assignmentId },
      ])
    );

    const deletion = await pollRebalancingForDevice(source);
    expect(deletion).toEqual({
      action: "delete",
      objectHash,
      assignmentId: first?.assignmentId,
    });
    await expect(pollRebalancingForDevice(source)).resolves.toEqual(deletion);
    if (!deletion) throw new Error("Expected deletion assignment");
    await expect(
      completeRebalancingDeletion(source, {
        objectHash,
        assignmentId: "11111111-1111-4111-8111-111111111111",
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      completeRebalancingDeletion(source, deletion)
    ).resolves.toEqual({ status: "deleted" });

    const finalRows = await db
      .select({ deviceId: schema.replicas.deviceId, status: schema.replicas.status })
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(finalRows).toEqual([{ deviceId: target, status: "healthy" }]);
  });

  it("admits at most one new move per vault during the configured interval", async () => {
    const source = await onlineDevice("full", 600);
    const target = await onlineDevice("empty", 0);
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const firstHash = hashOf("first move");
    await referencedReplica(source, firstHash, 100);

    const first = await pollRebalancingForDevice(target);
    if (!first || first.action !== "copy") throw new Error("Expected copy assignment");
    await confirmReplicaForDevice(target, { objectHash: firstHash, sizeBytes: 100 });
    const deletion = await pollRebalancingForDevice(source);
    if (!deletion || deletion.action !== "delete") throw new Error("Expected deletion");
    await completeRebalancingDeletion(source, deletion);

    const secondHash = hashOf("second move");
    await referencedReplica(source, secondHash, 100);
    await expect(pollRebalancingForDevice(target)).resolves.toBeNull();
    expect(
      await db
        .select({ lastRebalancedAt: schema.vaults.lastRebalancedAt })
        .from(schema.vaults)
    ).toEqual([{ lastRebalancedAt: expect.any(Date) }]);
  });

  it("prioritizes an under-protected object over capacity balance", async () => {
    const source = await onlineDevice("full", 700);
    const target = await onlineDevice("empty", 100);
    const objectHash = hashOf("needs protection");
    await setPolicy(OWNER, { mode: "protected" });
    await referencedReplica(source, objectHash, 100);

    await expect(pollRebalancingForDevice(target)).resolves.toBeNull();
    expect(
      await db
        .select()
        .from(schema.replicas)
        .where(eq(schema.replicas.objectHash, objectHash))
    ).toHaveLength(1);
  });

  it("keeps garbage collection out of an active copy-then-delete move", async () => {
    const source = await onlineDevice("full", 700);
    const target = await onlineDevice("empty", 100);
    const objectHash = hashOf("purged during move");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await referencedReplica(source, objectHash, 100);
    const assignment = await pollRebalancingForDevice(target);
    expect(assignment?.action).toBe("copy");

    await db
      .delete(schema.objectReferences)
      .where(eq(schema.objectReferences.objectHash, objectHash));
    await expect(pollGarbageCollection(source)).resolves.toBeNull();
  });

  it("cancels the move and quarantines a corrupt source", async () => {
    const source = await onlineDevice("full", 700);
    const target = await onlineDevice("empty", 100);
    const objectHash = hashOf("corrupt during move");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await referencedReplica(source, objectHash, 100);
    const assignment = await pollRebalancingForDevice(target);
    if (!assignment || assignment.action !== "copy") {
      throw new Error("Expected copy assignment");
    }

    await reportRepairSourceFailure(target, {
      objectHash,
      sourceDeviceId: source,
      repairAssignmentId: assignment.assignmentId,
    });
    const rows = await db
      .select({
        deviceId: schema.replicas.deviceId,
        status: schema.replicas.status,
        rebalanceAssignmentId: schema.replicas.rebalanceAssignmentId,
      })
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(rows).toEqual(
      expect.arrayContaining([
        { deviceId: source, status: "corrupt", rebalanceAssignmentId: null },
        { deviceId: target, status: "missing", rebalanceAssignmentId: null },
      ])
    );
  });

  it("cancels a target copy when that destination begins draining", async () => {
    const source = await onlineDevice("full", 700);
    const target = await onlineDevice("empty", 100);
    const objectHash = hashOf("draining target");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await referencedReplica(source, objectHash, 100);
    expect((await pollRebalancingForDevice(target))?.action).toBe("copy");

    await beginDeviceRemoval(OWNER, target);

    expect(
      await db
        .select()
        .from(schema.replicas)
        .where(
          and(
            eq(schema.replicas.objectHash, objectHash),
            eq(schema.replicas.deviceId, target)
          )
        )
    ).toEqual([]);
    await expect(
      confirmReplicaForDevice(target, { objectHash, sizeBytes: 100 })
    ).rejects.toMatchObject({ status: 404 });
  });
});
