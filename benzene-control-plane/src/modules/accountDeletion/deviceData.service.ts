import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { devices, vaults } from "../../db/schema.js";
import { beginDeviceRemoval } from "../devices/devices.service.js";

export interface DeviceDataDeletionProgress {
  complete: boolean;
  removalStarted: number;
  awaitingDeviceAcknowledgement: number;
}

/**
 * Starts the existing protection-aware erase handshake for every device in
 * the owner's Vault. A device row remains until that device reports the erase
 * over its signed removal endpoint, so offline devices keep this phase pending.
 */
export async function removeAccountDeviceData(
  ownerId: string
): Promise<DeviceDataDeletionProgress> {
  const [vault] = await db()
    .select({ id: vaults.id })
    .from(vaults)
    .where(eq(vaults.ownerId, ownerId))
    .limit(1);

  if (!vault) {
    return {
      complete: true,
      removalStarted: 0,
      awaitingDeviceAcknowledgement: 0,
    };
  }

  const activeDevices = await db()
    .select({ id: devices.id, status: devices.status })
    .from(devices)
    .where(
      and(eq(devices.vaultId, vault.id), sql`${devices.status} <> 'removed'`)
    )
    .orderBy(devices.id);

  let removalStarted = 0;
  for (const device of activeDevices) {
    if (device.status === "draining") continue;
    try {
      await beginDeviceRemoval(ownerId, device.id);
      removalStarted += 1;
    } catch (error) {
      // Multiple worker instances may race the node's final acknowledgement.
      // Treat that race as complete only when a fresh read proves it reached a
      // durable draining/removed state; otherwise preserve the failure.
      const [current] = await db()
        .select({ status: devices.status })
        .from(devices)
        .where(and(eq(devices.id, device.id), eq(devices.vaultId, vault.id)))
        .limit(1);
      if (current?.status !== "draining" && current?.status !== "removed") {
        throw error;
      }
    }
  }

  const [remaining] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.vaultId, vault.id), sql`${devices.status} <> 'removed'`));
  const awaitingDeviceAcknowledgement = Number(remaining?.count ?? 0);

  return {
    complete: awaitingDeviceAcknowledgement === 0,
    removalStarted,
    awaitingDeviceAcknowledgement,
  };
}
