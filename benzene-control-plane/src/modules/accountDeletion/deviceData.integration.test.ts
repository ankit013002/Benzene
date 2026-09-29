import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  approveEnrollment,
  pollDeviceRemoval,
  requestEnrollment,
  completeDeviceRemoval,
} from "../devices/devices.service.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";

const OWNER = "account-device-data-owner";
const SECRET = "account-device-data-test-secret-at-least-32-bytes";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;
let app: import("express").Express;

async function enrolledDevice(): Promise<string> {
  const enrollment = await requestEnrollment({
    publicKey: generateDeviceKeyPair().publicKey,
    deviceName: "Account deletion device",
    platform: "linux",
  });
  return (await approveEnrollment(OWNER, enrollment.code, GB)).id;
}

beforeAll(async () => {
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] ??= "mongodb://127.0.0.1:27017/unused";
  process.env["STORAGE_DRIVER"] ??= "local";
  process.env["ACCOUNT_DELETION_INTERNAL_SECRET"] = SECRET;
  resetConfigCache();
  db = await setupTestDb();
  const { createApp } = await import("../../app.js");
  app = createApp();
}, 120_000);

afterAll(async () => {
  await teardownTestDb();
  delete process.env["ACCOUNT_DELETION_INTERNAL_SECRET"];
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await truncateAll(db);
});

describe("account device-data cleanup", () => {
  it("requires the internal secret and leaves offline devices pending until they acknowledge erase", async () => {
    const deviceId = await enrolledDevice();
    const endpoint = `/internal/account-deletion/${encodeURIComponent(OWNER)}/device-data`;

    await request(app).post(endpoint).expect(401);

    const first = await request(app)
      .post(endpoint)
      .set("X-Benzene-Internal-Secret", SECRET)
      .expect(200);
    expect(first.body).toMatchObject({
      complete: false,
      removalStarted: 1,
      awaitingDeviceAcknowledgement: 1,
    });

    const retry = await request(app)
      .post(endpoint)
      .set("X-Benzene-Internal-Secret", SECRET)
      .expect(200);
    expect(retry.body).toMatchObject({
      complete: false,
      removalStarted: 0,
      awaitingDeviceAcknowledgement: 1,
    });

    // This is the same durable signed-node removal state machine used by
    // user-requested device retirement; no adapter-side delete bypass exists.
    await expect(pollDeviceRemoval(deviceId)).resolves.toEqual({ status: "erase" });
    await expect(completeDeviceRemoval(deviceId)).resolves.toEqual({ status: "removed" });

    await request(app)
      .post(endpoint)
      .set("X-Benzene-Internal-Secret", SECRET)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ complete: true }));
  });

  it("completes when the account has no vault or devices", async () => {
    await request(app)
      .post(`/internal/account-deletion/${encodeURIComponent("owner-with-no-vault")}/device-data`)
      .set("X-Benzene-Internal-Secret", SECRET)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toEqual({
          complete: true,
          removalStarted: 0,
          awaitingDeviceAcknowledgement: 0,
        }),
      );
  });
});
