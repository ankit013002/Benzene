import { and, eq, or, sql } from "drizzle-orm";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import { deviceStorageAllocations, devices, replicas } from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";

/**
 * The MVP accepts a complete inventory in one request. This ceiling keeps a
 * single signed request from becoming an unbounded database transaction; a
 * caller over the ceiling must retry with a future paged protocol rather than
 * having the control plane silently discard the tail of the inventory.
 */
// The JSON parser allows 1 MiB bodies; 8,000 entries leaves headroom for the
// object fields and gives the MVP a deterministic, transaction-sized ceiling.
export const MAX_INVENTORY_OBJECTS = 8_000;

export interface InventoryObject {
  objectHash: string;
  sizeBytes: number;
}

export interface InventoryReconciliation {
  status: "online";
  reconciled: number;
  missing: number;
}

/**
 * Reconciles the metadata for a device that was presumed lost and has now
 * returned. The device authenticates its locally hash-verified hash/size
 * report by signing it; the control plane does not independently prove the
 * contents and never trusts the report to create new file metadata.
 */
export async function reconcileDeviceInventory(
  deviceId: string,
  reportedObjects: InventoryObject[]
): Promise<InventoryReconciliation> {
  const reportedByHash = new Map(
    reportedObjects.map((object) => [object.objectHash.toLowerCase(), object.sizeBytes])
  );
  const now = new Date();

  return db().transaction(async (tx) => {
    const [device] = await tx
      .select({
        id: devices.id,
        vaultId: devices.vaultId,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .for("update")
      .limit(1);

    if (!device) throw AppError.notFound("Device not found");
    if (device.status !== "suspected_lost") {
      throw AppError.conflict("Only a presumed-lost device can reconcile its inventory");
    }

    // Heartbeat usage is the capacity baseline. Lock it before any replica
    // work, and require the usage watermark to belong to the latest heartbeat
    // so revived copies can be stamped at that watermark without being counted
    // a second time by occupiedBytesSql.
    const [allocation] = await tx
      .select({ usageReportedAt: deviceStorageAllocations.usageReportedAt })
      .from(deviceStorageAllocations)
      .where(eq(deviceStorageAllocations.deviceId, deviceId))
      .for("update")
      .limit(1);
    if (
      !allocation?.usageReportedAt ||
      !device.lastSeenAt ||
      allocation.usageReportedAt.getTime() < device.lastSeenAt.getTime() ||
      now.getTime() - device.lastSeenAt.getTime() > config().deviceOfflineAfterSeconds * 1000 ||
      now.getTime() - allocation.usageReportedAt.getTime() >
        config().deviceOfflineAfterSeconds * 1000
    ) {
      throw AppError.conflict("Inventory reconciliation requires a completed usage heartbeat");
    }

    // Snapshot hashes without row locks, then acquire every object guard in a
    // stable order before locking any replica rows. Repair source-failure
    // reporting takes the same advisory guard before it locks target/source
    // rows; this ordering prevents a source row and target row from forming a
    // cycle while a returning device is being reconciled.
    const objectRows = await tx
      .select({ objectHash: replicas.objectHash })
      .from(replicas)
      .where(
        or(
          eq(replicas.deviceId, deviceId),
          and(eq(replicas.repairSourceDeviceId, deviceId), eq(replicas.status, "placing"))
        )
      );
    const objectHashes = [...new Set(objectRows.map((row) => row.objectHash))].sort();
    for (const objectHash of objectHashes) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${device.vaultId}:${objectHash}`}))`
      );
    }

    const deviceReplicas = await tx
      .select({
        id: replicas.id,
        objectHash: replicas.objectHash,
        sizeBytes: replicas.sizeBytes,
      })
      .from(replicas)
      .where(eq(replicas.deviceId, deviceId))
      .for("update");
    const boundRepairReplicas = await tx
      .select({
        id: replicas.id,
        objectHash: replicas.objectHash,
      })
      .from(replicas)
      .where(
        and(
          eq(replicas.vaultId, device.vaultId),
          eq(replicas.repairSourceDeviceId, deviceId),
          eq(replicas.status, "placing")
        )
      )
      .for("update");
    let reconciled = 0;
    let missing = 0;
    const sourceReplicaByHash = new Map(
      deviceReplicas.map((replica) => [replica.objectHash, replica])
    );
    for (const replica of deviceReplicas) {
      const reportedSize = reportedByHash.get(replica.objectHash.toLowerCase());
      const present =
        reportedSize !== undefined && Number(replica.sizeBytes) === reportedSize;

      await tx
        .update(replicas)
        .set({
          status: present ? "healthy" : "missing",
          verifiedAt: present ? allocation.usageReportedAt : null,
          repairSourceDeviceId: null,
          repairAssignmentId: null,
          updatedAt: now,
        })
        .where(and(eq(replicas.id, replica.id), eq(replicas.deviceId, deviceId)));

      if (present) reconciled += 1;
      else missing += 1;
    }

    // A target may still carry a binding even if the source replica row was
    // removed while the source was away. Treat that as an omitted source too;
    // leaving the binding would make later repair polls retry a dead source.
    for (const target of boundRepairReplicas) {
      const source = sourceReplicaByHash.get(target.objectHash);
      const reportedSize = source
        ? reportedByHash.get(source.objectHash.toLowerCase())
        : undefined;
      const sourcePresent =
        source !== undefined &&
        reportedSize !== undefined &&
        Number(source.sizeBytes) === reportedSize;
      if (!sourcePresent) {
        await tx
          .update(replicas)
          .set({
            status: "missing",
            repairSourceDeviceId: null,
            repairAssignmentId: null,
            updatedAt: now,
          })
          .where(eq(replicas.id, target.id));
      }
    }

    await tx
      .update(devices)
      .set({ status: "online", lastSeenAt: now, updatedAt: now })
      .where(and(eq(devices.id, deviceId), eq(devices.status, "suspected_lost")));

    return { status: "online", reconciled, missing };
  });
}
