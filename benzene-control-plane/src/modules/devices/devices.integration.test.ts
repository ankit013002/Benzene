import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import { getVaultSummary } from "../vaults/vaults.service.js";
import { generateDeviceKeyPair } from "./deviceIdentity.js";
import {
  approveEnrollment,
  beginDeviceRemoval,
  deriveStatus,
  getEnrollmentStatus,
  listDevices,
  listPendingEnrollments,
  recordHeartbeat,
  rejectEnrollment,
  requestEnrollment,
  setAllocation,
} from "./devices.service.js";
import { confirmReplica, reservePlacement, setPolicy } from "../placement/placement.service.js";

const OWNER = "auth|owner-1";
const OTHER_OWNER = "auth|owner-2";
const GB = 1024 * 1024 * 1024;

let db: NodePgDatabase<typeof schema>;

/** Runs a device all the way through enrollment, as the UI would. */
async function enrollDevice(
  owner: string,
  name: string,
  allocatedBytes = 100 * GB
): Promise<{ deviceId: string; keys: ReturnType<typeof generateDeviceKeyPair> }> {
  const keys = generateDeviceKeyPair();
  const enrollment = await requestEnrollment({
    publicKey: keys.publicKey,
    deviceName: name,
    platform: "macos",
  });
  const device = await approveEnrollment(owner, enrollment.code, allocatedBytes);
  return { deviceId: device.id, keys };
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

describe("enrollment", () => {
  it("does not create a device until a user approves the code", async () => {
    const keys = generateDeviceKeyPair();

    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Mac Studio",
      platform: "macos",
    });

    expect(enrollment.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await db.select().from(schema.devices)).toHaveLength(0);

    const device = await approveEnrollment(OWNER, enrollment.code, 500 * GB);

    expect(device.name).toBe("Mac Studio");
    expect(await db.select().from(schema.devices)).toHaveLength(1);
  });

  it("creates the vault on first approval", async () => {
    expect(await db.select().from(schema.vaults)).toHaveLength(0);

    await enrollDevice(OWNER, "Desktop");

    const vaults = await db.select().from(schema.vaults);
    expect(vaults).toHaveLength(1);
    expect(vaults[0]?.ownerId).toBe(OWNER);
  });

  it("records the allocation the user chose", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop", 750 * GB);

    const [allocation] = await db
      .select()
      .from(schema.deviceStorageAllocations)
      .where(eq(schema.deviceStorageAllocations.deviceId, deviceId));

    expect(allocation?.allocatedBytes).toBe(750 * GB);
    expect(allocation?.usedBytes).toBe(0);
  });

  it("cannot redeem the same code twice", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Desktop",
      platform: "linux",
    });

    await approveEnrollment(OWNER, enrollment.code, 10 * GB);

    await expect(approveEnrollment(OWNER, enrollment.code, 10 * GB)).rejects.toThrow(
      /No pending enrollment/
    );
    expect(await db.select().from(schema.devices)).toHaveLength(1);
  });

  it("rejects an unknown code", async () => {
    await expect(approveEnrollment(OWNER, "ZZZZ-ZZZZ", 10 * GB)).rejects.toThrow(
      /No pending enrollment/
    );
  });

  it("refuses an expired code and marks the enrollment expired", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Slow Laptop",
      platform: "windows",
    });

    // Past the default 10-minute pairing window.
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);

    await expect(approveEnrollment(OWNER, enrollment.code, GB)).rejects.toThrow(
      /expired/
    );

    const [row] = await db
      .select()
      .from(schema.deviceEnrollments)
      .where(eq(schema.deviceEnrollments.id, enrollment.id));
    expect(row?.status).toBe("expired");
  });

  it("refuses to enroll a public key that already belongs to a device", async () => {
    const { keys } = await enrollDevice(OWNER, "Desktop");

    await expect(
      requestEnrollment({
        publicKey: keys.publicKey,
        deviceName: "Impostor",
        platform: "linux",
      })
    ).rejects.toThrow(/already enrolled/);
  });

  it("rejects a public key that is not Ed25519", async () => {
    await expect(
      requestEnrollment({
        publicKey: Buffer.from("nonsense").toString("base64"),
        deviceName: "Bad",
        platform: "linux",
      })
    ).rejects.toThrow(/Ed25519/);
  });

  it("lets a user decline a pending enrollment", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Unknown machine",
      platform: "other",
    });

    await rejectEnrollment(OWNER, enrollment.code);

    expect(await listPendingEnrollments(OWNER)).toEqual([]);
    await expect(approveEnrollment(OWNER, enrollment.code, GB)).rejects.toThrow();
  });

  it("lets the requesting device poll its own status", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Desktop",
      platform: "linux",
    });

    const before = await getEnrollmentStatus(enrollment.id, keys.publicKey);
    expect(before.status).toBe("pending");

    await approveEnrollment(OWNER, enrollment.code, GB);

    const after = await getEnrollmentStatus(enrollment.id, keys.publicKey);
    expect(after.status).toBe("consumed");
    expect(after.deviceId).not.toBeNull();
  });

  // The enrollment id is not a secret; possession of the key is what counts.
  it("does not reveal an enrollment to a different public key", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Desktop",
      platform: "linux",
    });

    await expect(
      getEnrollmentStatus(enrollment.id, generateDeviceKeyPair().publicKey)
    ).rejects.toThrow(/not found/);
  });

  it("reports a pending enrollment as expired once its window passes", async () => {
    const keys = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({
      publicKey: keys.publicKey,
      deviceName: "Desktop",
      platform: "linux",
    });

    vi.setSystemTime(Date.now() + 11 * 60 * 1000);

    expect((await getEnrollmentStatus(enrollment.id, keys.publicKey)).status).toBe(
      "expired"
    );
    expect(await listPendingEnrollments(OWNER)).toEqual([]);
  });
});

describe("presence", () => {
  it("is offline until the first heartbeat arrives", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop");

    const [device] = await listDevices(OWNER);
    expect(device?.status).toBe("pending");
    expect(device?.lastSeenAt).toBeNull();

    await recordHeartbeat(deviceId, { usedBytes: 0, appVersion: "1.0.0" });

    expect((await listDevices(OWNER))[0]?.status).toBe("online");
  });

  it("reports a device offline once heartbeats stop", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Laptop");
    await recordHeartbeat(deviceId, {});

    // Past the default 120-second liveness window.
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);

    expect((await listDevices(OWNER))[0]?.status).toBe("offline");
  });

  it("records reported usage and the agent version", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop");

    await recordHeartbeat(deviceId, { usedBytes: 42 * GB, appVersion: "2.1.0" });

    const [device] = await listDevices(OWNER);
    expect(device?.usedBytes).toBe(42 * GB);
    expect(device?.appVersion).toBe("2.1.0");
  });

  // A device being retired must not resurrect itself with a late heartbeat.
  it("does not bring a draining device back online", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Old PC");
    await beginDeviceRemoval(OWNER, deviceId);

    await recordHeartbeat(deviceId, { usedBytes: 1 });

    expect((await listDevices(OWNER))[0]?.status).toBe("draining");
  });

  it("rejects a heartbeat from an unknown device", async () => {
    await expect(
      recordHeartbeat("00000000-0000-0000-0000-000000000000", {})
    ).rejects.toThrow(/not found/);
  });

  describe("deriveStatus", () => {
    it.each([
      ["draining", "draining"],
      ["removed", "removed"],
      ["suspected_lost", "suspected_lost"],
    ])("treats %s as authoritative regardless of liveness", (stored, expected) => {
      expect(deriveStatus(stored, new Date(), 120_000)).toBe(expected);
    });

    it("reports pending when a device has never been seen", () => {
      expect(deriveStatus("offline", null, 120_000)).toBe("pending");
    });
  });
});

describe("allocation", () => {
  it("lets a user raise the contribution", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop", 100 * GB);

    const updated = await setAllocation(OWNER, deviceId, 500 * GB);

    expect(updated.allocatedBytes).toBe(500 * GB);
  });

  // The control plane cannot make stored bytes disappear, so accepting this
  // would leave the allocation lying about reality.
  it("refuses to shrink below what the device already stores", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop", 100 * GB);
    await recordHeartbeat(deviceId, { usedBytes: 80 * GB });

    await expect(setAllocation(OWNER, deviceId, 10 * GB)).rejects.toThrow(
      /already storing/
    );
  });

  it("allows shrinking to exactly what is stored", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop", 100 * GB);
    await recordHeartbeat(deviceId, { usedBytes: 80 * GB });

    await expect(setAllocation(OWNER, deviceId, 80 * GB)).resolves.toMatchObject({
      allocatedBytes: 80 * GB,
    });
  });

  it("refuses to shrink below an active placement reservation", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop", 100);
    const objectHash = "a".repeat(64);
    await reservePlacement(OWNER, { objectHash, sizeBytes: 80, deviceIds: [deviceId] });

    await expect(setAllocation(OWNER, deviceId, 79)).rejects.toThrow(/already storing 80/);
    const [allocation] = await db
      .select({ allocatedBytes: schema.deviceStorageAllocations.allocatedBytes })
      .from(schema.deviceStorageAllocations)
      .where(eq(schema.deviceStorageAllocations.deviceId, deviceId));
    expect(allocation?.allocatedBytes).toBe(100);
  });

  it("refuses to shrink below a replica confirmed after the last heartbeat", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Desktop", 100);
    await recordHeartbeat(deviceId, { usedBytes: 0 });
    const objectHash = "b".repeat(64);
    await reservePlacement(OWNER, { objectHash, sizeBytes: 80, deviceIds: [deviceId] });
    await confirmReplica(OWNER, { objectHash, deviceId, sizeBytes: 80 });

    await expect(setAllocation(OWNER, deviceId, 79)).rejects.toThrow(/already storing 80/);
    const [allocation] = await db
      .select({ allocatedBytes: schema.deviceStorageAllocations.allocatedBytes })
      .from(schema.deviceStorageAllocations)
      .where(eq(schema.deviceStorageAllocations.deviceId, deviceId));
    expect(allocation?.allocatedBytes).toBe(100);
  });
});

describe("vault summary", () => {
  it("sums capacity across every device", async () => {
    await enrollDevice(OWNER, "Desktop", 1000 * GB);
    await enrollDevice(OWNER, "MacBook", 250 * GB);

    const summary = await getVaultSummary(OWNER);

    expect(summary.rawCapacityBytes).toBe(1250 * GB);
    expect(summary.deviceCount).toBe(2);
  });

  // Raw and online capacity answer different questions: what the user owns
  // versus what they can write to right now.
  it("counts only reachable devices toward online capacity", async () => {
    const a = await enrollDevice(OWNER, "Mini PC", 1000 * GB);
    await enrollDevice(OWNER, "Old Laptop", 500 * GB);
    await recordHeartbeat(a.deviceId, { usedBytes: 0 });

    const summary = await getVaultSummary(OWNER);

    expect(summary.rawCapacityBytes).toBe(1500 * GB);
    expect(summary.onlineCapacityBytes).toBe(1000 * GB);
    expect(summary.onlineDeviceCount).toBe(1);
  });

  it("reports an empty vault rather than failing", async () => {
    const summary = await getVaultSummary(OWNER);

    expect(summary).toMatchObject({
      rawCapacityBytes: 0,
      deviceCount: 0,
      onlineDeviceCount: 0,
    });
  });

  it("sums reported usage across devices", async () => {
    const a = await enrollDevice(OWNER, "Desktop", 1000 * GB);
    const b = await enrollDevice(OWNER, "MacBook", 500 * GB);
    await recordHeartbeat(a.deviceId, { usedBytes: 30 * GB });
    await recordHeartbeat(b.deviceId, { usedBytes: 12 * GB });

    expect((await getVaultSummary(OWNER)).usedBytes).toBe(42 * GB);
  });
});

describe("vault isolation", () => {
  it("never shows one owner another owner's devices", async () => {
    await enrollDevice(OWNER, "My Desktop");

    expect(await listDevices(OTHER_OWNER)).toEqual([]);
    expect((await getVaultSummary(OTHER_OWNER)).deviceCount).toBe(0);
  });

  it("refuses to change an allocation in someone else's vault", async () => {
    const { deviceId } = await enrollDevice(OWNER, "My Desktop");

    await expect(setAllocation(OTHER_OWNER, deviceId, GB)).rejects.toThrow(
      /not found/
    );
  });

  it("refuses to retire a device in someone else's vault", async () => {
    const { deviceId } = await enrollDevice(OWNER, "My Desktop");

    await expect(beginDeviceRemoval(OTHER_OWNER, deviceId)).rejects.toThrow(
      /not found/
    );
  });
});

describe("device removal", () => {
  // Marked draining rather than deleted: repair moves replicas first, while
  // erase/GC transport is intentionally still outside this bounded slice.
  it("marks a device draining rather than deleting it", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Old PC");

    const result = await beginDeviceRemoval(OWNER, deviceId);

    expect(result.status).toBe("draining");
    expect(await db.select().from(schema.devices)).toHaveLength(1);
  });

  it("keeps a draining device in the capacity total until it is gone", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Old PC", 500 * GB);
    await beginDeviceRemoval(OWNER, deviceId);

    expect((await getVaultSummary(OWNER)).rawCapacityBytes).toBe(500 * GB);
  });

  it("does not reopen a device that has already been removed", async () => {
    const { deviceId } = await enrollDevice(OWNER, "Gone PC");
    await db
      .update(schema.devices)
      .set({ status: "removed" })
      .where(eq(schema.devices.id, deviceId));

    await expect(beginDeviceRemoval(OWNER, deviceId)).rejects.toThrow(/already been removed/);
    const [stored] = await db
      .select({ status: schema.devices.status })
      .from(schema.devices)
      .where(eq(schema.devices.id, deviceId));
    expect(stored?.status).toBe("removed");
  });

  it("reports when protection is restored and the draining device is ready to disconnect", async () => {
    const source = await enrollDevice(OWNER, "Old PC");
    const target = await enrollDevice(OWNER, "Replacement");
    await setPolicy(OWNER, { mode: "maximum_capacity" });
    await recordHeartbeat(source.deviceId, { advertisedUrl: "http://127.0.0.1:7071" });
    await recordHeartbeat(target.deviceId, { advertisedUrl: "http://127.0.0.1:7072" });
    const objectHash = "a".repeat(64);

    await reservePlacement(OWNER, {
      objectHash,
      sizeBytes: 10,
      deviceIds: [source.deviceId],
    });
    await confirmReplica(OWNER, { objectHash, deviceId: source.deviceId, sizeBytes: 10 });

    await beginDeviceRemoval(OWNER, source.deviceId);
    expect((await listDevices(OWNER)).find((device) => device.id === source.deviceId))
      .toMatchObject({ status: "draining", removalReady: false });

    await reservePlacement(OWNER, {
      objectHash,
      sizeBytes: 10,
      deviceIds: [target.deviceId],
    });
    await confirmReplica(OWNER, { objectHash, deviceId: target.deviceId, sizeBytes: 10 });

    expect((await listDevices(OWNER)).find((device) => device.id === source.deviceId))
      .toMatchObject({ status: "draining", removalReady: true });
  });
});
