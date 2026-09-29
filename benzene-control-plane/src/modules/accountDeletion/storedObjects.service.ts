import { and, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { objectReferences, replicas, vaults } from "../../db/schema.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import { releaseMissingObjectReferences, releaseObjectReferences } from "../placement/garbageCollection.service.js";
import { storage } from "../../storage/index.js";

const VERSION_BATCH_LIMIT = 50;
const REFERENCE_REPAIR_LIMIT = 50;

export interface StoredObjectsDeletionProgress {
  complete: boolean;
  purgedVersions: number;
  releasedReferences: number;
}

/**
 * Purges one bounded slice using the same version, reference and GC handoff
 * semantics as explicit file purge. Device bytes remain until each holder has
 * acknowledged its durable garbage-collection assignment.
 */
export async function purgeAccountStoredObjects(
  ownerId: string
): Promise<StoredObjectsDeletionProgress> {
  const versions = await FileVersionModel.find({ ownerId })
    .select("_id objectHash storage.key")
    .sort({ _id: 1 })
    .limit(VERSION_BATCH_LIMIT)
    .lean();

  if (versions.length > 0) {
    const legacyKeys = versions
      .map((version) => version.storage?.key)
      .filter((key): key is string => Boolean(key));
    if (legacyKeys.length > 0) {
      await Promise.all(legacyKeys.map((key) => storage().deleteObject(key)));
    }

    const versionIds = versions.map((version) => version._id.toString());
    await FileVersionModel.deleteMany({ _id: { $in: versionIds }, ownerId });
    await releaseObjectReferences(ownerId, versionIds);
  }

  const releasedReferences = await releaseMissingObjectReferences(
    ownerId,
    REFERENCE_REPAIR_LIMIT
  );

  const remainingVersion = await FileVersionModel.exists({ ownerId });
  if (remainingVersion) {
    return {
      complete: false,
      purgedVersions: versions.length,
      releasedReferences,
    };
  }

  const [vault] = await db()
    .select({ id: vaults.id })
    .from(vaults)
    .where(eq(vaults.ownerId, ownerId))
    .limit(1);
  if (!vault) {
    return { complete: true, purgedVersions: versions.length, releasedReferences };
  }

  const [reference] = await db()
    .select({ versionId: objectReferences.versionId })
    .from(objectReferences)
    .where(eq(objectReferences.vaultId, vault.id))
    .limit(1);
  const [replica] = await db()
    .select({ id: replicas.id })
    .from(replicas)
    .where(and(eq(replicas.vaultId, vault.id)))
    .limit(1);

  return {
    complete: !reference && !replica,
    purgedVersions: versions.length,
    releasedReferences,
  };
}
