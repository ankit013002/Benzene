import { eq, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { deviceStorageAllocations, devices, vaults, type Vault } from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";
import { config } from "../../config/env.js";
import { classifyDeviceOutages } from "../devices/outageClassification.js";
import { deviceOnlineSince } from "../devices/liveness.js";

/**
 * Returns the caller's vault, creating it on first use.
 *
 * Written as an upsert rather than select-then-insert so two concurrent first
 * requests cannot both decide the vault is missing and race to create it.
 */
export async function ensureVaultForOwner(ownerId: string): Promise<Vault> {
  const [created] = await db()
    .insert(vaults)
    .values({ ownerId })
    .onConflictDoNothing({ target: vaults.ownerId })
    .returning();

  if (created) return created;

  const [existing] = await db()
    .select()
    .from(vaults)
    .where(eq(vaults.ownerId, ownerId))
    .limit(1);

  if (!existing) {
    throw new AppError(500, "SERVER", "Vault could not be created or loaded");
  }
  return existing;
}

export async function getVaultForOwner(ownerId: string): Promise<Vault> {
  const [vault] = await db()
    .select()
    .from(vaults)
    .where(eq(vaults.ownerId, ownerId))
    .limit(1);

  if (!vault) throw AppError.notFound("Vault not found");
  return vault;
}

export interface VaultSummary {
  id: string;
  name: string;
  /** Total contributed across every device, online or not. */
  rawCapacityBytes: number;
  /** Contributed by devices currently reachable. */
  onlineCapacityBytes: number;
  usedBytes: number;
  deviceCount: number;
  onlineDeviceCount: number;
}

/**
 * The numbers behind the Vault screen.
 *
 * Online capacity is reported separately from raw capacity because they answer
 * different user questions: raw is "how much storage do I own", online is "how
 * much can I actually write to right now".
 */
export async function getVaultSummary(ownerId: string): Promise<VaultSummary> {
  const vault = await ensureVaultForOwner(ownerId);
  await classifyDeviceOutages(vault.id);
  const onlineSince = deviceOnlineSince(config().deviceOfflineAfterSeconds * 1000);

  const [row] = await db()
    .select({
      rawCapacityBytes: sql<number>`
        coalesce(sum(${deviceStorageAllocations.allocatedBytes}), 0)::bigint
      `,
      onlineCapacityBytes: sql<number>`
        coalesce(sum(${deviceStorageAllocations.allocatedBytes})
          filter (
            where ${devices.status} not in ('draining', 'removed', 'extended_offline', 'suspected_lost')
              and ${devices.lastSeenAt} >= ${onlineSince}
          ), 0)::bigint
      `,
      usedBytes: sql<number>`
        coalesce(sum(${deviceStorageAllocations.usedBytes}), 0)::bigint
      `,
      deviceCount: sql<number>`
        count(distinct ${devices.id})::int
      `,
      onlineDeviceCount: sql<number>`
        count(distinct ${devices.id}) filter (
          where ${devices.status} not in ('draining', 'removed', 'extended_offline', 'suspected_lost')
            and ${devices.lastSeenAt} >= ${onlineSince}
        )::int
      `,
    })
    .from(devices)
    .leftJoin(
      deviceStorageAllocations,
      eq(deviceStorageAllocations.deviceId, devices.id)
    )
    .where(sql`${devices.vaultId} = ${vault.id} and ${devices.status} <> 'removed'`);

  return {
    id: vault.id,
    name: vault.name,
    rawCapacityBytes: Number(row?.rawCapacityBytes ?? 0),
    onlineCapacityBytes: Number(row?.onlineCapacityBytes ?? 0),
    usedBytes: Number(row?.usedBytes ?? 0),
    deviceCount: Number(row?.deviceCount ?? 0),
    onlineDeviceCount: Number(row?.onlineDeviceCount ?? 0),
  };
}

export async function renameVault(ownerId: string, name: string): Promise<Vault> {
  const [updated] = await db()
    .update(vaults)
    .set({ name, updatedAt: new Date() })
    .where(eq(vaults.ownerId, ownerId))
    .returning();

  if (!updated) throw AppError.notFound("Vault not found");
  return updated;
}
