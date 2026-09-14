import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import {
  REPLICAS_FOR_MODE,
  deviceStorageAllocations,
  devices,
  objectReferences,
  replicas,
  storagePolicies,
  vaults,
  type ProtectionMode,
} from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";
import { classifyDeviceOutages, deriveStatus } from "../devices/devices.service.js";
import { occupiedBytesSql } from "./capacity.js";
import { planRebalance, type RebalanceObject } from "./rebalancing.js";
import { issueTransferGrant } from "./transferGrant.js";

export interface RebalanceCopyAssignment {
  action: "copy";
  objectHash: string;
  sizeBytes: number;
  assignmentId: string;
  source: {
    deviceId: string;
    deviceName: string;
    url: string;
    grant: string;
    expiresAt: string;
  };
}

export interface RebalanceDeleteAssignment {
  action: "delete";
  objectHash: string;
  assignmentId: string;
}

export type RebalanceAssignment =
  | RebalanceCopyAssignment
  | RebalanceDeleteAssignment;

function signingKey(): string {
  const key = config().transferSigningKey;
  if (!key) throw new Error("TRANSFER_SIGNING_KEY is not configured");
  return key;
}

function desiredReplicas(mode: string | undefined): number {
  return REPLICAS_FOR_MODE[mode as ProtectionMode] ?? REPLICAS_FOR_MODE.protected;
}

function online(status: string, lastSeenAt: Date | null): boolean {
  return (
    deriveStatus(
      status,
      lastSeenAt,
      config().deviceOfflineAfterSeconds * 1000
    ) === "online"
  );
}

async function retryCopyAssignment(
  deviceId: string,
  vaultId: string
): Promise<RebalanceCopyAssignment | null> {
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ status: devices.status, lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.vaultId, vaultId)))
      .for("update")
      .limit(1);
    if (!target || !online(target.status, target.lastSeenAt)) return null;

    const [work] = await tx
      .select({
        id: replicas.id,
        objectHash: replicas.objectHash,
        sizeBytes: replicas.sizeBytes,
        assignmentId: replicas.rebalanceAssignmentId,
        sourceDeviceId: replicas.rebalancePeerDeviceId,
      })
      .from(replicas)
      .where(
        and(
          eq(replicas.deviceId, deviceId),
          eq(replicas.status, "placing"),
          isNotNull(replicas.rebalanceAssignmentId)
        )
      )
      .orderBy(asc(replicas.updatedAt))
      .for("update")
      .limit(1);
    if (!work?.assignmentId || !work.sourceDeviceId) return null;

    const [source] = await tx
      .select({
        name: devices.name,
        advertisedUrl: devices.advertisedUrl,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
      })
      .from(devices)
      .innerJoin(
        replicas,
        and(
          eq(replicas.deviceId, devices.id),
          eq(replicas.vaultId, vaultId),
          eq(replicas.objectHash, work.objectHash),
          eq(replicas.status, "healthy")
        )
      )
      .where(eq(devices.id, work.sourceDeviceId))
      .limit(1);

    const sourceReachable =
      source?.advertisedUrl &&
      (source.status === "draining"
        ? Boolean(
            source.lastSeenAt &&
              Date.now() - source.lastSeenAt.getTime() <=
                config().deviceOfflineAfterSeconds * 1000
          )
        : online(source.status, source.lastSeenAt));
    if (!source || !source.advertisedUrl || !sourceReachable) {
      await tx
        .update(replicas)
        .set({
          status: "missing",
          repairSourceDeviceId: null,
          repairAssignmentId: null,
          rebalanceAssignmentId: null,
          rebalancePeerDeviceId: null,
          updatedAt: new Date(),
        })
        .where(eq(replicas.id, work.id));
      return null;
    }

    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const issuedAt = new Date(issuedAtSeconds * 1000);
    await tx.update(replicas).set({ updatedAt: issuedAt }).where(eq(replicas.id, work.id));
    const expiresAt = issuedAtSeconds + config().transferGrantTtlSeconds;
    return {
      action: "copy",
      objectHash: work.objectHash,
      sizeBytes: Number(work.sizeBytes),
      assignmentId: work.assignmentId,
      source: {
        deviceId: work.sourceDeviceId,
        deviceName: source.name,
        url: `${source.advertisedUrl.replace(/\/+$/, "")}/objects/${work.objectHash}`,
        grant: issueTransferGrant(signingKey(), {
          objectHash: work.objectHash,
          deviceId: work.sourceDeviceId,
          op: "get",
          exp: expiresAt,
        }),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      },
    };
  });
}

/**
 * Returns one copy or delete step. Only one move may be active per vault, and
 * the vault timestamp admits at most one new move per configured interval.
 */
export async function pollRebalancingForDevice(
  deviceId: string
): Promise<RebalanceAssignment | null> {
  const [known] = await db()
    .select({ vaultId: devices.vaultId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!known) throw AppError.notFound("Device not found");
  await classifyDeviceOutages(known.vaultId);

  const [deletion] = await db()
    .select({
      objectHash: replicas.objectHash,
      assignmentId: replicas.rebalanceAssignmentId,
    })
    .from(replicas)
    .where(
      and(
        eq(replicas.deviceId, deviceId),
        eq(replicas.status, "deleting"),
        isNotNull(replicas.rebalanceAssignmentId)
      )
    )
    .orderBy(asc(replicas.updatedAt))
    .limit(1);
  if (deletion?.assignmentId) {
    return {
      action: "delete",
      objectHash: deletion.objectHash,
      assignmentId: deletion.assignmentId,
    };
  }

  await db()
    .delete(replicas)
    .where(
      and(
        eq(replicas.vaultId, known.vaultId),
        eq(replicas.status, "placing"),
        isNotNull(replicas.rebalanceAssignmentId),
        lt(
          replicas.updatedAt,
          new Date(Date.now() - config().transferGrantTtlSeconds * 1000)
        )
      )
    );

  const retried = await retryCopyAssignment(deviceId, known.vaultId);
  if (retried) return retried;

  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${known.vaultId}:rebalance`}))`
    );

    const [vault] = await tx
      .select({ lastRebalancedAt: vaults.lastRebalancedAt })
      .from(vaults)
      .where(eq(vaults.id, known.vaultId))
      .for("update")
      .limit(1);
    if (!vault) return null;
    if (
      vault.lastRebalancedAt &&
      Date.now() - vault.lastRebalancedAt.getTime() <
        config().rebalanceIntervalSeconds * 1000
    ) {
      return null;
    }

    const [active] = await tx
      .select({ id: replicas.id })
      .from(replicas)
      .where(
        and(
          eq(replicas.vaultId, known.vaultId),
          isNotNull(replicas.rebalanceAssignmentId)
        )
      )
      .limit(1);
    if (active) return null;

    const referenced = await tx
      .selectDistinct({ objectHash: objectReferences.objectHash })
      .from(objectReferences)
      .where(eq(objectReferences.vaultId, known.vaultId));
    if (referenced.length === 0) return null;
    const hashes = referenced.map((reference) => reference.objectHash);

    const replicaRows = await tx
      .select({
        objectHash: replicas.objectHash,
        deviceId: replicas.deviceId,
        sizeBytes: replicas.sizeBytes,
        status: replicas.status,
        deviceStatus: devices.status,
        garbageCollectionAssignmentId: replicas.garbageCollectionAssignmentId,
      })
      .from(replicas)
      .innerJoin(devices, eq(devices.id, replicas.deviceId))
      .where(
        and(
          eq(replicas.vaultId, known.vaultId),
          inArray(replicas.objectHash, hashes)
        )
      );
    if (
      replicaRows.some(
        (row) =>
          row.status === "placing" ||
          row.status === "deleting" ||
          row.garbageCollectionAssignmentId !== null
      )
    ) {
      return null;
    }

    const [policy] = await tx
      .select({ mode: storagePolicies.mode })
      .from(storagePolicies)
      .where(eq(storagePolicies.vaultId, known.vaultId))
      .limit(1);
    const required = desiredReplicas(policy?.mode);
    const objects: RebalanceObject[] = hashes.map((objectHash) => {
      const rows = replicaRows.filter((row) => row.objectHash === objectHash);
      return {
        objectHash,
        sizeBytes: Number(rows.find((row) => row.status === "healthy")?.sizeBytes ?? 0),
        healthyDeviceIds: rows
          .filter(
            (row) =>
              row.status === "healthy" &&
              row.deviceStatus !== "draining" &&
              row.deviceStatus !== "removed" &&
              row.deviceStatus !== "suspected_lost"
          )
          .map((row) => row.deviceId),
      };
    });
    if (objects.some((object) => object.healthyDeviceIds.length < required)) {
      return null;
    }

    const allocation = alias(deviceStorageAllocations, "rebalance_allocation");
    const deviceRows = await tx
      .select({
        deviceId: devices.id,
        deviceName: devices.name,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        advertisedUrl: devices.advertisedUrl,
        allocatedBytes: allocation.allocatedBytes,
        occupiedBytes: occupiedBytesSql("rebalance_allocation"),
      })
      .from(devices)
      .leftJoin(allocation, eq(allocation.deviceId, devices.id))
      .where(eq(devices.vaultId, known.vaultId));

    const plan = planRebalance(
      deviceRows.map((device) => ({
        deviceId: device.deviceId,
        allocatedBytes: Number(device.allocatedBytes ?? 0),
        occupiedBytes: Number(device.occupiedBytes ?? 0),
        online: online(device.status, device.lastSeenAt),
        reachable: Boolean(device.advertisedUrl),
        draining: device.status === "draining",
      })),
      objects,
      config().rebalanceMinUsageDeltaPercent / 100
    );
    if (!plan || plan.targetDeviceId !== deviceId) return null;
    const sourceDevice = deviceRows.find(
      (device) => device.deviceId === plan.sourceDeviceId
    );
    if (!sourceDevice?.advertisedUrl) return null;

    const [target] = await tx
      .select({ status: devices.status, lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.vaultId, known.vaultId)))
      .for("update")
      .limit(1);
    if (!target || !online(target.status, target.lastSeenAt)) return null;

    const targetAllocation = alias(deviceStorageAllocations, "rebalance_target_allocation");
    const [capacity] = await tx
      .select({
        allocatedBytes: targetAllocation.allocatedBytes,
        occupiedBytes: occupiedBytesSql("rebalance_target_allocation"),
      })
      .from(targetAllocation)
      .where(eq(targetAllocation.deviceId, deviceId))
      .for("update")
      .limit(1);
    if (
      !capacity ||
      Number(capacity.allocatedBytes) - Number(capacity.occupiedBytes) < plan.sizeBytes
    ) {
      return null;
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${known.vaultId}:${plan.objectHash}`}))`
    );
    const lockedRows = await tx
      .select({
        id: replicas.id,
        deviceId: replicas.deviceId,
        status: replicas.status,
        garbageCollectionAssignmentId: replicas.garbageCollectionAssignmentId,
        rebalanceAssignmentId: replicas.rebalanceAssignmentId,
      })
      .from(replicas)
      .where(
        and(
          eq(replicas.vaultId, known.vaultId),
          eq(replicas.objectHash, plan.objectHash)
        )
      )
      .for("update");
    const source = lockedRows.find(
      (row) => row.deviceId === plan.sourceDeviceId && row.status === "healthy"
    );
    const targetRow = lockedRows.find((row) => row.deviceId === deviceId);
    if (
      !source ||
      targetRow?.status === "healthy" ||
      lockedRows.some(
        (row) =>
          row.status === "placing" ||
          row.status === "deleting" ||
          row.garbageCollectionAssignmentId !== null ||
          row.rebalanceAssignmentId !== null
      )
    ) {
      return null;
    }

    const [stillReferenced] = await tx
      .select({ versionId: objectReferences.versionId })
      .from(objectReferences)
      .where(
        and(
          eq(objectReferences.vaultId, known.vaultId),
          eq(objectReferences.objectHash, plan.objectHash)
        )
      )
      .limit(1);
    if (!stillReferenced) return null;

    const assignmentId = randomUUID();
    const issuedAtSeconds = Math.floor(Date.now() / 1000);
    const issuedAt = new Date(issuedAtSeconds * 1000);
    if (targetRow) {
      await tx
        .update(replicas)
        .set({
          status: "placing",
          sizeBytes: plan.sizeBytes,
          verifiedAt: null,
          repairSourceDeviceId: plan.sourceDeviceId,
          repairAssignmentId: assignmentId,
          rebalanceAssignmentId: assignmentId,
          rebalancePeerDeviceId: plan.sourceDeviceId,
          updatedAt: issuedAt,
        })
        .where(eq(replicas.id, targetRow.id));
    } else {
      await tx.insert(replicas).values({
        vaultId: known.vaultId,
        objectHash: plan.objectHash,
        deviceId,
        sizeBytes: plan.sizeBytes,
        status: "placing",
        repairSourceDeviceId: plan.sourceDeviceId,
        repairAssignmentId: assignmentId,
        rebalanceAssignmentId: assignmentId,
        rebalancePeerDeviceId: plan.sourceDeviceId,
        updatedAt: issuedAt,
      });
    }
    await tx
      .update(vaults)
      .set({ lastRebalancedAt: issuedAt, updatedAt: issuedAt })
      .where(eq(vaults.id, known.vaultId));

    const expiresAt = issuedAtSeconds + config().transferGrantTtlSeconds;
    return {
      action: "copy",
      objectHash: plan.objectHash,
      sizeBytes: plan.sizeBytes,
      assignmentId,
      source: {
        deviceId: plan.sourceDeviceId,
        deviceName: sourceDevice.deviceName,
        url: `${sourceDevice.advertisedUrl.replace(/\/+$/, "")}/objects/${plan.objectHash}`,
        grant: issueTransferGrant(signingKey(), {
          objectHash: plan.objectHash,
          deviceId: plan.sourceDeviceId,
          op: "get",
          exp: expiresAt,
        }),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      },
    };
  });
}

/** Retires metadata only after the old source idempotently deleted its bytes. */
export async function completeRebalancingDeletion(
  deviceId: string,
  input: { objectHash: string; assignmentId: string }
): Promise<{ status: "deleted" }> {
  const removed = await db().transaction(async (tx) => {
    const [device] = await tx
      .select({ vaultId: devices.vaultId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) return false;
    const objectHash = input.objectHash.toLowerCase();
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${device.vaultId}:${objectHash}`}))`
    );
    const [replica] = await tx
      .select({
        id: replicas.id,
        status: replicas.status,
        assignmentId: replicas.rebalanceAssignmentId,
        targetDeviceId: replicas.rebalancePeerDeviceId,
      })
      .from(replicas)
      .where(
        and(eq(replicas.deviceId, deviceId), eq(replicas.objectHash, objectHash))
      )
      .for("update")
      .limit(1);
    if (!replica) return false;
    if (
      replica.status !== "deleting" ||
      replica.assignmentId !== input.assignmentId ||
      !replica.targetDeviceId
    ) {
      throw AppError.conflict("Rebalance deletion assignment does not match");
    }

    await tx.delete(replicas).where(eq(replicas.id, replica.id));
    return true;
  });
  if (!removed) throw AppError.notFound("Rebalance deletion assignment not found");
  return { status: "deleted" };
}
