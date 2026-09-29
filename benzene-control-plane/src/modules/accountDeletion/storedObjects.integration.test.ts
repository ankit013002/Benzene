import { createHash } from "node:crypto";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import { approveEnrollment, recordHeartbeat, requestEnrollment } from "../devices/devices.service.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import { completeGarbageCollection, pollGarbageCollection, registerObjectReference } from "../placement/garbageCollection.service.js";
import { confirmReplica, reservePlacement } from "../placement/placement.service.js";
import { purgeAccountStoredObjects } from "./storedObjects.service.js";

const OWNER = "account-deletion-owner";
const INTERNAL_SECRET = "account-deletion-test-secret-at-least-32-bytes";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;
let mongo: MongoMemoryServer;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function onlineDevice(): Promise<string> {
  const enrollment = await requestEnrollment({
    publicKey: generateDeviceKeyPair().publicKey,
    deviceName: "account deletion collector",
    platform: "linux",
  });
  const device = await approveEnrollment(OWNER, enrollment.code, GB);
  await recordHeartbeat(device.id, { advertisedUrl: "http://192.168.1.10:7070" });
  return device.id;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] = mongo.getUri();
  process.env["ACCOUNT_DELETION_INTERNAL_SECRET"] = INTERNAL_SECRET;
  process.env["STORAGE_DRIVER"] = "local";
  resetConfigCache();
  db = await setupTestDb();
  await mongoose.connect(mongo.getUri());
  await FileVersionModel.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await teardownTestDb();
  delete process.env["ACCOUNT_DELETION_INTERNAL_SECRET"];
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await FileVersionModel.deleteMany({});
  await truncateAll(db);
});

describe("account stored-object cleanup", () => {
  it("waits for the existing per-device garbage-collection acknowledgement", async () => {
    const deviceId = await onlineDevice();
    const objectHash = hashOf("account-owned bytes");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 12, deviceIds: [deviceId] });
    await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 12 });

    const versionId = new Types.ObjectId();
    await FileVersionModel.create({
      _id: versionId,
      nodeId: new Types.ObjectId(),
      ownerId: OWNER,
      version: 1,
      bytes: 12,
      objectHash,
      status: "committed",
      uploadedBy: OWNER,
      isCurrent: true,
    });
    await registerObjectReference(OWNER, {
      versionId: versionId.toString(),
      objectHash,
    });

    const first = await purgeAccountStoredObjects(OWNER);
    expect(first.complete).toBe(false);
    expect(await FileVersionModel.exists({ _id: versionId })).toBeNull();

    const assignment = await pollGarbageCollection(deviceId);
    if (!assignment) throw new Error("Expected durable garbage-collection assignment");
    expect(assignment.objectHash).toBe(objectHash);
    await completeGarbageCollection(deviceId, assignment);

    await expect(purgeAccountStoredObjects(OWNER)).resolves.toMatchObject({
      complete: true,
    });
  });

  it("exposes only an authenticated internal route", async () => {
    const { createApp } = await import("../../app.js");
    const request = (await import("supertest")).default;
    const app = createApp();
    const endpoint = `/internal/account-deletion/${encodeURIComponent(OWNER)}/stored-objects`;

    await request(app).post(endpoint).expect(401);
    await request(app)
      .post(endpoint)
      .set("X-Benzene-Internal-Secret", INTERNAL_SECRET)
      .expect(200)
      .expect(({ body }) => expect(body.complete).toBe(true));
  });
});
