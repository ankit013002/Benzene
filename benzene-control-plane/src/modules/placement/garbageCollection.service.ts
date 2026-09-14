import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { devices, objectReferences, replicas, vaults } from "../../db/schema.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import { AppError } from "../../utils/AppError.js";
import { ensureVaultForOwner } from "../vaults/vaults.service.js";

const DANGLING_REFERENCE_GRACE_MS = 24 * 60 * 60 * 1000;
const DANGLING_REFERENCE_CLEANUP_LIMIT = 32;
const CANDIDATE_SCAN_LIMIT = 32;

export interface GarbageCollectionAssignment {
  objectHash: string;
  assignmentId: string;
}

async function lockObject(
  executor: ReturnType<typeof db>,
  vaultId: string,
  objectHash: string
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${vaultId}:${objectHash}`}))`
  );
}

/** Registers a conservative reference before device placement can be returned. */
export async function registerObjectReference(
  ownerId: string,
  input: { versionId: string; objectHash: string }
): Promise<void> {
  const vault = await ensureVaultForOwner(ownerId);
  const objectHash = input.objectHash.toLowerCase();

  await db().transaction(async (tx) => {
    await lockObject(tx, vault.id, objectHash);
    await tx
      .insert(objectReferences)
      .values({ versionId: input.versionId, vaultId: vault.id, objectHash })
      .onConflictDoNothing({ target: objectReferences.versionId });

    const [activeDeletion] = await tx
      .select({ id: replicas.id })
      .from(replicas)
      .where(
        and(
          eq(replicas.vaultId, vault.id),
          eq(replicas.objectHash, objectHash),
          eq(replicas.status, "deleting")
        )
      )
      .limit(1);
    if (!activeDeletion) {
      // Completed deletions remain as missing markers until every device has
      // acknowledged. A newly live reference cancels that sweep and lets the
      // ordinary repair path restore only the copies already removed.
      await tx
        .update(replicas)
        .set({
          garbageCollectionAssignmentId: null,
          garbageCollectionAssignedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(replicas.vaultId, vault.id),
            eq(replicas.objectHash, objectHash),
            sql`${replicas.garbageCollectionAssignmentId} is not null`
          )
        );
    }
  });
}

/** Removes only references whose Mongo versions were already purged. */
export async function releaseObjectReferences(
  ownerId: string,
  versionIds: string[]
): Promise<void> {
  if (versionIds.length === 0) return;
  const vault = await ensureVaultForOwner(ownerId);
  await db()
    .delete(objectReferences)
    .where(
      and(
        eq(objectReferences.vaultId, vault.id),
        inArray(objectReferences.versionId, [...new Set(versionIds)])
      )
    );
}

/**
 * A crash after Mongo purge but before reference release leaks capacity rather
 * than deleting data. This bounded repair removes only old references whose
 * exact version still does not exist.
 */
async function pruneDanglingReferences(vaultId: string, ownerId: string): Promise<void> {
  const stale = await db()
    .select({
      versionId: objectReferences.versionId,
      objectHash: objectReferences.objectHash,
    })
    .from(objectReferences)
    .where(
      and(
        eq(objectReferences.vaultId, vaultId),
        lt(
          objectReferences.createdAt,
          new Date(Date.now() - DANGLING_REFERENCE_GRACE_MS)
        )
      )
    )
    .orderBy(asc(objectReferences.createdAt))
    .limit(DANGLING_REFERENCE_CLEANUP_LIMIT);

  for (const reference of stale) {
    const versionExists = await FileVersionModel.exists({
      _id: reference.versionId,
      ownerId,
      objectHash: reference.objectHash,
    });
    if (versionExists) continue;

    await db().transaction(async (tx) => {
      await lockObject(tx, vaultId, reference.objectHash);
      await tx
        .delete(objectReferences)
        .where(
          and(
            eq(objectReferences.versionId, reference.versionId),
            eq(objectReferences.vaultId, vaultId),
            lt(
              objectReferences.createdAt,
              new Date(Date.now() - DANGLING_REFERENCE_GRACE_MS)
            )
          )
        );
    });
  }
}

async function backfillLegacyReferences(
  vaultId: string,
  ownerId: string,
  objectHash: string
): Promise<boolean> {
  const versions = await FileVersionModel.find({ ownerId, objectHash })
    .select("_id")
    .lean();
  if (versions.length === 0) return false;

  await db().transaction(async (tx) => {
    await lockObject(tx, vaultId, objectHash);
    await tx
      .insert(objectReferences)
      .values(
        versions.map((version) => ({
          versionId: version._id.toString(),
          vaultId,
          objectHash,
        }))
      )
      .onConflictDoNothing({ target: objectReferences.versionId });
  });
  return true;
}

/** Returns at most one durable, retryable deletion assignment for this node. */
export async function pollGarbageCollection(
  deviceId: string
): Promise<GarbageCollectionAssignment | null> {
  const [device] = await db()
    .select({ vaultId: devices.vaultId, ownerId: vaults.ownerId, status: devices.status })
    .from(devices)
    .innerJoin(vaults, eq(vaults.id, devices.vaultId))
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) throw AppError.notFound("Device not found");
  if (device.status !== "online") return null;

  await pruneDanglingReferences(device.vaultId, device.ownerId);

  const [existing] = await db()
    .select({
      objectHash: replicas.objectHash,
      assignmentId: replicas.garbageCollectionAssignmentId,
    })
    .from(replicas)
    .where(and(eq(replicas.deviceId, deviceId), eq(replicas.status, "deleting")))
    .orderBy(asc(replicas.updatedAt))
    .limit(1);
  if (existing?.assignmentId) {
    return { objectHash: existing.objectHash, assignmentId: existing.assignmentId };
  }

  const candidates = await db()
    .select({ id: replicas.id, objectHash: replicas.objectHash })
    .from(replicas)
    .where(
      and(
        eq(replicas.deviceId, deviceId),
        ne(replicas.status, "placing"),
        ne(replicas.status, "deleting"),
        isNull(replicas.garbageCollectionAssignmentId),
        sql`not exists (
          select 1 from ${objectReferences}
          where ${objectReferences.vaultId} = ${replicas.vaultId}
            and ${objectReferences.objectHash} = ${replicas.objectHash}
        )`
      )
    )
    .orderBy(asc(replicas.createdAt))
    .limit(CANDIDATE_SCAN_LIMIT);

  for (const candidate of candidates) {
    if (
      await backfillLegacyReferences(
        device.vaultId,
        device.ownerId,
        candidate.objectHash
      )
    ) {
      continue;
    }

    const assignment = await db().transaction(async (tx) => {
      await lockObject(tx, device.vaultId, candidate.objectHash);
      const [referenced] = await tx
        .select({ versionId: objectReferences.versionId })
        .from(objectReferences)
        .where(
          and(
            eq(objectReferences.vaultId, device.vaultId),
            eq(objectReferences.objectHash, candidate.objectHash)
          )
        )
        .limit(1);
      if (referenced) return null;

      const assignmentId = randomUUID();
      const [updated] = await tx
        .update(replicas)
        .set({
          status: "deleting",
          garbageCollectionAssignmentId: assignmentId,
          garbageCollectionAssignedAt: new Date(),
          repairSourceDeviceId: null,
          repairAssignmentId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(replicas.id, candidate.id),
            ne(replicas.status, "placing"),
            ne(replicas.status, "deleting")
          )
        )
        .returning({ objectHash: replicas.objectHash });
      return updated ? { objectHash: updated.objectHash, assignmentId } : null;
    });
    if (assignment) return assignment;
  }

  return null;
}

/** Acknowledges the exact assignment only after the node's idempotent delete. */
export async function completeGarbageCollection(
  deviceId: string,
  input: GarbageCollectionAssignment
): Promise<{ status: "deleted" }> {
  const removed = await db().transaction(async (tx) => {
    const [device] = await tx
      .select({ vaultId: devices.vaultId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) return false;
    const objectHash = input.objectHash.toLowerCase();
    await lockObject(tx, device.vaultId, objectHash);

    const [replica] = await tx
      .select({
        id: replicas.id,
        status: replicas.status,
        assignmentId: replicas.garbageCollectionAssignmentId,
      })
      .from(replicas)
      .where(
        and(
          eq(replicas.deviceId, deviceId),
          eq(replicas.objectHash, objectHash)
        )
      )
      .for("update")
      .limit(1);
    if (!replica) return false;
    if (
      replica.status !== "deleting" ||
      replica.assignmentId !== input.assignmentId
    ) {
      throw AppError.conflict("Garbage-collection assignment does not match");
    }

    // Keep an acknowledged missing marker until every device has deleted its
    // copy. This suppresses repair for the object between per-device polls.
    await tx
      .update(replicas)
      .set({ status: "missing", verifiedAt: null, updatedAt: new Date() })
      .where(eq(replicas.id, replica.id));

    const [referenced] = await tx
      .select({ versionId: objectReferences.versionId })
      .from(objectReferences)
      .where(
        and(
          eq(objectReferences.vaultId, device.vaultId),
          eq(objectReferences.objectHash, objectHash)
        )
      )
      .limit(1);
    if (referenced) {
      // The assigned bytes are already gone, so that row stays missing. Other
      // copies are released from GC and may satisfy or repair the new version.
      await tx
        .update(replicas)
        .set({
          garbageCollectionAssignmentId: null,
          garbageCollectionAssignedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(replicas.vaultId, device.vaultId),
            eq(replicas.objectHash, objectHash)
          )
        );
      return true;
    }

    const [remaining] = await tx
      .select({ id: replicas.id })
      .from(replicas)
      .where(
        and(
          eq(replicas.vaultId, device.vaultId),
          eq(replicas.objectHash, objectHash),
          isNull(replicas.garbageCollectionAssignmentId)
        )
      )
      .limit(1);
    if (!remaining) {
      await tx
        .delete(replicas)
        .where(
          and(
            eq(replicas.vaultId, device.vaultId),
            eq(replicas.objectHash, objectHash)
          )
        );
    }
    return true;
  });

  if (!removed) {
    throw AppError.notFound("Garbage-collection assignment not found");
  }
  return { status: "deleted" };
}
