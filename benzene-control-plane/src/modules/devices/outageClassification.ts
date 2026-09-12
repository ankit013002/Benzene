import { and, eq, sql } from "drizzle-orm";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import { devices } from "../../db/schema.js";
import { deriveDeviceStatus as deriveStatus } from "./liveness.js";

/**
 * Persists lifecycle classification without making elapsed time destructive.
 * A presumed-lost device is quarantined, while its replica rows remain intact
 * for a later inventory reconciliation when the device returns. Classification
 * is intentionally opportunistic: active repair polls and user-facing reads
 * call this function, so this slice does not add a scheduler or recovery
 * protocol.
 */
export async function classifyDeviceOutages(
  vaultId?: string,
  nowMs = Date.now()
): Promise<{ offline: number; extendedOffline: number; suspectedLost: number }> {
  const appConfig = config();
  const offlineAfterMs = appConfig.deviceOfflineAfterSeconds * 1000;
  const extendedOfflineAfterMs = appConfig.deviceExtendedOfflineAfterSeconds * 1000;
  const suspectedLostAfterMs =
    (appConfig.deviceSuspectedLostAfterSeconds ?? Number.POSITIVE_INFINITY) * 1000;

  return db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: devices.id, status: devices.status, lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(
        vaultId
          ? and(
              eq(devices.vaultId, vaultId),
              sql`${devices.status} not in ('draining', 'removed', 'suspected_lost')`
            )
          : sql`${devices.status} not in ('draining', 'removed', 'suspected_lost')`
      )
      .for("update");

    const counts = { offline: 0, extendedOffline: 0, suspectedLost: 0 };
    for (const row of rows) {
      const next = deriveStatus(
        row.status,
        row.lastSeenAt,
        offlineAfterMs,
        nowMs,
        extendedOfflineAfterMs,
        suspectedLostAfterMs
      );
      if (next === row.status || next === "online" || next === "pending") continue;

      await tx.update(devices).set({ status: next, updatedAt: new Date(nowMs) }).where(eq(devices.id, row.id));
      if (next === "offline") counts.offline += 1;
      else if (next === "extended_offline") counts.extendedOffline += 1;
      else if (next === "suspected_lost") counts.suspectedLost += 1;
    }
    return counts;
  });
}
