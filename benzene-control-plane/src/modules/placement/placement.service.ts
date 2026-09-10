import { and, eq, inArray, lt, sql } from "drizzle-orm";

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
import { deriveStatus } from "../devices/devices.service.js";
import { ensureVaultForOwner } from "../vaults/vaults.service.js";
import {
  isSingleCopyPolicy,
  planPlacement,
  protectionState,
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

  const rows = await db()
    .select({
      deviceId: devices.id,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt,
      advertisedUrl: devices.advertisedUrl,
      allocatedBytes: deviceStorageAllocations.allocatedBytes,
      usedBytes: deviceStorageAllocations.usedBytes,
      replicaCount: sql<number>`(
        select count(*)::int from ${replicas}
        where ${replicas.deviceId} = ${devices.id}
          and ${replicas.status} = 'healthy'
      )`,
    })
    .from(devices)
    .leftJoin(
      deviceStorageAllocations,
      eq(deviceStorageAllocations.deviceId, devices.id)
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
    .where(
      and(
        eq(replicas.vaultId, vault.id),
        eq(replicas.objectHash, input.objectHash),
        // A reservation is not possession. Only a device-confirmed copy may
        // satisfy the policy or be reported as already held.
        eq(replicas.status, "healthy")
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
  options: { requireReachable?: boolean } = {}
): Promise<Replica[]> {
  const vault = await ensureVaultForOwner(ownerId);
  if (input.deviceIds.length === 0) return [];

  const owned = await db()
    .select({ id: devices.id, advertisedUrl: devices.advertisedUrl })
    .from(devices)
    .where(and(eq(devices.vaultId, vault.id), inArray(devices.id, input.deviceIds)));

  if (owned.length !== input.deviceIds.length) {
    throw AppError.badRequest("One or more devices are not part of this vault");
  }
  if (options.requireReachable && owned.some((device) => !device.advertisedUrl)) {
    throw AppError.badRequest("One or more devices cannot receive transfers");
  }

  return db()
    .insert(replicas)
    .values(
      input.deviceIds.map((deviceId) => ({
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
  const [placing] = await db()
    .select()
    .from(replicas)
    .where(
      and(
        eq(replicas.objectHash, input.objectHash),
        eq(replicas.deviceId, deviceId),
        eq(replicas.status, "placing")
      )
    )
    .limit(1);

  if (placing && Number(placing.sizeBytes) !== input.sizeBytes) {
    throw AppError.badRequest("Possession size does not match the reservation");
  }

  if (placing) {
    const [updated] = await db()
      .update(replicas)
      .set({
        status: "healthy",
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(replicas.id, placing.id))
      .returning();
    if (updated) return updated;
  }

  // Retries are expected: the device may have committed the bytes but lost
  // the response to its first possession report. Keep the operation idempotent
  // while still refusing a device that never had a reservation.
  const [healthy] = await db()
    .select()
    .from(replicas)
    .where(
      and(
        eq(replicas.objectHash, input.objectHash),
        eq(replicas.deviceId, deviceId),
        eq(replicas.status, "healthy")
      )
    )
    .limit(1);
  if (healthy) {
    if (Number(healthy.sizeBytes) !== input.sizeBytes) {
      throw AppError.badRequest("Possession size does not match the reservation");
    }
    return healthy;
  }

  throw AppError.notFound("No placement reserved for that device");
}

export interface ObjectProtection {
  objectHash: string;
  desiredReplicas: number;
  healthyReplicas: number;
  placingReplicas: number;
  state: ProtectionState;
  deviceIds: string[];
}

/** Protection health for one object, as product §23 presents it. */
export async function getObjectProtection(
  ownerId: string,
  objectHash: string
): Promise<ObjectProtection> {
  const vault = await ensureVaultForOwner(ownerId);
  const policy = await getPolicy(ownerId);
  const desiredReplicas = replicasForMode(policy.mode);
  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;

  const rows = await db()
    .select({
      deviceId: replicas.deviceId,
      status: replicas.status,
      deviceStatus: devices.status,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(
      and(eq(replicas.vaultId, vault.id), eq(replicas.objectHash, objectHash))
    );

  // A replica on an offline device still counts as healthy: architecture §41
  // is explicit that offline is not the same as lost, and treating it as lost
  // would trigger pointless repairs every time a laptop closes.
  const healthy = rows.filter((row) => row.status === "healthy");
  const placing = rows.filter((row) => row.status === "placing");

  return {
    objectHash,
    desiredReplicas,
    healthyReplicas: healthy.length,
    placingReplicas: placing.length,
    state: protectionState({ desiredReplicas, healthyReplicas: healthy.length }),
    deviceIds: rows
      .filter((row) => deriveStatus(row.deviceStatus, row.lastSeenAt, offlineAfterMs) !== "removed")
      .map((row) => row.deviceId),
  };
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
  const policy = await getPolicy(ownerId);
  const desiredReplicas = replicasForMode(policy.mode);

  const rows = await db()
    .select({
      objectHash: replicas.objectHash,
      healthy: sql<number>`count(*) filter (where ${replicas.status} = 'healthy')::int`,
    })
    .from(replicas)
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
  const policy = await getPolicy(ownerId);
  const desiredReplicas = replicasForMode(policy.mode);

  const rows = await db()
    .select({
      objectHash: replicas.objectHash,
      healthy: sql<number>`count(*) filter (where ${replicas.status} = 'healthy')::int`,
      placing: sql<number>`count(*) filter (where ${replicas.status} = 'placing')::int`,
    })
    .from(replicas)
    .where(eq(replicas.vaultId, vault.id))
    .groupBy(replicas.objectHash)
    .having(sql`count(*) filter (where ${replicas.status} = 'healthy') < ${desiredReplicas}`)
    .limit(limit);

  return rows.map((row) => ({
    objectHash: row.objectHash,
    desiredReplicas,
    healthyReplicas: Number(row.healthy),
    placingReplicas: Number(row.placing),
    state: protectionState({
      desiredReplicas,
      healthyReplicas: Number(row.healthy),
    }),
    deviceIds: [],
  }));
}
