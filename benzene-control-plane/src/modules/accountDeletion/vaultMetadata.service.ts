import { and, eq, gt, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import {
  devices,
  objectReferences,
  relayReadAssignments,
  replicas,
  vaults,
} from "../../db/schema.js";
import FileVersionModel from "../../models/fileVersion.model.js";

export interface VaultMetadataDeletionProgress {
  complete: boolean;
  reason?: "stored_objects_remain" | "references_remain" | "replicas_remain" | "devices_not_removed" | "relay_reads_active";
  deletedVaults: number;
}

/**
 * Removes the owner's relational Vault graph only after byte cleanup and every
 * device's signed erase handshake have completed. Cascade deletion is safe at
 * this point because no live object reference or replica may remain.
 */
export async function deleteAccountVaultMetadata(
  ownerId: string,
): Promise<VaultMetadataDeletionProgress> {
  return db().transaction(async (tx) => {
    const [vault] = await tx
      .select({ id: vaults.id })
      .from(vaults)
      .where(eq(vaults.ownerId, ownerId))
      .for("update")
      .limit(1);

    if (!vault) {
      // Mongo's legacy collection has no FK to the relational Vault graph, so
      // a missing Vault row alone cannot prove that account metadata is gone.
      if (await FileVersionModel.exists({ ownerId })) {
        return {
          complete: false,
          reason: "stored_objects_remain",
          deletedVaults: 0,
        };
      }
      return { complete: true, deletedVaults: 0 };
    }

    // Mongo is the legacy source of committed version metadata; PostgreSQL
    // references alone cannot prove the account has no remaining versions.
    if (await FileVersionModel.exists({ ownerId })) {
      return {
        complete: false,
        reason: "stored_objects_remain",
        deletedVaults: 0,
      };
    }

    const [reference] = await tx
      .select({ versionId: objectReferences.versionId })
      .from(objectReferences)
      .where(eq(objectReferences.vaultId, vault.id))
      .limit(1);
    if (reference) {
      return { complete: false, reason: "references_remain", deletedVaults: 0 };
    }

    const [replica] = await tx
      .select({ id: replicas.id })
      .from(replicas)
      .where(eq(replicas.vaultId, vault.id))
      .limit(1);
    if (replica) {
      return { complete: false, reason: "replicas_remain", deletedVaults: 0 };
    }

    const [activeDevice] = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.vaultId, vault.id), sql`${devices.status} <> 'removed'`))
      .limit(1);
    if (activeDevice) {
      return { complete: false, reason: "devices_not_removed", deletedVaults: 0 };
    }

    const [activeRelayRead] = await tx
      .select({ id: relayReadAssignments.id })
      .from(relayReadAssignments)
      .where(
        and(
          eq(relayReadAssignments.vaultId, vault.id),
          gt(relayReadAssignments.expiresAt, new Date()),
          sql`${relayReadAssignments.status} in ('pending', 'claimed')`,
        ),
      )
      .limit(1);
    if (activeRelayRead) {
      return { complete: false, reason: "relay_reads_active", deletedVaults: 0 };
    }

    // The FK graph intentionally cascades enrollments, removed device records,
    // allocations, policies and expired relay assignments with this Vault row.
    // The blockers above ensure no storage-bearing or active state is erased.
    const deleted = await tx
      .delete(vaults)
      .where(eq(vaults.id, vault.id))
      .returning({ id: vaults.id });
    return { complete: deleted.length === 1, deletedVaults: deleted.length };
  });
}
