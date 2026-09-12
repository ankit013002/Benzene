import { and, eq, inArray, sql } from "drizzle-orm";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import { devices, replicas } from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";
import { ensureVaultForOwner } from "../vaults/vaults.service.js";
import { decidePlacement, reservePlacement } from "./placement.service.js";
import { issueTransferGrant, publicKeyFor } from "./transferGrant.js";

/**
 * Turns a placement decision into somewhere the browser can actually PUT.
 *
 * This is the join between the placement engine (which devices *should* hold
 * this) and the data plane (how to reach them, and with what authority). Bytes
 * go browser-to-device directly; the control plane only decides and authorises.
 */

export interface UploadTarget {
  deviceId: string;
  deviceName: string;
  /** Absolute URL of the device's transfer server. */
  url: string;
  /** Short-lived authorisation for this object on this device. */
  grant: string;
  expiresAt: string;
}

export interface UploadPlan {
  objectHash: string;
  sizeBytes: number;
  desiredReplicas: number;
  /** Devices that already hold these bytes; nothing needs re-sending to them. */
  alreadyHeldBy: string[];
  targets: UploadTarget[];
  /** True when fewer copies can be placed than the policy asks for. */
  shortfall: boolean;
  reason?: string;
  singleCopy: boolean;
}

function signingKey(): string {
  const key = config().transferSigningKey;
  if (!key) {
    throw new AppError(
      503,
      "NOT_CONFIGURED",
      "TRANSFER_SIGNING_KEY is not configured, so uploads to devices cannot be authorised"
    );
  }
  return key;
}

/** Handed to a device at enrollment so it can verify the grants it receives. */
export function transferPublicKey(): string {
  return publicKeyFor(signingKey());
}

/**
 * Plans an upload: decide, reserve, then authorise.
 *
 * Reservation happens before any grant is issued so two concurrent uploads of
 * the same object cannot both be told to use the same device, and so a
 * transfer that never completes is visible as an unfinished placement rather
 * than as nothing at all.
 */
export async function planUpload(
  ownerId: string,
  input: { objectHash: string; sizeBytes: number }
): Promise<UploadPlan> {
  const key = signingKey();
  const vault = await ensureVaultForOwner(ownerId);

  // Reachability is part of upload placement, not a post-selection filter. A
  // high-ranked offline-address device must not consume a slot that a lower-
  // ranked reachable device could fill. The retry closes the smaller race in
  // which a healthy existing holder begins draining between the decision and
  // the reservation transaction.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const decision = await decidePlacement(ownerId, input, { requireReachable: true });

    // Placement is allowed to consider only live capacity, but an online
    // device without an advertised URL still cannot receive browser traffic.
    // Filter before inserting replica rows so an unreachable machine is never
    // recorded as a physical copy (and cannot leave a false reservation behind).
    const deviceRows = await db()
      .select({
        id: devices.id,
        name: devices.name,
        advertisedUrl: devices.advertisedUrl,
      })
      .from(devices)
      .where(
        and(eq(devices.vaultId, vault.id), inArray(devices.id, decision.deviceIds))
      );
    const reachableIds = new Set(
      deviceRows.filter((row) => row.advertisedUrl).map((row) => row.id)
    );
    const reservableDeviceIds = decision.deviceIds.filter((id) => reachableIds.has(id));

    try {
      if (reservableDeviceIds.length > 0 || decision.existingDeviceIds.length > 0) {
        await reservePlacement(
          ownerId,
          {
            objectHash: input.objectHash,
            sizeBytes: input.sizeBytes,
            deviceIds: reservableDeviceIds,
          },
          {
            requireReachable: true,
            holdDeviceIds: decision.existingDeviceIds,
          }
        );
      }
    } catch (error) {
      // A drain or liveness change can win the device lock after the decision.
      // Recompute once so the returned plan never relies on the old holder.
      const retryable =
        error instanceof AppError &&
        (error.status === 409 ||
          (error.status === 400 && error.message.includes("cannot receive transfers")));
      if (attempt === 0 && retryable) continue;
      throw error;
    }

    const rows = deviceRows.filter((row) => reachableIds.has(row.id));
    const ttl = config().transferGrantTtlSeconds;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;

    const targets: UploadTarget[] = [];
    for (const row of rows) {
      // A device that has never advertised an address cannot be reached, so it
      // is dropped from the plan rather than handed to the browser as a target
      // that would fail on connect.
      if (!row.advertisedUrl) continue;

      targets.push({
        deviceId: row.id,
        deviceName: row.name,
        url: `${row.advertisedUrl.replace(/\/+$/, "")}/objects/${input.objectHash}`,
        grant: issueTransferGrant(key, {
          objectHash: input.objectHash,
          deviceId: row.id,
          op: "put",
          exp: expiresAt,
          size: input.sizeBytes,
        }),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      });
    }

    const placed = targets.length + decision.existingDeviceIds.length;

    return {
      objectHash: input.objectHash,
      sizeBytes: input.sizeBytes,
      desiredReplicas: decision.desiredReplicas,
      alreadyHeldBy: decision.existingDeviceIds,
      targets,
      shortfall: placed < decision.desiredReplicas,
      ...(placed < decision.desiredReplicas
        ? { reason: decision.reason ?? "unreachable_devices" }
        : {}),
      singleCopy: decision.singleCopy,
    };
  }

  throw new AppError(409, "PLACEMENT_CHANGED", "Placement changed while the upload was planned");
}

/** Authorises reading one object back from a device that holds it. */
export async function planDownload(
  ownerId: string,
  objectHash: string
): Promise<UploadTarget[]> {
  const key = signingKey();
  const vault = await ensureVaultForOwner(ownerId);

  const rows = await db()
    .select({
      id: devices.id,
      name: devices.name,
      advertisedUrl: devices.advertisedUrl,
      status: devices.status,
    })
    .from(replicas)
    .innerJoin(devices, eq(devices.id, replicas.deviceId))
    .where(
      and(
        eq(replicas.vaultId, vault.id),
        eq(replicas.objectHash, objectHash),
        eq(replicas.status, "healthy"),
        sql`${devices.status} <> 'removed'`
      )
    );

  const ttl = config().transferGrantTtlSeconds;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  return rows
    .filter((row) => row.advertisedUrl)
    .map((row) => ({
      deviceId: row.id,
      deviceName: row.name,
      url: `${row.advertisedUrl!.replace(/\/+$/, "")}/objects/${objectHash}`,
      grant: issueTransferGrant(key, {
        objectHash,
        deviceId: row.id,
        op: "get",
        exp: expiresAt,
      }),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    }));
}
