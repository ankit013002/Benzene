import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import {
  approveEnrollment,
  beginDeviceRemoval,
  recordHeartbeat,
  requestEnrollment,
} from "../devices/devices.service.js";
import {
  confirmReplica,
  decidePlacement,
  getObjectProtection,
  getPolicy,
  getVaultProtection,
  listUnderProtectedObjects,
  reservePlacement,
  setPolicy,
} from "./placement.service.js";

const OWNER = "auth|owner-1";
const OTHER_OWNER = "auth|owner-2";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Enrolls a device and marks it online, which placement requires. */
async function onlineDevice(
  owner: string,
  name: string,
  allocatedBytes = 100 * GB,
  usedBytes = 0
): Promise<string> {
  const keys = generateDeviceKeyPair();
  const enrollment = await requestEnrollment({
    publicKey: keys.publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(owner, enrollment.code, allocatedBytes);
  await recordHeartbeat(device.id, { usedBytes });
  return device.id;
}

beforeAll(async () => {
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] ??= "mongodb://127.0.0.1:27017/unused";
  resetConfigCache();
  db = await setupTestDb();
}, 120_000);

afterAll(async () => {
  await teardownTestDb();
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  vi.useRealTimers();
  await truncateAll(db);
});

describe("storage policy", () => {
  it("defaults a new vault to Protected, meaning two copies", async () => {
    const policy = await getPolicy(OWNER);

    expect(policy.mode).toBe("protected");
    expect(policy.cloudProtection).toBe(false);
  });

  it.each([
    ["maximum_capacity", 1],
    ["protected", 2],
    ["highly_protected", 3],
  ] as const)("places %s copies for %s", async (mode, expected) => {
    await setPolicy(OWNER, { mode });
    for (let i = 0; i < 4; i += 1) await onlineDevice(OWNER, `device-${i}`);

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision.deviceIds).toHaveLength(expected);
    expect(decision.desiredReplicas).toBe(expected);
  });

  // §17 offers replication factor 1; the engine honours it but flags it so the
  // UI can say plainly that one dead drive loses the data.
  it("marks a single-copy policy so the UI can warn about it", async () => {
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await onlineDevice(OWNER, "only");

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("x"),
      sizeBytes: GB,
    });

    expect(decision.singleCopy).toBe(true);
  });

  it("does not flag Protected as single copy", async () => {
    await onlineDevice(OWNER, "a");
    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("x"),
      sizeBytes: GB,
    });

    expect(decision.singleCopy).toBe(false);
  });
});

describe("deciding placement", () => {
  it("spreads copies over distinct devices", async () => {
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(new Set(decision.deviceIds)).toEqual(new Set([a, b]));
    expect(decision.shortfall).toBe(false);
  });

  it("prefers the emptiest device by proportion", async () => {
    await onlineDevice(OWNER, "full", 100 * GB, 95 * GB);
    const empty = await onlineDevice(OWNER, "empty", 100 * GB, 5 * GB);

    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision.deviceIds).toEqual([empty]);
  });

  it("ignores a device that never came online", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "never-seen",
      platform: "linux",
    });
    await approveEnrollment(OWNER, enrollment.code, 100 * GB);

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision.deviceIds).toEqual([]);
    expect(decision.reason).toBe("none_online");
  });

  it("ignores a device that has gone quiet", async () => {
    await onlineDevice(OWNER, "sleepy");

    // Past the liveness window.
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision.deviceIds).toEqual([]);
  });

  // A machine being retired must not be handed new data.
  it("ignores a device that is draining", async () => {
    const draining = await onlineDevice(OWNER, "retiring");
    const keeper = await onlineDevice(OWNER, "keeper");
    await beginDeviceRemoval(OWNER, draining);

    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision.deviceIds).toEqual([keeper]);
  });

  it("ignores a device without room for the object", async () => {
    await onlineDevice(OWNER, "tight", 2 * GB, 2 * GB);
    const roomy = await onlineDevice(OWNER, "roomy", 100 * GB);

    await setPolicy(OWNER, { mode: "maximum_capacity" });
    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: 5 * GB,
    });

    expect(decision.deviceIds).toEqual([roomy]);
  });

  // Placing one copy of a two-copy file beats refusing the upload.
  it("places what it can and reports the shortfall", async () => {
    await onlineDevice(OWNER, "only");

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision.deviceIds).toHaveLength(1);
    expect(decision.shortfall).toBe(true);
    expect(decision.reason).toBe("insufficient_capacity");
  });

  it("reports a vault with no devices", async () => {
    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision).toMatchObject({ deviceIds: [], shortfall: true, reason: "no_devices" });
  });
});

describe("reserving and confirming", () => {
  it("reserves as placing, then confirms as healthy", async () => {
    const a = await onlineDevice(OWNER, "a");
    const hash = hashOf("payload");

    const reserved = await reservePlacement(OWNER, {
      objectHash: hash,
      sizeBytes: 1024,
      deviceIds: [a],
    });
    expect(reserved[0]?.status).toBe("placing");

    // Not yet healthy: the bytes have not landed.
    expect((await getObjectProtection(OWNER, hash)).healthyReplicas).toBe(0);

    await confirmReplica(OWNER, { objectHash: hash, deviceId: a, sizeBytes: 1024 });

    const protection = await getObjectProtection(OWNER, hash);
    expect(protection.healthyReplicas).toBe(1);
    expect(protection.placingReplicas).toBe(0);
  });

  it("accepts an exact-fit first reservation but rejects the next byte", async () => {
    const device = await onlineDevice(OWNER, "exact-fit", 14);

    await expect(
      reservePlacement(OWNER, {
        objectHash: hashOf("exact-fit first object"),
        sizeBytes: 14,
        deviceIds: [device],
      })
    ).resolves.toHaveLength(1);

    await expect(
      reservePlacement(OWNER, {
        objectHash: hashOf("exact-fit second object"),
        sizeBytes: 1,
        deviceIds: [device],
      })
    ).rejects.toThrow(/Insufficient capacity/);
  });

  // The unique index is what actually enforces §22, whatever the engine thinks.
  it("cannot reserve the same device twice for one object", async () => {
    const a = await onlineDevice(OWNER, "a");
    const hash = hashOf("payload");

    await reservePlacement(OWNER, { objectHash: hash, sizeBytes: 10, deviceIds: [a] });
    const second = await reservePlacement(OWNER, {
      objectHash: hash,
      sizeBytes: 10,
      deviceIds: [a],
    });

    expect(second).toEqual([]);
    expect(
      await db.select().from(schema.replicas).where(eq(schema.replicas.objectHash, hash))
    ).toHaveLength(1);
  });

  it("reopens a failed replica row instead of issuing a reservation that conflicts away", async () => {
    const a = await onlineDevice(OWNER, "a", 10);
    const hash = hashOf("retry failed replica");

    await reservePlacement(OWNER, { objectHash: hash, sizeBytes: 10, deviceIds: [a] });
    await db
      .update(schema.replicas)
      .set({ status: "corrupt", verifiedAt: new Date() })
      .where(eq(schema.replicas.objectHash, hash));

    // An exact-size rewrite may reclaim the recorded corrupt bytes, even when
    // the last heartbeat reports the allocation as full.
    await recordHeartbeat(a, { usedBytes: 10 });
    const retried = await reservePlacement(OWNER, {
      objectHash: hash,
      sizeBytes: 10,
      deviceIds: [a],
    });

    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ objectHash: hash, deviceId: a, status: "placing" });
    const [row] = await db
      .select()
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, hash));
    expect(row).toMatchObject({ status: "placing", sizeBytes: 10, verifiedAt: null });
  });

  it("counts post-heartbeat possession without double-counting reported bytes", async () => {
    const a = await onlineDevice(OWNER, "a", 200);
    const first = hashOf("reported copy");
    const second = hashOf("post-heartbeat copy");

    await reservePlacement(OWNER, { objectHash: first, sizeBytes: 100, deviceIds: [a] });
    await confirmReplica(OWNER, { objectHash: first, deviceId: a, sizeBytes: 100 });
    await db
      .update(schema.replicas)
      .set({ verifiedAt: new Date(Date.now() - 2000) })
      .where(eq(schema.replicas.objectHash, first));
    await recordHeartbeat(a, { usedBytes: 100 });

    await reservePlacement(OWNER, { objectHash: second, sizeBytes: 100, deviceIds: [a] });
    await confirmReplica(OWNER, { objectHash: second, deviceId: a, sizeBytes: 100 });
    await db
      .update(schema.replicas)
      .set({ verifiedAt: new Date(Date.now() + 2000) })
      .where(eq(schema.replicas.objectHash, second));

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("third copy"),
      sizeBytes: 1,
    });
    expect(decision.deviceIds).toEqual([]);
    expect(decision.reason).toBe("insufficient_capacity");
  });

  it("does not overbook one device across concurrent object reservations", async () => {
    const a = await onlineDevice(OWNER, "a", 14);
    const first = hashOf("first reservation");
    const second = hashOf("second reservation");

    const results = await Promise.allSettled([
      reservePlacement(OWNER, { objectHash: first, sizeBytes: 14, deviceIds: [a] }),
      reservePlacement(OWNER, { objectHash: second, sizeBytes: 14, deviceIds: [a] }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(schema.replicas)).toHaveLength(1);
  });

  it("counts an active placement against later placement capacity", async () => {
    const a = await onlineDevice(OWNER, "a", 14);
    const first = hashOf("active reservation");
    const second = hashOf("later reservation");

    await reservePlacement(OWNER, { objectHash: first, sizeBytes: 14, deviceIds: [a] });
    const decision = await decidePlacement(OWNER, { objectHash: second, sizeBytes: 14 });

    expect(decision.deviceIds).toEqual([]);
    expect(decision.reason).toBe("insufficient_capacity");
  });

  it("counts a confirmed replica before the device sends another heartbeat", async () => {
    const a = await onlineDevice(OWNER, "a", 14);
    const first = hashOf("confirmed object");
    const second = hashOf("later object");

    await reservePlacement(OWNER, { objectHash: first, sizeBytes: 14, deviceIds: [a] });
    await confirmReplica(OWNER, { objectHash: first, deviceId: a, sizeBytes: 14 });

    const decision = await decidePlacement(OWNER, { objectHash: second, sizeBytes: 14 });

    expect(decision.deviceIds).toEqual([]);
    expect(decision.reason).toBe("insufficient_capacity");
    const [stored] = await db
      .select()
      .from(schema.replicas)
      .where(eq(schema.replicas.objectHash, first));
    expect(stored).toMatchObject({ status: "healthy", sizeBytes: 14, deviceId: a });
  });

  it("refuses to reserve a device from another vault", async () => {
    const foreign = await onlineDevice(OTHER_OWNER, "theirs");

    await expect(
      reservePlacement(OWNER, {
        objectHash: hashOf("x"),
        sizeBytes: 10,
        deviceIds: [foreign],
      })
    ).rejects.toThrow(/not part of this vault/);
  });

  it("does not reserve a device after it starts draining", async () => {
    const draining = await onlineDevice(OWNER, "retiring");
    await beginDeviceRemoval(OWNER, draining);

    await expect(
      reservePlacement(OWNER, {
        objectHash: hashOf("stale plan"),
        sizeBytes: 10,
        deviceIds: [draining],
      })
    ).rejects.toThrow(/no longer accepting placements/);
    expect(await db.select().from(schema.replicas)).toEqual([]);
  });

  it("requires an online reachable device when a transfer reservation is requested", async () => {
    const device = await onlineDevice(OWNER, "unreachable");

    await expect(
      reservePlacement(
        OWNER,
        { objectHash: hashOf("unreachable reservation"), sizeBytes: 10, deviceIds: [device] },
        { requireReachable: true }
      )
    ).rejects.toThrow(/cannot receive transfers/);
    expect(await db.select().from(schema.replicas)).toEqual([]);
  });

  it("refuses to confirm a replica that was never reserved", async () => {
    const a = await onlineDevice(OWNER, "a");

    await expect(
      confirmReplica(OWNER, { objectHash: hashOf("x"), deviceId: a })
    ).rejects.toThrow(/No placement reserved/);
  });

  // Content addressing means re-uploading identical bytes should place only the
  // copies still missing.
  it("only places the copies still missing when bytes are already held", async () => {
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");
    const hash = hashOf("payload");

    await reservePlacement(OWNER, { objectHash: hash, sizeBytes: 10, deviceIds: [a] });
    await confirmReplica(OWNER, { objectHash: hash, deviceId: a });

    const decision = await decidePlacement(OWNER, { objectHash: hash, sizeBytes: 10 });

    expect(decision.existingDeviceIds).toEqual([a]);
    expect(decision.deviceIds).toEqual([b]);
    expect(decision.shortfall).toBe(false);
  });
});

describe("protection health", () => {
  async function place(hash: string, deviceIds: string[]): Promise<void> {
    await reservePlacement(OWNER, { objectHash: hash, sizeBytes: 10, deviceIds });
    for (const deviceId of deviceIds) {
      await confirmReplica(OWNER, { objectHash: hash, deviceId });
    }
  }

  it("reports healthy when the policy is met", async () => {
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");
    await place(hashOf("payload"), [a, b]);

    expect((await getObjectProtection(OWNER, hashOf("payload"))).state).toBe("healthy");
  });

  // One copy left means the next failure loses the data — distinct from merely
  // being below target.
  it("reports at risk on the last remaining copy", async () => {
    const a = await onlineDevice(OWNER, "a");
    await place(hashOf("payload"), [a]);

    expect((await getObjectProtection(OWNER, hashOf("payload"))).state).toBe("at_risk");
  });

  it("reports degraded when redundancy survives but is below target", async () => {
    await setPolicy(OWNER, { mode: "highly_protected" });
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");
    await place(hashOf("payload"), [a, b]);

    expect((await getObjectProtection(OWNER, hashOf("payload"))).state).toBe("degraded");
  });

  // §41: offline is not lost. Treating it as lost would trigger a repair every
  // time a laptop closes.
  it("still counts a replica on a device that went offline", async () => {
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");
    await place(hashOf("payload"), [a, b]);

    vi.setSystemTime(Date.now() + 10 * 60 * 1000);

    expect((await getObjectProtection(OWNER, hashOf("payload"))).state).toBe("healthy");
  });

  it("reports an object with no replicas as unprotected", async () => {
    expect((await getObjectProtection(OWNER, hashOf("nothing"))).state).toBe(
      "unprotected"
    );
  });
});

describe("vault protection summary", () => {
  async function place(hash: string, deviceIds: string[]): Promise<void> {
    await reservePlacement(OWNER, { objectHash: hash, sizeBytes: 10, deviceIds });
    for (const deviceId of deviceIds) {
      await confirmReplica(OWNER, { objectHash: hash, deviceId });
    }
  }

  it("reports empty before anything is stored", async () => {
    expect((await getVaultProtection(OWNER)).state).toBe("empty");
  });

  it("reports healthy when every object meets the policy", async () => {
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");
    await place(hashOf("one"), [a, b]);
    await place(hashOf("two"), [a, b]);

    const summary = await getVaultProtection(OWNER);
    expect(summary).toMatchObject({ state: "healthy", totalObjects: 2, healthyObjects: 2 });
  });

  // "Everything protected" must never show while one file is a failure from
  // being lost.
  it("reports the worst state across objects, not the average", async () => {
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");
    await place(hashOf("safe"), [a, b]);
    await place(hashOf("exposed"), [a]);

    const summary = await getVaultProtection(OWNER);
    expect(summary.state).toBe("at_risk");
    expect(summary.atRiskObjects).toBe(1);
    expect(summary.healthyObjects).toBe(1);
  });

  it("lists under-protected objects for the repair queue", async () => {
    const a = await onlineDevice(OWNER, "a");
    const b = await onlineDevice(OWNER, "b");
    await place(hashOf("safe"), [a, b]);
    await place(hashOf("exposed"), [a]);

    const queue = await listUnderProtectedObjects(OWNER);

    expect(queue.map((o) => o.objectHash)).toEqual([hashOf("exposed")]);
  });
});

describe("vault isolation", () => {
  it("never places on another owner's devices", async () => {
    await onlineDevice(OTHER_OWNER, "theirs");

    const decision = await decidePlacement(OWNER, {
      objectHash: hashOf("payload"),
      sizeBytes: GB,
    });

    expect(decision.deviceIds).toEqual([]);
    expect(decision.reason).toBe("no_devices");
  });

  it("does not leak another owner's protection state", async () => {
    const theirs = await onlineDevice(OTHER_OWNER, "theirs");
    await reservePlacement(OTHER_OWNER, {
      objectHash: hashOf("secret"),
      sizeBytes: 10,
      deviceIds: [theirs],
    });
    await confirmReplica(OTHER_OWNER, { objectHash: hashOf("secret"), deviceId: theirs });

    expect((await getObjectProtection(OWNER, hashOf("secret"))).healthyReplicas).toBe(0);
    expect((await getVaultProtection(OWNER)).totalObjects).toBe(0);
  });
});
