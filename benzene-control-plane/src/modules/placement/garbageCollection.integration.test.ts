import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import { deleteNode } from "../../services/driveNodes.services.js";
import { reserveDeviceUpload } from "../../services/uploads.services.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  approveEnrollment,
  recordHeartbeat,
  requestEnrollment,
  setAllocation,
} from "../devices/devices.service.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import { GRANT_TEST_PRIVATE_KEY } from "./grantVectors.js";
import {
  completeGarbageCollection,
  pollGarbageCollection,
  registerObjectReference,
  releaseObjectReferences,
} from "./garbageCollection.service.js";
import { confirmReplica, reservePlacement } from "./placement.service.js";
import { pollRepairForDevice } from "./repair.service.js";

const OWNER = "garbage-collection-owner";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;
let mongo: MongoMemoryServer;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function onlineDevice(name = "collector"): Promise<string> {
  const enrollment = await requestEnrollment({
    publicKey: generateDeviceKeyPair().publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(OWNER, enrollment.code, GB);
  await recordHeartbeat(device.id, {
    advertisedUrl: "http://192.168.1.10:7070",
    usedBytes: 0,
  });
  return device.id;
}

async function healthyReplica(deviceId: string, objectHash: string): Promise<void> {
  await reservePlacement(OWNER, {
    objectHash,
    sizeBytes: 12,
    deviceIds: [deviceId],
  });
  await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 12 });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] = mongo.getUri();
  process.env["TRANSFER_SIGNING_KEY"] = GRANT_TEST_PRIVATE_KEY;
  process.env["STORAGE_DRIVER"] = "local";
  resetConfigCache();
  db = await setupTestDb();
  await mongoose.connect(mongo.getUri());
  await FileVersionModel.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await teardownTestDb();
  delete process.env["TRANSFER_SIGNING_KEY"];
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await FileVersionModel.deleteMany({});
  await truncateAll(db);
});

describe("reference-safe device garbage collection", () => {
  it("never assigns an object while a logical version references it", async () => {
    const deviceId = await onlineDevice();
    const objectHash = hashOf("still referenced");
    await healthyReplica(deviceId, objectHash);
    await registerObjectReference(OWNER, {
      versionId: new Types.ObjectId().toString(),
      objectHash,
    });

    await expect(pollGarbageCollection(deviceId)).resolves.toBeNull();

    const [replica] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(replica?.status).toBe("healthy");
  });

  it("waits for the final deduplicated reference before assigning deletion", async () => {
    const deviceId = await onlineDevice();
    const objectHash = hashOf("shared content");
    await healthyReplica(deviceId, objectHash);
    const firstVersion = new Types.ObjectId().toString();
    const secondVersion = new Types.ObjectId().toString();
    await registerObjectReference(OWNER, { versionId: firstVersion, objectHash });
    await registerObjectReference(OWNER, { versionId: secondVersion, objectHash });

    await releaseObjectReferences(OWNER, [firstVersion]);
    await expect(pollGarbageCollection(deviceId)).resolves.toBeNull();

    await releaseObjectReferences(OWNER, [secondVersion]);
    await expect(pollGarbageCollection(deviceId)).resolves.toMatchObject({
      objectHash,
    });
  });

  it("retries one durable assignment and accepts only its exact acknowledgement", async () => {
    const deviceId = await onlineDevice();
    const objectHash = hashOf("unreferenced bytes");
    await healthyReplica(deviceId, objectHash);

    const first = await pollGarbageCollection(deviceId);
    const retry = await pollGarbageCollection(deviceId);
    expect(first).toMatchObject({ objectHash });
    expect(retry).toEqual(first);
    if (!first) throw new Error("Expected a garbage-collection assignment");

    await expect(
      completeGarbageCollection(deviceId, {
        objectHash,
        assignmentId: "11111111-1111-4111-8111-111111111111",
      })
    ).rejects.toThrow(/does not match/);

    const [stillDeleting] = await db
      .select({ status: schema.replicas.status })
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(stillDeleting?.status).toBe("deleting");

    await expect(completeGarbageCollection(deviceId, first)).resolves.toEqual({
      status: "deleted",
    });
    expect(
      await db
        .select()
        .from(schema.replicas)
        .where(eq(schema.replicas.objectHash, objectHash))
    ).toEqual([]);
  });

  it("blocks stale placement and possession until deletion finishes", async () => {
    const deviceId = await onlineDevice();
    const objectHash = hashOf("delete versus upload");
    await healthyReplica(deviceId, objectHash);
    const assignment = await pollGarbageCollection(deviceId);
    if (!assignment) throw new Error("Expected a garbage-collection assignment");

    await expect(
      reservePlacement(OWNER, { objectHash, sizeBytes: 12, deviceIds: [deviceId] })
    ).rejects.toThrow(/cleanup is still finishing/);
    await expect(
      confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 12 })
    ).rejects.toThrow(/No placement reserved/);
    await expect(setAllocation(OWNER, deviceId, 0)).rejects.toThrow(
      /already storing 12 bytes/
    );

    await completeGarbageCollection(deviceId, assignment);
    await expect(
      reservePlacement(OWNER, { objectHash, sizeBytes: 12, deviceIds: [deviceId] })
    ).resolves.toHaveLength(1);
  });

  it("backfills pre-registry Mongo versions instead of deleting their replicas", async () => {
    const deviceId = await onlineDevice();
    const objectHash = hashOf("legacy reference");
    const versionId = new Types.ObjectId();
    await FileVersionModel.create({
      _id: versionId,
      nodeId: new Types.ObjectId(),
      ownerId: OWNER,
      version: 1,
      bytes: 12,
      objectHash,
      sha256: objectHash,
      status: "committed",
      uploadedBy: OWNER,
      isCurrent: true,
    });
    await healthyReplica(deviceId, objectHash);

    await expect(pollGarbageCollection(deviceId)).resolves.toBeNull();

    const [reference] = await db
      .select()
      .from(schema.objectReferences)
      .where(eq(schema.objectReferences.versionId, versionId.toString()));
    expect(reference).toMatchObject({ objectHash });
  });

  it("turns an explicit device-backed purge into bounded deletion work", async () => {
    const deviceId = await onlineDevice();
    const body = "purged device bytes";
    const objectHash = hashOf(body);
    const reservation = await reserveDeviceUpload(OWNER, {
      name: "purge-me.txt",
      path: "",
      size: Buffer.byteLength(body),
      contentType: "text/plain",
      sha256: objectHash,
    });
    await confirmReplica(OWNER, {
      objectHash,
      deviceId,
      sizeBytes: Buffer.byteLength(body),
    });

    const [before] = await db
      .select()
      .from(schema.objectReferences)
      .where(
        and(
          eq(schema.objectReferences.versionId, reservation.versionId),
          eq(schema.objectReferences.objectHash, objectHash)
        )
      );
    expect(before).toBeDefined();

    await deleteNode(OWNER, reservation.nodeId, { purge: true });

    expect(
      await db
        .select()
        .from(schema.objectReferences)
        .where(eq(schema.objectReferences.versionId, reservation.versionId))
    ).toEqual([]);
    await expect(pollGarbageCollection(deviceId)).resolves.toMatchObject({
      objectHash,
    });
  });

  it("suppresses repair until every device acknowledges physical deletion", async () => {
    const firstDevice = await onlineDevice("first collector");
    const secondDevice = await onlineDevice("second collector");
    const objectHash = hashOf("two stale copies");
    await healthyReplica(firstDevice, objectHash);
    await healthyReplica(secondDevice, objectHash);

    const firstAssignment = await pollGarbageCollection(firstDevice);
    if (!firstAssignment) throw new Error("Expected the first GC assignment");
    await completeGarbageCollection(firstDevice, firstAssignment);

    await expect(pollRepairForDevice(firstDevice)).resolves.toBeNull();
    const rowsDuringSweep = await db
      .select({
        deviceId: schema.replicas.deviceId,
        status: schema.replicas.status,
        assignmentId: schema.replicas.garbageCollectionAssignmentId,
      })
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(rowsDuringSweep).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: firstDevice,
          status: "missing",
          assignmentId: firstAssignment.assignmentId,
        }),
        expect.objectContaining({
          deviceId: secondDevice,
          status: "healthy",
          assignmentId: null,
        }),
      ])
    );

    const secondAssignment = await pollGarbageCollection(secondDevice);
    if (!secondAssignment) throw new Error("Expected the second GC assignment");
    await completeGarbageCollection(secondDevice, secondAssignment);
    expect(
      await db
        .select()
        .from(schema.replicas)
        .where(eq(schema.replicas.objectHash, objectHash))
    ).toEqual([]);
  });

  it("stops a multi-device sweep when the object becomes referenced again", async () => {
    const deletedDevice = await onlineDevice("deleted copy");
    const survivingDevice = await onlineDevice("surviving copy");
    const objectHash = hashOf("referenced during cleanup");
    await healthyReplica(deletedDevice, objectHash);
    await healthyReplica(survivingDevice, objectHash);

    const assignment = await pollGarbageCollection(deletedDevice);
    if (!assignment) throw new Error("Expected a GC assignment");
    await completeGarbageCollection(deletedDevice, assignment);
    await registerObjectReference(OWNER, {
      versionId: new Types.ObjectId().toString(),
      objectHash,
    });

    await expect(pollGarbageCollection(survivingDevice)).resolves.toBeNull();
    await expect(pollRepairForDevice(deletedDevice)).resolves.toMatchObject({
      objectHash,
      source: { deviceId: survivingDevice },
    });
  });

  it("finishes an in-flight delete safely when a reference arrives", async () => {
    const deletingDevice = await onlineDevice("in-flight deletion");
    const survivingDevice = await onlineDevice("still healthy");
    const objectHash = hashOf("reference races acknowledgement");
    await healthyReplica(deletingDevice, objectHash);
    await healthyReplica(survivingDevice, objectHash);

    const assignment = await pollGarbageCollection(deletingDevice);
    if (!assignment) throw new Error("Expected a GC assignment");
    await registerObjectReference(OWNER, {
      versionId: new Types.ObjectId().toString(),
      objectHash,
    });
    await completeGarbageCollection(deletingDevice, assignment);

    const rows = await db
      .select({
        deviceId: schema.replicas.deviceId,
        status: schema.replicas.status,
        assignmentId: schema.replicas.garbageCollectionAssignmentId,
      })
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: deletingDevice,
          status: "missing",
          assignmentId: null,
        }),
        expect.objectContaining({
          deviceId: survivingDevice,
          status: "healthy",
          assignmentId: null,
        }),
      ])
    );
    await expect(pollGarbageCollection(survivingDevice)).resolves.toBeNull();
  });
});
