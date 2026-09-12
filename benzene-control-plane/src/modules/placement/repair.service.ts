import { randomUUID } from "node:crypto";

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import {
  deviceStorageAllocations,
  devices,
  replicas,
  storagePolicies,
} from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";
import {
  classifyDeviceOutages,
  deriveStatus,
} from "../devices/devices.service.js";
import { occupiedBytesSql } from "./capacity.js";
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
  repairAssignmentId: string;
  source: RepairSource;
}

/**
 * Marks the exact source bound to an active repair as corrupt after a hash
 * failure. Clearing the binding consumes the one-shot report; a replay or a
 * report naming another source cannot mutate replica state.
 */
export async function reportRepairSourceFailure(
  targetDeviceId: string,
  input: { objectHash: string; sourceDeviceId: string; repairAssignmentId: string }
): Promise<{ status: "corrupt" }> {
  const [knownTarget] = await db()
    .select({ vaultId: devices.vaultId })
    .from(devices)
    .where(eq(devices.id, targetDeviceId))
    .limit(1);
  if (!knownTarget) throw AppError.notFound("Target device not found");
  await classifyDeviceOutages(knownTarget.vaultId);

  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ vaultId: devices.vaultId })
      .from(devices)
      .where(eq(devices.id, targetDeviceId))
      .limit(1);
    if (!target) throw AppError.notFound("Target device not found");

    const [targetReplica] = await tx
      .select({
        id: replicas.id,
        repairSourceDeviceId: replicas.repairSourceDeviceId,
        repairAssignmentId: replicas.repairAssignmentId,
        updatedAt: replicas.updatedAt,
      })
      .from(replicas)
      .where(
        and(
          eq(replicas.vaultId, target.vaultId),
          eq(replicas.objectHash, input.objectHash),
          eq(replicas.deviceId, targetDeviceId),
          eq(replicas.status, "placing")
        )
      )
      .limit(1)
      .for("update");
    if (!targetReplica) {
      throw AppError.conflict("No active repair reservation for this object");
    }
    if (
      targetReplica.repairSourceDeviceId !== input.sourceDeviceId ||
      targetReplica.repairAssignmentId !== input.repairAssignmentId
    ) {
      throw AppError.conflict("Repair source does not match the active assignment");
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const issuedAtSeconds = Math.floor(targetReplica.updatedAt.getTime() / 1000);
    if (nowSeconds - issuedAtSeconds > config().transferGrantTtlSeconds) {
      throw AppError.conflict("Repair assignment has expired");
    }

    const [sourceReplica] = await tx
      .select({ id: replicas.id, status: replicas.status })
      .from(replicas)
      .innerJoin(devices, eq(devices.id, replicas.deviceId))
      .where(
        and(
          eq(replicas.vaultId, target.vaultId),
          eq(replicas.objectHash, input.objectHash),
          eq(replicas.deviceId, input.sourceDeviceId),
          eq(replicas.status, "healthy"),
          eq(devices.vaultId, target.vaultId)
        )
      )
      .limit(1);
    if (!sourceReplica) throw AppError.notFound("Repair source is not a healthy replica");

    const [quarantined] = await tx
      .update(replicas)
      .set({ status: "corrupt", updatedAt: new Date() })
      .where(and(eq(replicas.id, sourceReplica.id), eq(replicas.status, "healthy")))
      .returning({ id: replicas.id });
    if (!quarantined) {
      throw AppError.conflict("Repair source is no longer healthy");
    }
    await tx
      .update(replicas)
      .set({
        status: "missing",
        repairSourceDeviceId: null,
        repairAssignmentId: null,
        updatedAt: new Date(),
      })
      .where(eq(replicas.id, targetReplica.id));
    return { status: "corrupt" };
  });
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
  const [target] = await db()
    .select({ vaultId: devices.vaultId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!target) return null;
  await classifyDeviceOutages(target.vaultId);

  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;

  // A target that vanished after polling must not reserve a slot forever.
  // The transfer grant is the retry window, so this conservative expiry is
  // also safe for an interrupted whole-file transfer.
  const pollNowSeconds = Math.floor(Date.now() / 1000);
  await db()
    .delete(replicas)
    .where(
      and(
        eq(replicas.vaultId, target.vaultId),
        eq(replicas.status, "placing"),
        lt(
          replicas.updatedAt,
          new Date(
            (pollNowSeconds - config().transferGrantTtlSeconds) * 1000
          )
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
      // Device lifecycle must be checked under the same lock as the
      // reservation. A drain that wins this lock cannot race a new repair
      // reservation onto the device being retired.
      const [lockedTarget] = await tx
        .select({
          vaultId: devices.vaultId,
          status: devices.status,
          lastSeenAt: devices.lastSeenAt,
        })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .for("update")
        .limit(1);
      if (
        !lockedTarget ||
        lockedTarget.vaultId !== target.vaultId ||
        lockedTarget.status === "removed" ||
        lockedTarget.status === "draining" ||
        deriveStatus(lockedTarget.status, lockedTarget.lastSeenAt, offlineAfterMs) !== "online"
      ) return null;

      // Keep lock ordering identical to reservePlacement and drain preflight:
      // device row first, then its allocation row.
      const allocation = alias(deviceStorageAllocations, "repair_allocation");
      const [currentCapacity] = await tx
        .select({
          allocatedBytes: allocation.allocatedBytes,
          occupiedBytes: occupiedBytesSql("repair_allocation"),
        })
        .from(allocation)
        .where(eq(allocation.deviceId, deviceId))
        .for("update")
        .limit(1);
      if (!currentCapacity) return null;

      // Advisory locking serialises active-count check plus reservation for
      // this object, so two target agents cannot both create excess copies.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${target.vaultId}:${object.objectHash}`}))`
      );

      const replicaRows = await tx
        .select({
          status: replicas.status,
          deviceStatus: devices.status,
        })
        .from(replicas)
        .innerJoin(devices, eq(devices.id, replicas.deviceId))
        .where(
          and(eq(replicas.vaultId, target.vaultId), eq(replicas.objectHash, object.objectHash))
        );
      const availableReplicas = replicaRows.filter(
        (row) =>
          row.deviceStatus !== "draining" &&
          row.deviceStatus !== "removed" &&
          row.deviceStatus !== "suspected_lost"
      );
      const healthyCount = availableReplicas.filter((row) => row.status === "healthy").length;
      const activeCount = availableReplicas.filter(
        (row) => row.status === "healthy" || row.status === "placing"
      ).length;
      if (healthyCount >= desiredReplicas) return null;

      const [targetReplica] = await tx
        .select({
          id: replicas.id,
          status: replicas.status,
          sizeBytes: replicas.sizeBytes,
          repairSourceDeviceId: replicas.repairSourceDeviceId,
          repairAssignmentId: replicas.repairAssignmentId,
        })
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
      // A failed/corrupt row is not an active reservation. It may only be
      // reopened when the object still needs protection; only an existing
      // placing row is retryable when active work already satisfies policy.
      if (activeCount >= desiredReplicas && targetReplica?.status !== "placing") return null;

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

      const boundSourceId = targetReplica?.status === "placing"
        ? targetReplica.repairSourceDeviceId
        : null;
      const source = sourceRows.find(
        (row) =>
          (!boundSourceId || row.deviceId === boundSourceId) &&
          Boolean(row.advertisedUrl) &&
          (row.deviceStatus === "draining"
            ? Boolean(
                row.lastSeenAt &&
                  Date.now() - row.lastSeenAt.getTime() <= offlineAfterMs
              )
            : deriveStatus(row.deviceStatus, row.lastSeenAt, offlineAfterMs) === "online")
      );
      if (!source || !source.advertisedUrl) return null;

      const sizeBytes = Number(targetReplica?.sizeBytes ?? source.sizeBytes);
      const repairAssignmentId = targetReplica?.status === "placing"
        ? targetReplica.repairAssignmentId ?? randomUUID()
        : randomUUID();
      const replacementCredit =
        targetReplica?.status === "corrupt" &&
        Number(targetReplica.sizeBytes) === sizeBytes
          ? sizeBytes
          : 0;
      const capacityInsufficient =
        targetReplica?.status !== "placing" &&
        sizeBytes >
          Math.max(
            0,
            Number(currentCapacity?.allocatedBytes ?? 0) -
              Number(currentCapacity?.occupiedBytes ?? 0) +
              replacementCredit
          );
      if (
        !currentCapacity ||
        !Number.isFinite(sizeBytes) ||
        sizeBytes < 0 ||
        capacityInsufficient
      ) return null;

      // Grants and failure reports use Unix-second expiry. Persist the same
      // second as the reservation timestamp so millisecond skew cannot leave
      // a report valid after the grant's boundary.
      const issuedAtSeconds = Math.floor(Date.now() / 1000);
      const issuedAt = new Date(issuedAtSeconds * 1000);

      if (targetReplica?.status === "placing") {
        // Reusing an existing reservation is what makes a lost poll response
        // retryable without adding another row for the same device. Refresh
        // the durable timestamp so the newly issued grant and report window
        // expire together while preserving the same nonce.
        await tx
          .update(replicas)
          .set({
            repairSourceDeviceId: source.deviceId,
            repairAssignmentId,
            updatedAt: issuedAt,
          })
          .where(eq(replicas.id, targetReplica.id));
      } else if (targetReplica) {
        // A failed/corrupt prior copy is not possession, but its unique row is
        // still useful durable work. Reopen it as placing instead of letting
        // the conflict-ignore below issue an unusable assignment.
        await tx
          .update(replicas)
          .set({
            status: "placing",
            sizeBytes,
            repairSourceDeviceId: source.deviceId,
            repairAssignmentId,
            updatedAt: issuedAt,
          })
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
            repairSourceDeviceId: source.deviceId,
            repairAssignmentId,
            updatedAt: issuedAt,
          })
          .onConflictDoNothing({
            target: [replicas.vaultId, replicas.objectHash, replicas.deviceId],
          });
      }

      const expiresAt = issuedAtSeconds + config().transferGrantTtlSeconds;
      return {
        objectHash: object.objectHash,
        sizeBytes,
        repairAssignmentId,
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
