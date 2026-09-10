import { createHash } from "node:crypto";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import {
  approveEnrollment,
  recordHeartbeat,
  requestEnrollment,
} from "../devices/devices.service.js";
import { confirmReplica, setPolicy } from "./placement.service.js";
import { GRANT_TEST_PRIVATE_KEY, GRANT_TEST_PUBLIC_KEY } from "./grantVectors.js";
import { planDownload, planUpload, transferPublicKey } from "./uploadTargets.service.js";

const OWNER = "auth|owner-1";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeGrant(grant: string): Record<string, unknown> {
  const encoded = grant.split(".")[0] ?? "";
  return JSON.parse(
    Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  ) as Record<string, unknown>;
}

/** Enrolls a device, brings it online and gives it a reachable address. */
async function reachableDevice(
  name: string,
  advertisedUrl: string | null,
  allocatedBytes = 100 * GB
): Promise<string> {
  const keys = generateDeviceKeyPair();
  const enrollment = await requestEnrollment({
    publicKey: keys.publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(OWNER, enrollment.code, allocatedBytes);
  await recordHeartbeat(device.id, {
    usedBytes: 0,
    ...(advertisedUrl ? { advertisedUrl } : {}),
  });
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

describe("planning an upload", () => {
  it("returns a reachable target per chosen device", async () => {
    await reachableDevice("desktop", "http://192.168.1.10:7070");
    await reachableDevice("mini", "http://192.168.1.11:7070");
    const hash = hashOf("payload");

    const plan = await planUpload(OWNER, { objectHash: hash, sizeBytes: 1024 });

    expect(plan.targets).toHaveLength(2);
    expect(plan.shortfall).toBe(false);
    expect(plan.targets.map((t) => t.url).sort()).toEqual([
      `http://192.168.1.10:7070/objects/${hash}`,
      `http://192.168.1.11:7070/objects/${hash}`,
    ]);
  });

  it("scopes each grant to its own device and this object", async () => {
    const deviceId = await reachableDevice("desktop", "http://192.168.1.10:7070");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const hash = hashOf("payload");

    const plan = await planUpload(OWNER, { objectHash: hash, sizeBytes: 1024 });

    expect(decodeGrant(plan.targets[0]!.grant)).toMatchObject({
      v: 1,
      objectHash: hash,
      deviceId,
      op: "put",
      size: 1024,
    });
  });

  it("issues grants that expire", async () => {
    await reachableDevice("desktop", "http://192.168.1.10:7070");
    await setPolicy(OWNER, { mode: "maximum_capacity" });

    const plan = await planUpload(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: 10,
    });

    const exp = decodeGrant(plan.targets[0]!.grant)["exp"] as number;
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // Default TTL is 5 minutes; anything long-lived defeats the point.
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });

  // Reserving before authorising means an abandoned transfer is visible as an
  // unfinished placement rather than as nothing at all.
  it("reserves the placement before handing out grants", async () => {
    const deviceId = await reachableDevice("desktop", "http://192.168.1.10:7070");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const hash = hashOf("payload");

    await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });

    const rows = await db.select().from(schema.replicas);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId, objectHash: hash, status: "placing" });
  });

  // A device with no advertised address cannot be reached, so handing it to the
  // browser would produce a target that fails on connect.
  it("drops a device that has never advertised an address", async () => {
    await reachableDevice("unreachable", null);
    await setPolicy(OWNER, { mode: "maximum_capacity" });

    const plan = await planUpload(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: 10,
    });

    expect(plan.targets).toEqual([]);
    expect(plan.shortfall).toBe(true);
    expect(plan.reason).toBe("unreachable_devices");
    expect(await db.select().from(schema.replicas)).toEqual([]);
  });

  it("chooses reachable substitutes instead of underfilling around an unreachable device", async () => {
    const a = await reachableDevice("reachable-a", "http://192.168.1.10:7070", 100 * GB);
    const b = await reachableDevice("unreachable-b", null, 100 * GB);
    const c = await reachableDevice("reachable-c", "http://192.168.1.12:7070", 100 * GB);

    // Make B rank first by free capacity, followed by A, then C. Upload
    // planning must skip B before selecting its two policy copies.
    await recordHeartbeat(a, { usedBytes: 10 * GB });
    await recordHeartbeat(b, { usedBytes: 0 });
    await recordHeartbeat(c, { usedBytes: 20 * GB });

    const hash = hashOf("reachable substitute");
    const plan = await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });

    expect(plan.targets.map((target) => target.deviceId).sort()).toEqual([a, c].sort());
    expect(plan.shortfall).toBe(false);
    const replicas = await db.select().from(schema.replicas);
    expect(replicas.map((row) => row.deviceId).sort()).toEqual([a, c].sort());
    expect(replicas.some((row) => row.deviceId === b)).toBe(false);
  });

  it("can retry an unfinished placement without treating it as held", async () => {
    const deviceId = await reachableDevice("desktop", "http://192.168.1.10:7070");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const hash = hashOf("retryable");

    const first = await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });
    expect(first.targets).toHaveLength(1);

    // No possession report arrived. A second plan must still hand out a
    // target, while the API must not claim that the bytes are already held.
    const retry = await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });
    expect(retry.alreadyHeldBy).toEqual([]);
    expect(retry.targets.map((target) => target.deviceId)).toEqual([deviceId]);
    expect(
      (await db.select().from(schema.replicas)).map((row) => row.status)
    ).toEqual(["placing"]);
  });

  it("releases an abandoned reservation after the grant window", async () => {
    await reachableDevice("desktop", "http://192.168.1.10:7070");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const hash = hashOf("abandoned");

    await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });
    const [before] = await db.select().from(schema.replicas);
    await db
      .update(schema.replicas)
      .set({ updatedAt: new Date(Date.now() - 301_000) });

    const retry = await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });
    const [after] = await db.select().from(schema.replicas);
    expect(retry.targets).toHaveLength(1);
    expect(after?.id).not.toBe(before?.id);
  });

  it("reports a shortfall when fewer devices exist than the policy wants", async () => {
    await reachableDevice("only", "http://192.168.1.10:7070");

    const plan = await planUpload(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: 10,
    });

    expect(plan.targets).toHaveLength(1);
    expect(plan.desiredReplicas).toBe(2);
    expect(plan.shortfall).toBe(true);
  });

  it("reports an empty vault without issuing anything", async () => {
    const plan = await planUpload(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: 10,
    });

    expect(plan.targets).toEqual([]);
    expect(plan.reason).toBe("no_devices");
    expect(await db.select().from(schema.replicas)).toEqual([]);
  });

  // Content addressing: identical bytes need sending only where they are not.
  it("does not re-send to a device that already holds the object", async () => {
    const a = await reachableDevice("a", "http://192.168.1.10:7070");
    const b = await reachableDevice("b", "http://192.168.1.11:7070");
    const hash = hashOf("payload");

    const first = await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });
    for (const target of first.targets) {
      await confirmReplica(OWNER, { objectHash: hash, deviceId: target.deviceId });
    }

    const second = await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });

    expect(second.targets).toEqual([]);
    expect(second.alreadyHeldBy.sort()).toEqual([a, b].sort());
    expect(second.shortfall).toBe(false);
  });
});

describe("planning a download", () => {
  it("returns a read grant per device holding the object", async () => {
    const deviceId = await reachableDevice("desktop", "http://192.168.1.10:7070");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const hash = hashOf("payload");

    const plan = await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });
    await confirmReplica(OWNER, { objectHash: hash, deviceId: plan.targets[0]!.deviceId });

    const targets = await planDownload(OWNER, hash);

    expect(targets).toHaveLength(1);
    expect(decodeGrant(targets[0]!.grant)).toMatchObject({ objectHash: hash, deviceId, op: "get" });
  });

  // A replica still being placed has no bytes to serve yet.
  it("ignores a replica that has not been confirmed", async () => {
    await reachableDevice("desktop", "http://192.168.1.10:7070");
    const hash = hashOf("payload");
    await planUpload(OWNER, { objectHash: hash, sizeBytes: 10 });

    expect(await planDownload(OWNER, hash)).toEqual([]);
  });

  it("returns nothing for an object nobody holds", async () => {
    expect(await planDownload(OWNER, hashOf("absent"))).toEqual([]);
  });
});

describe("key distribution", () => {
  it("derives the public key agents verify grants with", () => {
    expect(transferPublicKey()).toBe(GRANT_TEST_PUBLIC_KEY);
  });
});
