import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import type { Express } from "express";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  canonicalRequest,
  generateDeviceKeyPair,
  signRequest,
  type DeviceKeyPair,
} from "./deviceIdentity.js";
import {
  approveEnrollment,
  beginDeviceRemoval,
  recordHeartbeat,
  requestEnrollment,
} from "./devices.service.js";
import { confirmReplica, reservePlacement, setPolicy } from "../placement/placement.service.js";

const OWNER = "auth|owner-1";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;
let app: Express;

/** Builds the headers a node agent would send, signing exactly what it sends. */
function signedHeaders(input: {
  keys: DeviceKeyPair;
  deviceId: string;
  method: string;
  path: string;
  body: unknown;
  timestamp?: number;
}): Record<string, string> {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const signature = signRequest(
    input.keys.privateKey,
    canonicalRequest({
      method: input.method,
      path: input.path,
      timestamp,
      body,
    })
  );
  return {
    "X-Device-Id": input.deviceId,
    "X-Device-Timestamp": timestamp,
    "X-Device-Signature": signature,
    "Content-Type": "application/json",
  };
}

async function enrolledDevice(): Promise<{ deviceId: string; keys: DeviceKeyPair }> {
  const keys = generateDeviceKeyPair();
  const enrollment = await requestEnrollment({
    publicKey: keys.publicKey,
    deviceName: "Mac Studio",
    platform: "macos",
  });
  const device = await approveEnrollment(OWNER, enrollment.code, 500 * GB);
  return { deviceId: device.id, keys };
}

beforeAll(async () => {
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] ??= "mongodb://127.0.0.1:27017/unused";
  process.env["STORAGE_DRIVER"] ??= "local";
  resetConfigCache();
  db = await setupTestDb();

  const { createApp } = await import("../../app.js");
  app = createApp();
}, 120_000);

afterAll(async () => {
  await teardownTestDb();
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await truncateAll(db);
});

describe("enrollment over HTTP", () => {
  // A machine being set up holds no credentials, so this endpoint cannot
  // require any. It is safe because it grants nothing on its own.
  it("accepts an unauthenticated enrollment request", async () => {
    const keys = generateDeviceKeyPair();

    const res = await request(app)
      .post("/agent/enrollments")
      .send({ publicKey: keys.publicKey, deviceName: "Desktop", platform: "linux" })
      .expect(201);

    expect(res.body.data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("rejects an enrollment with a non-Ed25519 key", async () => {
    await request(app)
      .post("/agent/enrollments")
      .send({ publicKey: "bm9uc2Vuc2U=", deviceName: "Bad", platform: "linux" })
      .expect(400);
  });

  it.each([
    ["a missing name", { platform: "linux" }],
    ["an unknown platform", { deviceName: "X", platform: "toaster" }],
  ])("rejects an enrollment with %s", async (_label, extra) => {
    const keys = generateDeviceKeyPair();
    await request(app)
      .post("/agent/enrollments")
      .send({ publicKey: keys.publicKey, ...extra })
      .expect(400);
  });

  it("requires a signed-in user to approve", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Desktop",
      platform: "linux",
    });

    await request(app)
      .post("/devices/enrollments/approve")
      .send({ code: enrollment.code, allocatedBytes: GB })
      .expect(401);

    await request(app)
      .post("/devices/enrollments/approve")
      .set("X-User-Id", OWNER)
      .send({ code: enrollment.code, allocatedBytes: GB })
      .expect(201);
  });
});

describe("user endpoints", () => {
  it.each([
    ["GET", "/devices"],
    ["GET", "/vaults/me"],
    ["GET", "/devices/enrollments/pending/list"],
  ])("rejects %s %s without the gateway identity header", async (method, url) => {
    await request(app)
      [method.toLowerCase() as "get"](url)
      .expect(401);
  });

  it("reports vault capacity from enrolled devices", async () => {
    await enrolledDevice();

    const res = await request(app)
      .get("/vaults/me")
      .set("X-User-Id", OWNER)
      .expect(200);

    expect(res.body.data).toMatchObject({
      rawCapacityBytes: 500 * GB,
      deviceCount: 1,
      onlineDeviceCount: 0,
    });
  });
});

describe("device signature authentication", () => {
  it("allows signed removal polling/completion but rejects other requests after removal", async () => {
    const source = await enrolledDevice();
    const target = await enrolledDevice();
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await recordHeartbeat(source.deviceId, { advertisedUrl: "http://127.0.0.1:7071" });
    await recordHeartbeat(target.deviceId, { advertisedUrl: "http://127.0.0.1:7072" });
    const objectHash = "d".repeat(64);
    for (const deviceId of [source.deviceId, target.deviceId]) {
      await reservePlacement(OWNER, { objectHash, sizeBytes: 10, deviceIds: [deviceId] });
      await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 10 });
    }
    await beginDeviceRemoval(OWNER, source.deviceId);

    await request(app).get("/agent/removal").expect(401);
    await request(app)
      .get("/agent/removal")
      .set(
        signedHeaders({
          keys: generateDeviceKeyPair(),
          deviceId: source.deviceId,
          method: "GET",
          path: "/agent/removal",
          body: undefined,
        })
      )
      .expect(401);

    await request(app)
      .get("/agent/removal")
      .set(
        signedHeaders({
          keys: source.keys,
          deviceId: source.deviceId,
          method: "GET",
          path: "/agent/removal",
          body: undefined,
        })
      )
      .expect(200)
      .expect((res) => expect(res.body.data).toEqual({ status: "erase" }));

    await request(app)
      .post("/agent/removal/complete")
      .set(
        signedHeaders({
          keys: source.keys,
          deviceId: source.deviceId,
          method: "POST",
          path: "/agent/removal/complete",
          body: undefined,
        })
      )
      .expect(200)
      .expect((res) => expect(res.body.data).toEqual({ status: "removed" }));

    await request(app)
      .get("/agent/removal")
      .set(
        signedHeaders({
          keys: source.keys,
          deviceId: source.deviceId,
          method: "GET",
          path: "/agent/removal",
          body: undefined,
        })
      )
      .expect(200)
      .expect((res) => expect(res.body.data).toEqual({ status: "removed" }));

    await request(app)
      .post("/agent/heartbeat")
      .set(
        signedHeaders({
          keys: source.keys,
          deviceId: source.deviceId,
          method: "POST",
          path: "/agent/heartbeat",
          body: { usedBytes: 0 },
        })
      )
      .send({ usedBytes: 0 })
      .expect(401);
    await request(app)
      .post("/agent/possession")
      .set(
        signedHeaders({
          keys: source.keys,
          deviceId: source.deviceId,
          method: "POST",
          path: "/agent/possession",
          body: { objectHash, sizeBytes: 10 },
        })
      )
      .send({ objectHash, sizeBytes: 10 })
      .expect(401);
    await request(app)
      .get("/agent/repair")
      .set(
        signedHeaders({
          keys: source.keys,
          deviceId: source.deviceId,
          method: "GET",
          path: "/agent/repair",
          body: undefined,
        })
      )
      .expect(401);
  });

  it("accepts a correctly signed heartbeat", async () => {
    const { deviceId, keys } = await enrolledDevice();
    const body = { usedBytes: 1024, appVersion: "1.0.0" };

    const res = await request(app)
      .post("/agent/heartbeat")
      .set(signedHeaders({ keys, deviceId, method: "POST", path: "/agent/heartbeat", body }))
      .send(body)
      .expect(200);

    expect(res.body.data.status).toBe("online");
  });

  it("accepts a signed possession report and promotes only its own reservation", async () => {
    const { deviceId, keys } = await enrolledDevice();
    const objectHash = createHash("sha256").update("payload").digest("hex");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 7, deviceIds: [deviceId] });
    const body = { objectHash, sizeBytes: 7 };

    const res = await request(app)
      .post("/agent/possession")
      .set(
        signedHeaders({
          keys,
          deviceId,
          method: "POST",
          path: "/agent/possession",
          body,
        })
      )
      .send(body)
      .expect(200);

    expect(res.body.data).toMatchObject({ objectHash, deviceId, status: "healthy" });
  });

  it("rejects a conflicting possession size without changing the reservation", async () => {
    const { deviceId, keys } = await enrolledDevice();
    const objectHash = createHash("sha256").update("payload").digest("hex");
    await reservePlacement(OWNER, { objectHash, sizeBytes: 7, deviceIds: [deviceId] });
    const body = { objectHash, sizeBytes: 99 };

    await request(app)
      .post("/agent/possession")
      .set(
        signedHeaders({
          keys,
          deviceId,
          method: "POST",
          path: "/agent/possession",
          body,
        })
      )
      .send(body)
      .expect(400);

    const [row] = await db
      .select()
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, objectHash));
    expect(row).toMatchObject({ deviceId, objectHash, sizeBytes: 7, status: "placing" });
  });

  it("refuses an unsigned possession report", async () => {
    await request(app)
      .post("/agent/possession")
      .send({ objectHash: "a".repeat(64), sizeBytes: 1 })
      .expect(401);
  });

  it("rejects a heartbeat with no signature headers", async () => {
    await request(app).post("/agent/heartbeat").send({}).expect(401);
  });

  // The signature covers the body, so altering it after signing must fail.
  it("rejects a heartbeat whose body was tampered with in flight", async () => {
    const { deviceId, keys } = await enrolledDevice();
    const signed = { usedBytes: 1024 };

    await request(app)
      .post("/agent/heartbeat")
      .set(
        signedHeaders({
          keys,
          deviceId,
          method: "POST",
          path: "/agent/heartbeat",
          body: signed,
        })
      )
      .send({ usedBytes: 999_999 })
      .expect(401);
  });

  // The signature covers the path, so it cannot be lifted onto another route.
  it("rejects a signature minted for a different path", async () => {
    const { deviceId, keys } = await enrolledDevice();
    const body = { usedBytes: 1 };

    await request(app)
      .post("/agent/heartbeat")
      .set(
        signedHeaders({
          keys,
          deviceId,
          method: "POST",
          path: "/agent/something-else",
          body,
        })
      )
      .send(body)
      .expect(401);
  });

  it.each([
    ["far in the past", -3600],
    ["far in the future", 3600],
  ])("rejects a timestamp %s", async (_label, offsetSeconds) => {
    const { deviceId, keys } = await enrolledDevice();
    const body = { usedBytes: 1 };

    await request(app)
      .post("/agent/heartbeat")
      .set(
        signedHeaders({
          keys,
          deviceId,
          method: "POST",
          path: "/agent/heartbeat",
          body,
          timestamp: Math.floor(Date.now() / 1000) + offsetSeconds,
        })
      )
      .send(body)
      .expect(401);
  });

  it("rejects a signature made by a different device's key", async () => {
    const { deviceId } = await enrolledDevice();
    const attacker = generateDeviceKeyPair();
    const body = { usedBytes: 1 };

    await request(app)
      .post("/agent/heartbeat")
      .set(
        signedHeaders({
          keys: attacker,
          deviceId,
          method: "POST",
          path: "/agent/heartbeat",
          body,
        })
      )
      .send(body)
      .expect(401);
  });

  it("rejects an unknown device id", async () => {
    const keys = generateDeviceKeyPair();
    const body = { usedBytes: 1 };

    await request(app)
      .post("/agent/heartbeat")
      .set(
        signedHeaders({
          keys,
          deviceId: "00000000-0000-0000-0000-000000000000",
          method: "POST",
          path: "/agent/heartbeat",
          body,
        })
      )
      .send(body)
      .expect(401);
  });

  it("rejects a device that has been removed from the vault", async () => {
    const { deviceId, keys } = await enrolledDevice();
    await db
      .update(schema.devices)
      .set({ status: "removed" })
      .where(eq(schema.devices.id, deviceId));

    const body = { usedBytes: 1 };
    await request(app)
      .post("/agent/heartbeat")
      .set(
        signedHeaders({ keys, deviceId, method: "POST", path: "/agent/heartbeat", body })
      )
      .send(body)
      .expect(401);
  });
});
