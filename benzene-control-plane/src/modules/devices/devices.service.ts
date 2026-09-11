import { randomBytes } from "node:crypto";

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import {
  REPLICAS_FOR_MODE,
  deviceEnrollments,
  deviceStorageAllocations,
  devices,
  replicas,
  storagePolicies,
  vaults,
  type Device,
  type DeviceEnrollment,
} from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";
import { ensureVaultForOwner } from "../vaults/vaults.service.js";
import { occupiedBytesSql } from "../placement/capacity.js";
import {
  codesMatch,
  generatePairingCode,
  isValidPublicKey,
} from "./deviceIdentity.js";

type DbExecutor = Pick<ReturnType<typeof db>, "select" | "update" | "delete">;

export interface EnrollmentRequest {
  publicKey: string;
  deviceName: string;
  platform: string;
}

export interface PendingEnrollment {
  id: string;
  code: string;
  expiresAt: Date;
}

/**
 * Step one of enrollment, started by the device itself.
 *
 * This deliberately requires no authentication — a machine being set up has no
 * credentials yet. It is safe because the request grants nothing: it only
 * parks a public key until a signed-in user approves the code out of band.
 */
export async function requestEnrollment(
  input: EnrollmentRequest
): Promise<PendingEnrollment> {
  if (!isValidPublicKey(input.publicKey)) {
    throw AppError.badRequest("publicKey must be a base64 Ed25519 SPKI key");
  }

  const existing = await db()
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.publicKey, input.publicKey))
    .limit(1);

  if (existing.length > 0) {
    throw AppError.conflict("This device is already enrolled");
  }

  const expiresAt = new Date(Date.now() + config().enrollmentCodeTtlSeconds * 1000);

  // Retry on the vanishingly rare code collision rather than failing the
  // enrollment, since the code space is small enough to matter eventually.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generatePairingCode(randomBytes(8));
    const [row] = await db()
      .insert(deviceEnrollments)
      .values({
        code,
        publicKey: input.publicKey,
        deviceName: input.deviceName,
        platform: input.platform,
        expiresAt,
      })
      .onConflictDoNothing({ target: deviceEnrollments.code })
      .returning();

    if (row) return { id: row.id, code: row.code, expiresAt: row.expiresAt };
  }

  throw new AppError(500, "SERVER", "Could not allocate a pairing code");
}

export type EnrollmentView = {
  id: string;
  status: string;
  deviceName: string;
  platform: string;
  expiresAt: Date;
  deviceId: string | null;
};

/** Marks an enrollment expired once its window has passed. */
function withExpiry(row: DeviceEnrollment): DeviceEnrollment {
  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    return { ...row, status: "expired" };
  }
  return row;
}

/**
 * Polled by the device while it waits for approval.
 *
 * Keyed by the enrollment's own public key so only the device that started it
 * can watch it — the id alone is not treated as a secret.
 */
export async function getEnrollmentStatus(
  enrollmentId: string,
  publicKey: string
): Promise<EnrollmentView> {
  const [row] = await db()
    .select()
    .from(deviceEnrollments)
    .where(
      and(
        eq(deviceEnrollments.id, enrollmentId),
        eq(deviceEnrollments.publicKey, publicKey)
      )
    )
    .limit(1);

  if (!row) throw AppError.notFound("Enrollment not found");

  const current = withExpiry(row);
  return {
    id: current.id,
    status: current.status,
    deviceName: current.deviceName,
    platform: current.platform,
    expiresAt: current.expiresAt,
    deviceId: current.deviceId,
  };
}

export async function listPendingEnrollments(
  ownerId: string
): Promise<EnrollmentView[]> {
  await ensureVaultForOwner(ownerId);

  const rows = await db()
    .select()
    .from(deviceEnrollments)
    .where(eq(deviceEnrollments.status, "pending"));

  return rows
    .map(withExpiry)
    .filter((row) => row.status === "pending")
    .map((row) => ({
      id: row.id,
      status: row.status,
      deviceName: row.deviceName,
      platform: row.platform,
      expiresAt: row.expiresAt,
      deviceId: row.deviceId,
    }));
}

/**
 * Step two: a signed-in user approves the code, and the device joins the vault.
 *
 * Runs in one transaction so a device row can never exist without its
 * enrollment being consumed, which would let the same code be redeemed twice.
 */
export async function approveEnrollment(
  ownerId: string,
  code: string,
  allocatedBytes: number
): Promise<Device> {
  const vault = await ensureVaultForOwner(ownerId);

  // Expiry is settled before the transaction opens, not inside it. Throwing
  // from a transaction callback rolls the whole thing back, which would
  // discard the very row update that records the expiry — leaving the code
  // pending forever and reporting a stale code as merely unknown.
  const pending = await db()
    .select()
    .from(deviceEnrollments)
    .where(eq(deviceEnrollments.status, "pending"));

  const stale = pending.find(
    (row) => codesMatch(row.code, code) && row.expiresAt.getTime() <= Date.now()
  );
  if (stale) {
    await db()
      .update(deviceEnrollments)
      .set({ status: "expired" })
      .where(eq(deviceEnrollments.id, stale.id));
    throw AppError.badRequest("That pairing code has expired");
  }

  return db().transaction(async (tx) => {
    // Re-read under a row lock: the check above is advisory, this is the one
    // that makes redeeming a code exactly-once under concurrency.
    const candidates = await tx
      .select()
      .from(deviceEnrollments)
      .where(eq(deviceEnrollments.status, "pending"))
      .for("update");

    const match = candidates.find((row) => codesMatch(row.code, code));
    if (!match) throw AppError.notFound("No pending enrollment with that code");
    if (match.expiresAt.getTime() <= Date.now()) {
      throw AppError.badRequest("That pairing code has expired");
    }

    const [device] = await tx
      .insert(devices)
      .values({
        vaultId: vault.id,
        name: match.deviceName,
        platform: match.platform,
        publicKey: match.publicKey,
        status: "offline",
      })
      .returning();

    if (!device) throw new AppError(500, "SERVER", "Device could not be created");

    await tx.insert(deviceStorageAllocations).values({
      deviceId: device.id,
      allocatedBytes,
    });

    await tx
      .update(deviceEnrollments)
      .set({
        status: "consumed",
        vaultId: vault.id,
        deviceId: device.id,
        approvedAt: new Date(),
      })
      .where(eq(deviceEnrollments.id, match.id));

    return device;
  });
}

export async function rejectEnrollment(ownerId: string, code: string): Promise<void> {
  await ensureVaultForOwner(ownerId);

  const pending = await db()
    .select()
    .from(deviceEnrollments)
    .where(eq(deviceEnrollments.status, "pending"));

  const match = pending.find((row) => codesMatch(row.code, code));
  if (!match) throw AppError.notFound("No pending enrollment with that code");

  await db()
    .update(deviceEnrollments)
    .set({ status: "rejected" })
    .where(eq(deviceEnrollments.id, match.id));
}

export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  status: string;
  allocatedBytes: number;
  usedBytes: number;
  lastSeenAt: Date | null;
  appVersion: string | null;
  /** True when required healthy copies no longer depend on this draining node. */
  removalReady: boolean;
}

/**
 * Devices in the caller's vault.
 *
 * Status is derived at read time from `lastSeenAt` rather than trusted from the
 * stored column: a device that crashes never gets to say it went offline, so a
 * stored status would stay "online" forever.
 */
export async function listDevices(ownerId: string): Promise<DeviceView[]> {
  const vault = await ensureVaultForOwner(ownerId);
  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;

  const rows = await db()
    .select({
      id: devices.id,
      vaultId: devices.vaultId,
      name: devices.name,
      platform: devices.platform,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      appVersion: devices.appVersion,
      allocatedBytes: deviceStorageAllocations.allocatedBytes,
      usedBytes: deviceStorageAllocations.usedBytes,
    })
    .from(devices)
    .leftJoin(
      deviceStorageAllocations,
      eq(deviceStorageAllocations.deviceId, devices.id)
    )
    .where(and(eq(devices.vaultId, vault.id), sql`${devices.status} <> 'removed'`));

  const readyToDisconnect = new Set(
    await Promise.all(
      rows
        .filter((row) => row.status === "draining")
        .map(async (row) =>
          (await isReadyToDisconnect(row.vaultId, row.id)) ? row.id : null
        )
    )
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    status: deriveStatus(row.status, row.lastSeenAt, offlineAfterMs),
    allocatedBytes: Number(row.allocatedBytes ?? 0),
    usedBytes: Number(row.usedBytes ?? 0),
    lastSeenAt: row.lastSeenAt,
    appVersion: row.appVersion,
    removalReady: readyToDisconnect.has(row.id),
  }));
}

/**
 * A draining device is only ready to disconnect once every object it held has
 * the policy's healthy copies elsewhere. There is no erase/GC transport yet,
 * so this is deliberately a readiness signal rather than a destructive state
 * transition.
 */
async function isReadyToDisconnect(vaultId: string, deviceId: string): Promise<boolean> {
  const [policy] = await db()
    .select({ mode: storagePolicies.mode })
    .from(storagePolicies)
    .where(eq(storagePolicies.vaultId, vaultId))
    .limit(1);
  const desiredReplicas = REPLICAS_FOR_MODE[policy?.mode as keyof typeof REPLICAS_FOR_MODE] ?? 2;

  const rows = await db()
    .select({
      objectHash: replicas.objectHash,
      deviceId: replicas.deviceId,
      status: replicas.status,
      deviceStatus: devices.status,
    })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(eq(replicas.vaultId, vaultId));

  const objectHashes = new Set(
    rows
      .filter(
        (row) =>
          row.deviceId === deviceId &&
          row.status !== "corrupt" &&
          row.status !== "lost"
      )
      .map((row) => row.objectHash)
  );

  for (const objectHash of objectHashes) {
    const healthyElsewhere = rows.filter(
      (row) =>
        row.objectHash === objectHash &&
        row.deviceId !== deviceId &&
        row.status === "healthy" &&
        row.deviceStatus !== "draining" &&
        row.deviceStatus !== "removed"
    ).length;
    if (healthyElsewhere < desiredReplicas) return false;
  }
  return true;
}

/** Terminal and in-progress states are authoritative; only liveness is derived. */
export function deriveStatus(
  stored: string,
  lastSeenAt: Date | null,
  offlineAfterMs: number
): string {
  if (stored === "draining" || stored === "removed" || stored === "suspected_lost") {
    return stored;
  }
  if (!lastSeenAt) return "pending";
  return Date.now() - lastSeenAt.getTime() <= offlineAfterMs ? "online" : "offline";
}

export interface HeartbeatInput {
  usedBytes?: number;
  availableBytes?: number;
  appVersion?: string;
  /**
   * Where peers can reach this device's transfer server. Advertised by the
   * device rather than inferred from the request's source address, which NAT
   * would make wrong.
   */
  advertisedUrl?: string;
}

/**
 * Presence, sent by the node agent on a timer.
 *
 * A draining or removed device is not flipped back to online by a late
 * heartbeat, so a device being retired cannot resurrect itself mid-drain.
 */
export async function recordHeartbeat(
  deviceId: string,
  input: HeartbeatInput
): Promise<{ status: string }> {
  const now = new Date();

  const [device] = await db()
    .update(devices)
    .set({
      lastSeenAt: now,
      updatedAt: now,
      ...(input.appVersion ? { appVersion: input.appVersion } : {}),
      ...(input.advertisedUrl ? { advertisedUrl: input.advertisedUrl } : {}),
      status: sql`case when ${devices.status} in ('draining','removed')
                       then ${devices.status} else 'online' end`,
    })
    .where(eq(devices.id, deviceId))
    .returning();

  if (!device) throw AppError.notFound("Device not found");

  if (typeof input.usedBytes === "number") {
    await db()
      .update(deviceStorageAllocations)
      .set({ usedBytes: input.usedBytes, usageReportedAt: now, updatedAt: now })
      .where(eq(deviceStorageAllocations.deviceId, deviceId));
  }

  return { status: device.status };
}

/**
 * Changes how much disk a device contributes.
 *
 * Refuses to shrink below what the device is already storing: the control plane
 * cannot make bytes disappear, and quietly accepting the change would leave the
 * allocation lying about reality until a rebalance that may never come.
 */
export async function setAllocation(
  ownerId: string,
  deviceId: string,
  allocatedBytes: number
): Promise<DeviceView> {
  const vault = await ensureVaultForOwner(ownerId);

  const updated = await db().transaction(async (tx) => {
    // Match placement, repair, and drain lock ordering: device first, then
    // allocation. The occupied-byte calculation is therefore stable while
    // this resize decision is made.
    const [device] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.vaultId, vault.id)))
      .for("update")
      .limit(1);
    if (!device) throw AppError.notFound("Device not found");

    const allocationTable = alias(deviceStorageAllocations, "set_allocation");
    const [allocation] = await tx
      .select({
        allocatedBytes: allocationTable.allocatedBytes,
        occupiedBytes: occupiedBytesSql("set_allocation"),
      })
      .from(allocationTable)
      .where(eq(allocationTable.deviceId, deviceId))
      .for("update")
      .limit(1);
    if (!allocation) throw AppError.notFound("Storage allocation not found");

    if (allocatedBytes < Number(allocation.occupiedBytes)) {
      throw AppError.conflict(
        `Cannot reduce the allocation to ${allocatedBytes} bytes: the device is ` +
          `already storing ${Number(allocation.occupiedBytes)} bytes`
      );
    }

    const [changed] = await tx
      .update(deviceStorageAllocations)
      .set({ allocatedBytes, updatedAt: new Date() })
      .where(eq(deviceStorageAllocations.deviceId, deviceId))
      .returning();
    return changed;
  });
  if (!updated) throw AppError.notFound("Storage allocation not found");

  const all = await listDevices(ownerId);
  const view = all.find((d) => d.id === deviceId);
  if (!view) throw AppError.notFound("Device not found");
  return view;
}

/**
 * Begins retiring a device.
 *
 * Marked `draining` rather than deleted: repair agents recreate its replicas
 * elsewhere before the device can safely disconnect. Removing the row outright
 * would silently drop metadata, and no erase/GC transport exists yet.
 */
export async function beginDeviceRemoval(
  ownerId: string,
  deviceId: string
): Promise<DeviceView> {
  const vault = await ensureVaultForOwner(ownerId);

  const updated = await db().transaction(async (tx) => {
    // Lock every device and allocation in the vault in the same order used by
    // reservations. This makes the capacity preflight and drain transition one
    // indivisible decision against concurrent uploads or another drain.
    const lockedDevices = await tx
      .select({ id: devices.id, status: devices.status })
      .from(devices)
      .where(eq(devices.vaultId, vault.id))
      .orderBy(asc(devices.id))
      .for("update");
    if (!lockedDevices.some((device) => device.id === deviceId)) {
      throw AppError.notFound("Device not found");
    }
    if (lockedDevices.some((device) => device.id === deviceId && device.status === "removed")) {
      throw AppError.conflict("Device has already been removed");
    }
    await tx
      .select({ deviceId: deviceStorageAllocations.deviceId })
      .from(deviceStorageAllocations)
      .innerJoin(devices, eq(devices.id, deviceStorageAllocations.deviceId))
      .where(eq(devices.vaultId, vault.id))
      .orderBy(asc(deviceStorageAllocations.deviceId))
      .for("update");

    await ensureRemovalCapacity(vault.id, deviceId, tx);

    const [row] = await tx
      .update(devices)
      .set({ status: "draining", updatedAt: new Date() })
      .where(and(eq(devices.id, deviceId), eq(devices.vaultId, vault.id)))
      .returning();
    return row;
  });

  if (!updated) throw AppError.notFound("Device not found");

  const all = await listDevices(ownerId);
  const view = all.find((d) => d.id === deviceId);
  if (!view) throw AppError.notFound("Device not found");
  return view;
}

/**
 * Refuses to start draining when the remaining online devices cannot take the
 * copies that would leave with this device. This is intentionally a
 * conservative whole-file check; repair agents will do the actual movement.
 */
async function ensureRemovalCapacity(
  vaultId: string,
  deviceId: string,
  executor: DbExecutor = db()
): Promise<void> {
  const [device] = await executor
    .select({ status: devices.status })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.vaultId, vaultId)))
    .limit(1);
  if (!device || device.status === "draining") return;

  const [policy] = await executor
    .select({ mode: storagePolicies.mode })
    .from(storagePolicies)
    .where(eq(storagePolicies.vaultId, vaultId))
    .limit(1);
  const desiredReplicas = REPLICAS_FOR_MODE[policy?.mode as keyof typeof REPLICAS_FOR_MODE] ?? 2;

  // A grant has expired by this point, so an abandoned placement must not
  // reserve capacity forever or prevent a safe drain from starting.
  await executor
    .delete(replicas)
    .where(
      and(
        eq(replicas.vaultId, vaultId),
        eq(replicas.status, "placing"),
        lt(
          replicas.updatedAt,
          new Date(Date.now() - config().transferGrantTtlSeconds * 1000)
        )
      )
    );

  const replicaRows = await executor
    .select({
      objectHash: replicas.objectHash,
      deviceId: replicas.deviceId,
      sizeBytes: replicas.sizeBytes,
      replicaStatus: replicas.status,
      deviceStatus: devices.status,
    })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(eq(replicas.vaultId, vaultId));

  const leavingReplicas = replicaRows.filter(
    (row) => row.deviceId === deviceId && row.replicaStatus === "healthy"
  );
  if (leavingReplicas.length === 0) return;

  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;
  const allocationTable = alias(deviceStorageAllocations, "drain_allocation");
  const candidateRows = await executor
    .select({
      id: devices.id,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      allocatedBytes: allocationTable.allocatedBytes,
      occupiedBytes: occupiedBytesSql("drain_allocation"),
    })
    .from(devices)
    .leftJoin(allocationTable, eq(allocationTable.deviceId, devices.id))
    .where(and(eq(devices.vaultId, vaultId), sql`${devices.id} <> ${deviceId}`));

  const remainingBytes = new Map(
    candidateRows.map((candidate) => [
      candidate.id,
      Math.max(
        0,
        Number(candidate.allocatedBytes ?? 0) -
          Number(candidate.occupiedBytes ?? 0)
      ),
    ])
  );

  // Place the most constrained objects first, consuming a candidate's
  // remaining bytes as we go. This is conservative but prevents two separate
  // objects from each believing they can consume the same last free gigabyte.
  const requirements = leavingReplicas
    .map((leaving) => {
      const activeElsewhere = replicaRows.filter(
        (row) =>
          row.objectHash === leaving.objectHash &&
          row.deviceId !== deviceId &&
          row.replicaStatus === "healthy" &&
          row.deviceStatus !== "draining" &&
          row.deviceStatus !== "removed"
      ).length;
      const required = Math.max(0, desiredReplicas - activeElsewhere);
      const occupiedDeviceIds = new Set(
        replicaRows
          .filter(
            (row) =>
              row.objectHash === leaving.objectHash &&
              row.replicaStatus !== "corrupt" &&
              row.replicaStatus !== "lost"
          )
          .map((row) => row.deviceId)
      );
      const eligible = candidateRows.filter(
        (candidate) =>
          !occupiedDeviceIds.has(candidate.id) &&
          deriveStatus(candidate.status, candidate.lastSeenAt, offlineAfterMs) === "online" &&
          (remainingBytes.get(candidate.id) ?? 0) >= Number(leaving.sizeBytes)
      );
      return { leaving, required, eligibleCount: eligible.length };
    })
    .filter((item) => item.required > 0)
    .sort((a, b) => a.eligibleCount - b.eligibleCount);

  const blocked = [];
  for (const requirement of requirements) {
    const { leaving, required } = requirement;
    const occupiedDeviceIds = new Set(
      replicaRows
        .filter(
          (row) =>
            row.objectHash === leaving.objectHash &&
            row.replicaStatus !== "corrupt" &&
            row.replicaStatus !== "lost"
        )
        .map((row) => row.deviceId)
    );
    const targets = candidateRows
      .filter(
        (candidate) =>
          !occupiedDeviceIds.has(candidate.id) &&
          deriveStatus(candidate.status, candidate.lastSeenAt, offlineAfterMs) === "online" &&
          (remainingBytes.get(candidate.id) ?? 0) >= Number(leaving.sizeBytes)
      )
      .sort(
        (a, b) =>
          (remainingBytes.get(b.id) ?? 0) - (remainingBytes.get(a.id) ?? 0)
      )
      .slice(0, required);

    if (targets.length < required) {
      blocked.push({
        objectHash: leaving.objectHash,
        required,
        availableTargets: targets.length,
      });
      continue;
    }
    for (const target of targets) {
      remainingBytes.set(
        target.id,
        (remainingBytes.get(target.id) ?? 0) - Number(leaving.sizeBytes)
      );
    }
  }

  if (blocked.length > 0) {
    throw AppError.conflict(
      "Insufficient capacity to protect all data before removing this device",
      { reason: "insufficient_capacity", objects: blocked }
    );
  }
}

/** Looks up a device by its public key, for signature-authenticated requests. */
export async function findDeviceByPublicKey(
  publicKey: string
): Promise<Device | null> {
  const [device] = await db()
    .select()
    .from(devices)
    .where(eq(devices.publicKey, publicKey))
    .limit(1);
  return device ?? null;
}

export async function findDeviceById(deviceId: string): Promise<Device | null> {
  const [device] = await db()
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return device ?? null;
}

/** Resolves the owner of a device's vault, for authorising device requests. */
export async function ownerOfDevice(deviceId: string): Promise<string | null> {
  const [row] = await db()
    .select({ ownerId: vaults.ownerId })
    .from(devices)
    .innerJoin(vaults, eq(vaults.id, devices.vaultId))
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row?.ownerId ?? null;
}
