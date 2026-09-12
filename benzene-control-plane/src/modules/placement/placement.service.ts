import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import {
  REPLICAS_FOR_MODE,
  deviceStorageAllocations,
  devices,
  replicas,
  storagePolicies,
  type ProtectionMode,
  type Replica,
  type StoragePolicy,
} from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";
import {
  classifyDeviceOutages,
  deriveStatus,
} from "../devices/devices.service.js";
import { ensureVaultForOwner } from "../vaults/vaults.service.js";
import { occupiedBytesSql } from "./capacity.js";
import {
  isSingleCopyPolicy,
  availabilityState,
  planPlacement,
  protectionState,
  type AvailabilityState,
  type PlacementCandidate,
  type PlacementPlan,
  type ProtectionState,
} from "./placement.js";

/** Returns the vault's policy, creating the default on first read. */
export async function getPolicy(ownerId: string): Promise<StoragePolicy> {
  const vault = await ensureVaultForOwner(ownerId);

  const [created] = await db()
    .insert(storagePolicies)
    .values({ vaultId: vault.id })
    .onConflictDoNothing({ target: storagePolicies.vaultId })
    .returning();

  if (created) return created;

  const [existing] = await db()
    .select()
    .from(storagePolicies)
    .where(eq(storagePolicies.vaultId, vault.id))
    .limit(1);

  if (!existing) throw new AppError(500, "SERVER", "Policy could not be loaded");
  return existing;
}

export async function setPolicy(
  ownerId: string,
  input: { mode: ProtectionMode; cloudProtection?: boolean }
): Promise<StoragePolicy> {
  const vault = await ensureVaultForOwner(ownerId);
  await getPolicy(ownerId);

  const [updated] = await db()
    .update(storagePolicies)
    .set({
      mode: input.mode,
      ...(typeof input.cloudProtection === "boolean"
        ? { cloudProtection: input.cloudProtection }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(storagePolicies.vaultId, vault.id))
    .returning();

  if (!updated) throw AppError.notFound("Policy not found");
  return updated;
}

export function replicasForMode(mode: string): number {
  return REPLICAS_FOR_MODE[mode as ProtectionMode] ?? REPLICAS_FOR_MODE.protected;
}

/**
 * Loads every device in the vault as a placement candidate.
 *
 * Liveness is derived from `lastSeenAt` here for the same reason the device
 * listing derives it: a machine that crashed never announced it went offline,
 * and placing data on it would silently fail.
 */
async function loadCandidates(vaultId: string): Promise<PlacementCandidate[]> {
  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;
  const allocation = alias(deviceStorageAllocations, "placement_allocation");

  const rows = await db()
    .select({
      deviceId: devices.id,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      advertisedUrl: devices.advertisedUrl,
      allocatedBytes: allocation.allocatedBytes,
      // Heartbeats are a watermark: reservations and possessions confirmed
      // after the report are added without double-counting older healthy rows.
      usedBytes: occupiedBytesSql("placement_allocation"),
      replicaCount: sql<number>`(
        select count(*)::int from ${replicas}
        where ${replicas.deviceId} = ${devices.id}
          and ${replicas.status} = 'healthy'
      )`,
    })
    .from(devices)
    .leftJoin(
      allocation,
      eq(allocation.deviceId, devices.id)
    )
    .where(and(eq(devices.vaultId, vaultId), sql`${devices.status} <> 'removed'`));

  return rows.map((row) => {
    const status = deriveStatus(row.status, row.lastSeenAt, offlineAfterMs);
    return {
      deviceId: row.deviceId,
      online: status === "online",
      draining: status === "draining",
      allocatedBytes: Number(row.allocatedBytes ?? 0),
      usedBytes: Number(row.usedBytes ?? 0),
      replicaCount: Number(row.replicaCount ?? 0),
      reachable: Boolean(row.advertisedUrl),
    };
  });
}

export interface PlacementDecision extends PlacementPlan {
  objectHash: string;
  mode: string;
  /** True when the chosen policy keeps only one copy. */
  singleCopy: boolean;
  /** Devices already holding these bytes, which are reused rather than re-sent. */
  existingDeviceIds: string[];
}

/**
 * Decides where an object should live.
 *
 * Existing replicas are counted rather than ignored, so re-uploading identical
 * bytes places only the copies still missing instead of duplicating work — the
 * natural consequence of addressing objects by content hash.
 */
export async function decidePlacement(
  ownerId: string,
  input: { objectHash: string; sizeBytes: number },
  options: { requireReachable?: boolean } = {}
): Promise<PlacementDecision> {
  const vault = await ensureVaultForOwner(ownerId);
  await classifyDeviceOutages(vault.id);
  const policy = await getPolicy(ownerId);
  const desiredReplicas = replicasForMode(policy.mode);

  // A browser can disappear after receiving a plan. Do not let that abandoned
  // reservation consume the unique (vault, object, device) slot forever.
  await db()
    .delete(replicas)
    .where(
      and(
        eq(replicas.vaultId, vault.id),
        eq(replicas.status, "placing"),
        lt(
          replicas.updatedAt,
          new Date(Date.now() - config().transferGrantTtlSeconds * 1000)
        )
      )
    );

  const held = await db()
    .select({ deviceId: replicas.deviceId })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(
      and(
        eq(replicas.vaultId, vault.id),
        eq(replicas.objectHash, input.objectHash),
        // A reservation is not possession. Only a device-confirmed copy may
        // satisfy the policy or be reported as already held. A draining copy
        // is deliberately excluded because it is scheduled to leave.
        eq(replicas.status, "healthy"),
        sql`${devices.status} not in ('draining', 'removed', 'suspected_lost')`
      )
    );

  const existingDeviceIds = held.map((row) => row.deviceId);
  const candidates = await loadCandidates(vault.id);

  const plan = planPlacement(candidates, {
    sizeBytes: input.sizeBytes,
    desiredReplicas,
    existingDeviceIds,
  }, options);

  return {
    ...plan,
    objectHash: input.objectHash,
    mode: policy.mode,
    singleCopy: isSingleCopyPolicy(desiredReplicas),
    existingDeviceIds,
  };
}

/**
 * Reserves the chosen devices before any bytes move.
 *
 * Rows are written as `placing` so a transfer that never completes is visible
 * as an unfinished placement rather than looking like a healthy replica, and so
 * concurrent placements of the same object see each other's reservations.
 */
export async function reservePlacement(
  ownerId: string,
  input: { objectHash: string; sizeBytes: number; deviceIds: string[] },
  options: { requireReachable?: boolean; holdDeviceIds?: string[] } = {}
): Promise<Replica[]> {
  const vault = await ensureVaultForOwner(ownerId);
  await classifyDeviceOutages(vault.id);
  const deviceIds = [...new Set(input.deviceIds)];
  const holdDeviceIds = [...new Set(options.holdDeviceIds ?? [])];
  const lockDeviceIds = [...new Set([...deviceIds, ...holdDeviceIds])].sort();
  if (lockDeviceIds.length === 0) return [];

  return db().transaction(async (tx) => {
    const allocation = alias(deviceStorageAllocations, "reserve_allocation");
    // Re-check lifecycle and liveness under row locks. A caller may have
    // received a plan before the owner started draining a device; ownership
    // alone must never make that stale plan reservable.
    const lockedDevices = await tx
      .select({
        id: devices.id,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        advertisedUrl: devices.advertisedUrl,
      })
      .from(devices)
      .where(and(eq(devices.vaultId, vault.id), inArray(devices.id, lockDeviceIds)))
      .orderBy(asc(devices.id))
      .for("update");
    if (lockedDevices.length !== lockDeviceIds.length) {
      throw AppError.badRequest("One or more devices are not part of this vault");
    }
    if (
      lockedDevices.some(
        (device) =>
          device.status === "draining" ||
          device.status === "removed" ||
          device.status === "suspected_lost"
      )
    ) {
      throw AppError.conflict("One or more devices are no longer accepting placements");
    }
    if (options.requireReachable) {
      const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;
      const reservableIds = new Set(deviceIds);
      const unreachable = lockedDevices.filter((device) => reservableIds.has(device.id)).some(
        (device) =>
          !device.advertisedUrl ||
          deriveStatus(device.status, device.lastSeenAt, offlineAfterMs) !== "online"
      );
      if (unreachable) throw AppError.badRequest("One or more devices cannot receive transfers");
    }

    // Lock allocations in stable order. The row lock serialises capacity
    // checks for different objects while the unique index makes same-object
    // retries idempotent.
    const lockedAllocations = await tx
      .select({
        id: allocation.id,
        deviceId: allocation.deviceId,
        allocatedBytes: allocation.allocatedBytes,
        usedBytes: allocation.usedBytes,
        usageReportedAt: allocation.usageReportedAt,
        occupiedBytes: occupiedBytesSql("reserve_allocation"),
      })
      .from(allocation)
      .where(inArray(allocation.deviceId, deviceIds.sort()))
      .orderBy(asc(allocation.deviceId))
      .for("update");
    const allocationByDevice = new Map(
      lockedAllocations.map((allocation) => [allocation.deviceId, allocation])
    );
    if (holdDeviceIds.length > 0) {
      const heldRows = await tx
        .select({ deviceId: replicas.deviceId, status: replicas.status })
        .from(replicas)
        .where(
          and(
            eq(replicas.vaultId, vault.id),
            eq(replicas.objectHash, input.objectHash),
            inArray(replicas.deviceId, holdDeviceIds)
          )
        )
        .for("update");
      const heldByDevice = new Map(heldRows.map((row) => [row.deviceId, row.status]));
      if (holdDeviceIds.some((deviceId) => heldByDevice.get(deviceId) !== "healthy")) {
        throw AppError.conflict("An existing replica changed before placement could be reserved");
      }
    }
    const existingRows = await tx
      .select({
        id: replicas.id,
        deviceId: replicas.deviceId,
        status: replicas.status,
        sizeBytes: replicas.sizeBytes,
      })
      .from(replicas)
      .where(
        and(
          eq(replicas.vaultId, vault.id),
          eq(replicas.objectHash, input.objectHash),
          inArray(replicas.deviceId, deviceIds)
        )
      )
      .for("update");
    const existingDevices = new Set(existingRows.map((row) => row.deviceId));
    const reusableExistingDevices = new Set(
      existingRows
        .filter((row) => row.status === "healthy" || row.status === "placing")
        .map((row) => row.deviceId)
    );
    const replacementCreditByDevice = new Map<string, number>();
    for (const row of existingRows) {
      if (row.status === "corrupt" && Number(row.sizeBytes) === input.sizeBytes) {
        replacementCreditByDevice.set(row.deviceId, Number(row.sizeBytes));
      }
    }

    for (const deviceId of deviceIds) {
      const allocation = allocationByDevice.get(deviceId);
      if (!allocation) throw AppError.badRequest("Device has no storage allocation");
      const availableBytes = Math.max(
        0,
        Number(allocation.allocatedBytes) -
          Number(allocation.occupiedBytes) +
          (replacementCreditByDevice.get(deviceId) ?? 0)
      );
      if (!reusableExistingDevices.has(deviceId) && input.sizeBytes > availableBytes) {
        throw AppError.conflict("Insufficient capacity for the requested placement", {
          reason: "insufficient_capacity",
        });
      }
    }

    const reopened: Replica[] = [];
    for (const row of existingRows) {
      if (row.status === "healthy" || row.status === "placing") continue;
      const [updated] = await tx
        .update(replicas)
        .set({
          status: "placing",
          sizeBytes: input.sizeBytes,
          verifiedAt: null,
          repairSourceDeviceId: null,
          repairAssignmentId: null,
          updatedAt: new Date(),
        })
        .where(eq(replicas.id, row.id))
        .returning();
      if (updated) reopened.push(updated);
    }

    const newDeviceIds = deviceIds.filter((deviceId) => !existingDevices.has(deviceId));
    if (newDeviceIds.length === 0) return reopened;

    const inserted = await tx
      .insert(replicas)
      .values(
        newDeviceIds.map((deviceId) => ({
          vaultId: vault.id,
          objectHash: input.objectHash,
          deviceId,
          sizeBytes: input.sizeBytes,
          status: "placing" as const,
        }))
      )
      // A concurrent placement may already have reserved the same pair; the
      // unique index is what actually enforces one replica per device.
      .onConflictDoNothing({
        target: [replicas.vaultId, replicas.objectHash, replicas.deviceId],
      })
      .returning();
    return [...reopened, ...inserted];
  });
}

/** Marks a replica healthy once the device confirms it holds the bytes. */
export async function confirmReplica(
  ownerId: string,
  input: { objectHash: string; deviceId: string; sizeBytes?: number }
): Promise<Replica> {
  const vault = await ensureVaultForOwner(ownerId);
  const now = new Date();

  const [updated] = await db()
    .update(replicas)
    .set({
      status: "healthy",
      verifiedAt: now,
      updatedAt: now,
      repairSourceDeviceId: null,
      repairAssignmentId: null,
      ...(typeof input.sizeBytes === "number" ? { sizeBytes: input.sizeBytes } : {}),
    })
    .where(
      and(
        eq(replicas.vaultId, vault.id),
        eq(replicas.objectHash, input.objectHash),
        eq(replicas.deviceId, input.deviceId)
      )
    )
    .returning();

  if (!updated) throw AppError.notFound("No placement reserved for that device");
  return updated;
}

/**
 * Promotes a reservation on behalf of an authenticated device.
 *
 * The user-facing placement API intentionally cannot call this function:
 * possession is evidence from the node that accepted and hash-checked the
 * bytes, not an assertion a browser can make after receiving a grant.
 */
export async function confirmReplicaForDevice(
  deviceId: string,
  input: { objectHash: string; sizeBytes: number }
): Promise<Replica> {
  const [knownDevice] = await db()
    .select({ vaultId: devices.vaultId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!knownDevice) throw AppError.notFound("Device not found");
  await classifyDeviceOutages(knownDevice.vaultId);

  return db().transaction(async (tx) => {
    const [device] = await tx
      .select({ status: devices.status })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .for("update")
      .limit(1);
    if (!device) throw AppError.notFound("Device not found");
    if (device.status === "suspected_lost") {
      throw AppError.conflict("A presumed-lost device must reconcile its inventory before possession reports");
    }

    // The failure report and possession report race on the same durable row.
    // Lock it before deciding which state may be acknowledged: otherwise a
    // stale possession can select `placing`, wait behind a failure report that
    // changes it to `missing`, and then promote that no-longer-valid row to
    // `healthy` with an update keyed only by id.
    const [replica] = await tx
      .select()
      .from(replicas)
      .where(
        and(
          eq(replicas.objectHash, input.objectHash),
          eq(replicas.deviceId, deviceId)
        )
      )
      .limit(1)
      .for("update");

    if (!replica) throw AppError.notFound("No placement reserved for that device");
    if (Number(replica.sizeBytes) !== input.sizeBytes) {
      throw AppError.badRequest("Possession size does not match the reservation");
    }

    if (replica.status === "healthy") return replica;
    if (replica.status !== "placing") {
      throw AppError.notFound("No placement reserved for that device");
    }

    const now = new Date();
    const [updated] = await tx
      .update(replicas)
      .set({
        status: "healthy",
        verifiedAt: now,
        updatedAt: now,
        repairSourceDeviceId: null,
        repairAssignmentId: null,
      })
      .where(and(eq(replicas.id, replica.id), eq(replicas.status, "placing")))
      .returning();
    if (updated) return updated;

    // The row lock should make this unreachable, but retain a typed failure if
    // the database reports that another state transition won unexpectedly.
    throw AppError.conflict("Replica reservation changed before possession could be confirmed");
  });
}

export interface ObjectProtection {
  objectHash: string;
  desiredReplicas: number;
  healthyReplicas: number;
  reachableHealthyReplicas: number;
  placingReplicas: number;
  state: ProtectionState;
  availability: AvailabilityState;
  deviceIds: string[];
}

/** Protection health for one object, as product §23 presents it. */
export async function getObjectProtection(
  ownerId: string,
  objectHash: string
): Promise<ObjectProtection> {
  const vault = await ensureVaultForOwner(ownerId);
  await classifyDeviceOutages(vault.id);
  const policy = await getPolicy(ownerId);
  const desiredReplicas = replicasForMode(policy.mode);
  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;

  const rows = await db()
    .select({
      deviceId: replicas.deviceId,
      status: replicas.status,
      deviceStatus: devices.status,
      lastSeenAt: devices.lastSeenAt,
      advertisedUrl: devices.advertisedUrl,
    })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(
      and(eq(replicas.vaultId, vault.id), eq(replicas.objectHash, objectHash))
    );

  // A replica on an offline device still counts as healthy: architecture §41
  // is explicit that offline is not the same as lost, and treating it as lost
  // would trigger pointless repairs every time a laptop closes.
  const healthy = rows.filter(
    (row) =>
      row.status === "healthy" &&
      !leavingStatus(row.deviceStatus) &&
      row.deviceStatus !== "suspected_lost"
  );
  const placing = rows.filter(
    (row) =>
      row.status === "placing" &&
      !leavingStatus(row.deviceStatus) &&
      row.deviceStatus !== "suspected_lost"
  );
  const reachableHealthy = healthy.filter(
    (row) =>
      Boolean(row.advertisedUrl) &&
      deriveStatus(row.deviceStatus, row.lastSeenAt, offlineAfterMs) === "online"
  );

  return {
    objectHash,
    desiredReplicas,
    healthyReplicas: healthy.length,
    reachableHealthyReplicas: reachableHealthy.length,
    placingReplicas: placing.length,
    state: protectionState({ desiredReplicas, healthyReplicas: healthy.length }),
    availability: availabilityState({
      desiredReplicas,
      healthyReplicas: healthy.length,
      reachableHealthyReplicas: reachableHealthy.length,
      placingReplicas: placing.length,
    }),
    deviceIds: rows
      .filter((row) => deriveStatus(row.deviceStatus, row.lastSeenAt, offlineAfterMs) !== "removed")
      .map((row) => row.deviceId),
  };
}

function leavingStatus(status: string): boolean {
  return status === "draining" || status === "removed";
}

export interface VaultProtectionSummary {
  mode: string;
  desiredReplicas: number;
  singleCopy: boolean;
  totalObjects: number;
  healthyObjects: number;
  degradedObjects: number;
  atRiskObjects: number;
  state: ProtectionState | "empty";
}

/**
 * Vault-wide protection, for the headline status on the Vault screen.
 *
 * Reported as the worst state across objects, because "everything protected"
 * must not be shown while a single file is one failure from being lost.
 */
export async function getVaultProtection(
  ownerId: string
): Promise<VaultProtectionSummary> {
  const vault = await ensureVaultForOwner(ownerId);
  await classifyDeviceOutages(vault.id);
  const policy = await getPolicy(ownerId);
  const desiredReplicas = replicasForMode(policy.mode);

  const rows = await db()
    .select({
      objectHash: replicas.objectHash,
      healthy: sql<number>`count(*) filter (
        where ${replicas.status} = 'healthy'
          and ${devices.status} not in ('draining', 'removed', 'suspected_lost')
      )::int`,
    })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(eq(replicas.vaultId, vault.id))
    .groupBy(replicas.objectHash);

  let healthyObjects = 0;
  let degradedObjects = 0;
  let atRiskObjects = 0;

  for (const row of rows) {
    switch (protectionState({ desiredReplicas, healthyReplicas: Number(row.healthy) })) {
      case "healthy":
        healthyObjects += 1;
        break;
      case "degraded":
        degradedObjects += 1;
        break;
      case "at_risk":
        atRiskObjects += 1;
        break;
      default:
        atRiskObjects += 1;
    }
  }

  let state: VaultProtectionSummary["state"] = "empty";
  if (rows.length > 0) {
    if (atRiskObjects > 0) state = "at_risk";
    else if (degradedObjects > 0) state = "degraded";
    else state = "healthy";
  }

  return {
    mode: policy.mode,
    desiredReplicas,
    singleCopy: isSingleCopyPolicy(desiredReplicas),
    totalObjects: rows.length,
    healthyObjects,
    degradedObjects,
    atRiskObjects,
    state,
  };
}

/** Objects whose protection has fallen below target — the repair queue (§44). */
export async function listUnderProtectedObjects(
  ownerId: string,
  limit = 100
): Promise<ObjectProtection[]> {
  const vault = await ensureVaultForOwner(ownerId);
  await classifyDeviceOutages(vault.id);
  const policy = await getPolicy(ownerId);
  const desiredReplicas = replicasForMode(policy.mode);
  const onlineSince = new Date(Date.now() - config().deviceOfflineAfterSeconds * 1000);

  const rows = await db()
    .select({
      objectHash: replicas.objectHash,
      healthy: sql<number>`count(*) filter (
        where ${replicas.status} = 'healthy'
          and ${devices.status} not in ('draining', 'removed', 'suspected_lost')
      )::int`,
      placing: sql<number>`count(*) filter (
        where ${replicas.status} = 'placing'
          and ${devices.status} not in ('draining', 'removed', 'suspected_lost')
      )::int`,
      reachableHealthy: sql<number>`count(*) filter (
        where ${replicas.status} = 'healthy'
          and ${devices.status} = 'online'
          and ${devices.lastSeenAt} >= ${onlineSince}
          and ${devices.advertisedUrl} is not null
      )::int`,
    })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(eq(replicas.vaultId, vault.id))
    .groupBy(replicas.objectHash)
    .having(sql`count(*) filter (
          where ${replicas.status} = 'healthy'
            and ${devices.status} not in ('draining', 'removed', 'suspected_lost')
    ) < ${desiredReplicas}`)
    .limit(limit);

  return rows.map((row) => ({
    objectHash: row.objectHash,
    desiredReplicas,
    healthyReplicas: Number(row.healthy),
    placingReplicas: Number(row.placing),
    reachableHealthyReplicas: Number(row.reachableHealthy),
    state: protectionState({
      desiredReplicas,
      healthyReplicas: Number(row.healthy),
    }),
    availability: availabilityState({
      desiredReplicas,
      healthyReplicas: Number(row.healthy),
      reachableHealthyReplicas: Number(row.reachableHealthy),
      placingReplicas: Number(row.placing),
    }),
    deviceIds: [],
  }));
}
