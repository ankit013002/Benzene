import { and, asc, eq, lt, sql } from "drizzle-orm";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import {
  deviceStorageAllocations,
  devices,
  replicas,
  storagePolicies,
} from "../../db/schema.js";
import { deriveStatus, findDeviceById } from "../devices/devices.service.js";
import { replicasForMode } from "./placement.service.js";
import { issueTransferGrant } from "./transferGrant.js";

export interface RepairSource {
  deviceId: string;
  deviceName: string;
  url: string;
  grant: string;
  expiresAt: string;
}

export interface RepairAssignment {
  objectHash: string;
  sizeBytes: number;
  source: RepairSource;
}

function signingKey(): string {
  const key = config().transferSigningKey;
  if (!key) throw new Error("TRANSFER_SIGNING_KEY is not configured");
  return key;
}

/**
 * Finds one repair that this online target can perform.
 *
 * This is deliberately whole-file and LAN-only. Replica rows are the durable
 * work record: a `placing` row on the target makes a lost response retryable,
 * while the signed possession report is the only transition to `healthy`.
 */
export async function pollRepairForDevice(
  deviceId: string
): Promise<RepairAssignment | null> {
  const target = await findDeviceById(deviceId);
  if (!target || target.status === "removed" || target.status === "draining") return null;

  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;
  if (deriveStatus(target.status, target.lastSeenAt, offlineAfterMs) !== "online") {
    return null;
  }

  const allocation = await db()
    .select()
    .from(deviceStorageAllocations)
    .where(eq(deviceStorageAllocations.deviceId, deviceId))
    .limit(1);
  const capacity = allocation[0];
  if (!capacity) return null;

  // A target that vanished after polling must not reserve a slot forever.
  // The transfer grant is the retry window, so this conservative expiry is
  // also safe for an interrupted whole-file transfer.
  await db()
    .delete(replicas)
    .where(
      and(
        eq(replicas.vaultId, target.vaultId),
        eq(replicas.status, "placing"),
        lt(
          replicas.updatedAt,
          new Date(Date.now() - config().transferGrantTtlSeconds * 1000)
        )
      )
    );

  const [policy] = await db()
    .select({ mode: storagePolicies.mode })
    .from(storagePolicies)
    .where(eq(storagePolicies.vaultId, target.vaultId))
    .limit(1);
  const desiredReplicas = replicasForMode(policy?.mode ?? "protected");

  const objects = await db()
    .select({
      objectHash: replicas.objectHash,
    })
    .from(replicas)
    .where(eq(replicas.vaultId, target.vaultId))
    .groupBy(replicas.objectHash)
    .orderBy(asc(replicas.objectHash));

  for (const object of objects) {
    const assignment = await db().transaction(async (tx) => {
      // Advisory locking serialises active-count check plus reservation for
      // this object, so two target agents cannot both create excess copies.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${target.vaultId}:${object.objectHash}`}))`
      );

      const [counts] = await tx
        .select({
          healthy: sql<number>`count(*) filter (where ${replicas.status} = 'healthy')::int`,
          active: sql<number>`count(*) filter (where ${replicas.status} in ('healthy', 'placing'))::int`,
        })
        .from(replicas)
        .where(
          and(eq(replicas.vaultId, target.vaultId), eq(replicas.objectHash, object.objectHash))
        );
      if (!counts || Number(counts.healthy) >= desiredReplicas) return null;

      const [targetReplica] = await tx
        .select({ id: replicas.id, status: replicas.status, sizeBytes: replicas.sizeBytes })
        .from(replicas)
        .where(
          and(
            eq(replicas.vaultId, target.vaultId),
            eq(replicas.objectHash, object.objectHash),
            eq(replicas.deviceId, deviceId)
          )
        )
        .limit(1);
      if (targetReplica?.status === "healthy") return null;
      if (Number(counts.active) >= desiredReplicas && !targetReplica) return null;

      const sourceRows = await tx
        .select({
          deviceId: replicas.deviceId,
          sizeBytes: replicas.sizeBytes,
          deviceName: devices.name,
          advertisedUrl: devices.advertisedUrl,
          deviceStatus: devices.status,
          lastSeenAt: devices.lastSeenAt,
        })
        .from(replicas)
        .innerJoin(devices, eq(devices.id, replicas.deviceId))
        .where(
          and(
            eq(replicas.vaultId, target.vaultId),
            eq(replicas.objectHash, object.objectHash),
            eq(replicas.status, "healthy"),
            sql`${replicas.deviceId} <> ${deviceId}`
          )
        )
        .orderBy(asc(replicas.createdAt));

      const source = sourceRows.find(
        (row) =>
          Boolean(row.advertisedUrl) &&
          deriveStatus(row.deviceStatus, row.lastSeenAt, offlineAfterMs) === "online"
      );
      if (!source || !source.advertisedUrl) return null;

      const sizeBytes = Number(targetReplica?.sizeBytes ?? source.sizeBytes);
      const [currentCapacity] = await tx
        .select({ allocatedBytes: deviceStorageAllocations.allocatedBytes, usedBytes: deviceStorageAllocations.usedBytes })
        .from(deviceStorageAllocations)
        .where(eq(deviceStorageAllocations.deviceId, deviceId))
        .limit(1);
      if (
        !currentCapacity ||
        !Number.isFinite(sizeBytes) ||
        sizeBytes < 0 ||
        sizeBytes > Math.max(0, Number(currentCapacity.allocatedBytes) - Number(currentCapacity.usedBytes))
      ) return null;

      if (targetReplica?.status === "placing") {
        // Reusing an existing reservation is what makes a lost poll response
        // retryable without adding another row for the same device.
      } else if (targetReplica) {
        // A failed/corrupt prior copy is not possession, but its unique row is
        // still useful durable work. Reopen it as placing instead of letting
        // the conflict-ignore below issue an unusable assignment.
        await tx
          .update(replicas)
          .set({ status: "placing", sizeBytes, updatedAt: new Date() })
          .where(eq(replicas.id, targetReplica.id));
      } else {
        await tx
          .insert(replicas)
          .values({
            vaultId: target.vaultId,
            objectHash: object.objectHash,
            deviceId,
            sizeBytes,
            status: "placing",
          })
          .onConflictDoNothing({
            target: [replicas.vaultId, replicas.objectHash, replicas.deviceId],
          });
      }

      const expiresAt = Math.floor(Date.now() / 1000) + config().transferGrantTtlSeconds;
      return {
        objectHash: object.objectHash,
        sizeBytes,
        source: {
          deviceId: source.deviceId,
          deviceName: source.deviceName,
          url: `${source.advertisedUrl.replace(/\/+$/, "")}/objects/${object.objectHash}`,
          grant: issueTransferGrant(signingKey(), {
            objectHash: object.objectHash,
            deviceId: source.deviceId,
            op: "get",
            exp: expiresAt,
          }),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
      };
    });
    if (assignment) return assignment;
  }

  return null;
}
