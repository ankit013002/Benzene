import { createHash } from "node:crypto";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import type { Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config/env.js";
import * as schema from "../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../test/postgres.js";
import { generateDeviceKeyPair } from "../modules/devices/deviceIdentity.js";
import {
  approveEnrollment,
  recordHeartbeat,
  requestEnrollment,
} from "../modules/devices/devices.service.js";
import { confirmReplicaForDevice } from "../modules/placement/placement.service.js";
import { GRANT_TEST_PRIVATE_KEY } from "../modules/placement/grantVectors.js";
import DriveNodeModel from "../models/driveNode.model.js";
import FileVersionModel from "../models/fileVersion.model.js";

const OWNER = "device-upload-owner";
const OTHER_OWNER = "other-device-upload-owner";

let mongo: MongoMemoryServer;
let db: NodePgDatabase<typeof schema>;
let app: Express;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function deviceFor(ownerId: string): Promise<{ id: string }> {
  const keys = generateDeviceKeyPair();
  const enrollment = await requestEnrollment({
    publicKey: keys.publicKey,
    deviceName: "Device upload test node",
    platform: "linux",
  });
  const device = await approveEnrollment(ownerId, enrollment.code, 100 * 1024 * 1024);
  await recordHeartbeat(device.id, { advertisedUrl: "http://192.168.1.10:7070" });
  return { id: device.id };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env["MONGOOSE_URI"] = mongo.getUri();
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["TRANSFER_SIGNING_KEY"] = GRANT_TEST_PRIVATE_KEY;
  resetConfigCache();
  db = await setupTestDb();
  await mongoose.connect(mongo.getUri());
  await Promise.all([DriveNodeModel.init(), FileVersionModel.init()]);
  const { createApp } = await import("../app.js");
  app = createApp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await teardownTestDb();
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await Promise.all([DriveNodeModel.deleteMany({}), FileVersionModel.deleteMany({})]);
  await truncateAll(db);
});

describe("device-primary upload metadata", () => {
  it("reserves pending metadata without creating a legacy storage object", async () => {
    await deviceFor(OWNER);
    const objectHash = hashOf("device bytes");

    const response = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({
        name: "photo.jpg",
        path: "photos/2026",
        size: 12,
        contentType: "image/jpeg",
        sha256: objectHash,
      })
      .expect(201);

    const reservation = response.body.data;
    const version = await FileVersionModel.findById(reservation.versionId).lean();
    expect(version).toMatchObject({
      ownerId: OWNER,
      objectHash,
      sha256: objectHash,
      status: "pending",
      isCurrent: false,
    });
    expect(version?.storage).toBeUndefined();
  });

  it("does not commit a device upload until a healthy replica exists", async () => {
    const device = await deviceFor(OWNER);
    const objectHash = hashOf("pending until possessed");
    const reserved = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({ name: "pending.bin", path: "", size: 22, sha256: objectHash })
      .expect(201);

    const versionId = reserved.body.data.versionId as string;
    const failed = await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [versionId] })
      .expect(409);

    expect(failed.body.code).toBe("NO_HEALTHY_REPLICA");
    expect(failed.body.details.protection.healthyReplicas).toBe(0);
    const stillPending = await FileVersionModel.findById(versionId).lean();
    expect(stillPending).toMatchObject({ status: "pending", isCurrent: false });

    await confirmReplicaForDevice(device.id, { objectHash, sizeBytes: 22 });
    const completed = await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [versionId] })
      .expect(200);

    expect(completed.body.data.completed[0]).toMatchObject({
      versionId,
      objectHash,
      bytes: 22,
      protection: { healthyReplicas: 1, state: "at_risk" },
    });
    const listing = await request(app)
      .get("/files")
      .set("X-User-Id", OWNER)
      .expect(200);
    expect(listing.body.data.files[0]).toMatchObject({
      objectHash,
      hasContent: true,
      protection: { healthyReplicas: 1 },
    });
  });

  it("keeps device-backed versions and completion isolated by owner", async () => {
    await deviceFor(OWNER);
    const objectHash = hashOf("private device bytes");
    const reserved = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({ name: "private.bin", path: "", size: 19, sha256: objectHash })
      .expect(201);

    const versionId = reserved.body.data.versionId as string;
    await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OTHER_OWNER)
      .send({ versionIds: [versionId] })
      .expect(404);

    expect((await request(app).get("/files").set("X-User-Id", OTHER_OWNER)).body.data.files)
      .toEqual([]);
    expect((await FileVersionModel.findById(versionId).lean())?.status).toBe("pending");
  });

  it("purges device metadata without trying to delete an absent legacy key", async () => {
    const device = await deviceFor(OWNER);
    const objectHash = hashOf("bytes retained on device");
    const reserved = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({ name: "retained.bin", path: "", size: 24, sha256: objectHash })
      .expect(201);
    const versionId = reserved.body.data.versionId as string;
    await confirmReplicaForDevice(device.id, { objectHash, sizeBytes: 24 });
    await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [versionId] })
      .expect(200);

    const nodeId = reserved.body.data.nodeId as string;
    const deleted = await request(app)
      .delete(`/drive-nodes/${nodeId}?purge=true`)
      .set("X-User-Id", OWNER)
      .expect(200);

    expect(deleted.body.data).toMatchObject({ deletedNodes: 1, purgedObjects: 0 });
    expect(await FileVersionModel.exists({ _id: versionId })).toBeNull();
  });
});
