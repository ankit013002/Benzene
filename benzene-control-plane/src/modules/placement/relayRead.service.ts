import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import { devices, objectReferences, relayReadAssignments, replicas } from "../../db/schema.js";
import DriveNodeModel from "../../models/driveNode.model.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import {
  encryptedObjectStorageBytes,
  encryptedObjectV1MetadataSchema,
} from "../encryption/encryptedObjectV1.js";
import { classifyDeviceOutages } from "../devices/devices.service.js";
import { deriveDeviceStatus } from "../devices/liveness.js";
import { getVaultForOwner } from "../vaults/vaults.service.js";
import { AppError } from "../../utils/AppError.js";
import { issueRelayTicket, type RelayTicketScope } from "./relayTicket.js";

const ACTIVE_ASSIGNMENTS_PER_VAULT = 20;
const ACTIVE_ASSIGNMENTS_GLOBAL = 10_000;
const CLAIM_LEASE_SECONDS = 20;
const MAX_CLAIM_ATTEMPTS = 3;

interface RelayReadTicketBase {
  sessionId: string;
  relayUrl: string;
  storageHash: string;
  expiresAt: string;
}

export interface ClientRelayReadTicket extends RelayReadTicketBase {
  kind: "relay_fallback";
  ticket: string;
  ciphertextBytes: number;
}

export interface NodeRelayReadAssignment extends RelayReadTicketBase {
  assignmentId: string;
  nodeTicket: string;
  sizeBytes: number;
}

function signingKey(): string {
  const key = config().transferSigningKey;
  if (!key) {
    throw new AppError(503, "NOT_CONFIGURED", "TRANSFER_SIGNING_KEY is required for relay tickets");
  }
  return key;
}

function publicRelayUrl(): string {
  const configured = config().relayPublicUrl;
  if (!configured) {
    throw new AppError(503, "NOT_CONFIGURED", "RELAY_PUBLIC_URL is required for relay fallback");
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new AppError(503, "NOT_CONFIGURED", "RELAY_PUBLIC_URL must be an absolute wss URL");
  }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password
    || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new AppError(503, "NOT_CONFIGURED", "RELAY_PUBLIC_URL must be a wss origin without credentials or a path");
  }
  return configured.replace(/\/+$/, "");
}

function ticketPair(input: {
  storageHash: string;
  sizeBytes: number;
  deviceId: string;
  expiresAtSeconds: number;
}): { sessionId: string; clientTicket: string; nodeTicket: string } {
  const sessionId = randomUUID();
  const common = {
    v: 1 as const,
    sessionId,
    storageHash: input.storageHash,
    deviceId: input.deviceId,
    op: "get" as const,
    exp: input.expiresAtSeconds,
    maxBytes: input.sizeBytes,
  };
  return {
    sessionId,
    clientTicket: issueRelayTicket(signingKey(), {
      ...common,
      ticketId: randomUUID(),
      role: "client",
    }),
    nodeTicket: issueRelayTicket(signingKey(), {
      ...common,
      ticketId: randomUUID(),
      role: "node",
    }),
  };
}

function clientResult(input: {
  sessionId: string;
  clientTicket: string;
  storageHash: string;
  sizeBytes: number;
  expiresAt: Date;
}): ClientRelayReadTicket {
  return {
    kind: "relay_fallback",
    sessionId: input.sessionId,
    relayUrl: publicRelayUrl(),
    ticket: input.clientTicket,
    storageHash: input.storageHash,
    ciphertextBytes: input.sizeBytes,
    expiresAt: input.expiresAt.toISOString(),
  };
}

/**
 * Creates an explicitly requested GET fallback. Direct download planning is
 * unchanged; this operation only returns the client half of a fresh session.
 */
export async function createRelayReadFallback(
  ownerId: string,
  input: { nodeId: string; requestId: string }
): Promise<ClientRelayReadTicket> {
  publicRelayUrl();
  const vault = await getVaultForOwner(ownerId);
  await classifyDeviceOutages(vault.id);

  const node = await DriveNodeModel.findOne({
    _id: input.nodeId,
    ownerId,
    isDeleted: false,
    type: "file",
  }).select({ _id: 1 }).lean();
  if (!node) throw AppError.notFound("File not found");

  const version = await FileVersionModel.findOne({
    nodeId: node._id,
    ownerId,
    isCurrent: true,
    status: "committed",
    storageFormat: "benzene-encrypted-object-v1",
  }).lean();
  if (!version?.encryptedObject || !version.objectHash) {
    throw AppError.conflict("Current file version is not an encrypted v1 device object", {
      reason: "encrypted_object_required",
    });
  }
  const parsed = encryptedObjectV1MetadataSchema.safeParse(version.encryptedObject);
  if (!parsed.success
    || version.objectHash !== parsed.data.storageHash
    || version.storageBytes !== encryptedObjectStorageBytes(parsed.data)) {
    throw AppError.conflict("Current encrypted object metadata is inconsistent", {
      reason: "encrypted_object_inconsistent",
    });
  }

  const objectHash = parsed.data.storageHash;
  const sizeBytes = encryptedObjectStorageBytes(parsed.data);
  const [reference] = await db()
    .select({ versionId: objectReferences.versionId })
    .from(objectReferences)
    .where(and(
      eq(objectReferences.vaultId, vault.id),
      eq(objectReferences.versionId, version._id.toString()),
      eq(objectReferences.objectHash, objectHash)
    ))
    .limit(1);
  if (!reference) {
    throw AppError.conflict("Encrypted file version has no durable vault object reference", {
      reason: "object_reference_missing",
    });
  }

  const offlineAfterMs = config().deviceOfflineAfterSeconds * 1000;
  const extendedOfflineAfterMs = config().deviceExtendedOfflineAfterSeconds * 1000;
  const suspectedLostAfterMs = (config().deviceSuspectedLostAfterSeconds ?? Number.POSITIVE_INFINITY) * 1000;

  return db().transaction(async (tx) => {
    // Serialize the global queue cap, then share the object lock ordering used
    // by repair and GC so a holder cannot be selected while its replica retires.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('relay-read-assignment-cap'))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${vault.id}:${objectHash}`}))`);
    const transactionNow = new Date();

    const [liveReference] = await tx
      .select({ versionId: objectReferences.versionId })
      .from(objectReferences)
      .where(and(
        eq(objectReferences.vaultId, vault.id),
        eq(objectReferences.versionId, version._id.toString()),
        eq(objectReferences.objectHash, objectHash)
      ))
      .limit(1);
    if (!liveReference) {
      throw AppError.conflict("Encrypted file version no longer has a live object reference", {
        reason: "object_reference_missing",
      });
    }

    await tx.delete(relayReadAssignments).where(sql`${relayReadAssignments.expiresAt} <= ${transactionNow}`);
    const [retry] = await tx
      .select()
      .from(relayReadAssignments)
      .where(and(
        eq(relayReadAssignments.vaultId, vault.id),
        eq(relayReadAssignments.requestId, input.requestId),
        gt(relayReadAssignments.expiresAt, transactionNow)
      ))
      .limit(1);
    if (retry) {
      if (retry.objectHash !== objectHash || retry.sizeBytes !== sizeBytes) {
        throw AppError.conflict("Relay request id was already used for another object");
      }
      if (retry.status === "failed") {
        throw AppError.conflict("Relay request failed; use a new request id to retry");
      }
      return clientResult({
        sessionId: retry.sessionId,
        clientTicket: retry.clientTicket,
        storageHash: retry.objectHash,
        sizeBytes: retry.sizeBytes,
        expiresAt: retry.expiresAt,
      });
    }

    // Completed rows remain through ticket expiry for idempotent retries, so
    // include them in the short-lived storage bound as well as pending work.
    const [globalActive] = await tx
      .select({ value: count() })
      .from(relayReadAssignments)
      .where(gt(relayReadAssignments.expiresAt, transactionNow));
    if ((globalActive?.value ?? 0) >= ACTIVE_ASSIGNMENTS_GLOBAL) {
      throw new AppError(503, "RELAY_CAPACITY", "Relay assignment queue is full");
    }
    const [vaultActive] = await tx
      .select({ value: count() })
      .from(relayReadAssignments)
      .where(and(
        eq(relayReadAssignments.vaultId, vault.id),
        gt(relayReadAssignments.expiresAt, transactionNow)
      ));
    if ((vaultActive?.value ?? 0) >= ACTIVE_ASSIGNMENTS_PER_VAULT) {
      throw new AppError(429, "RELAY_RATE_LIMITED", "Too many active relay fallbacks for this Vault");
    }

    const candidates = await tx
      .select({
        deviceId: devices.id,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
      })
      .from(replicas)
      .innerJoin(devices, eq(devices.id, replicas.deviceId))
      .where(and(
        eq(replicas.vaultId, vault.id),
        eq(replicas.objectHash, objectHash),
        eq(replicas.sizeBytes, sizeBytes),
        eq(replicas.encryption, "benzene-encrypted-object-v1"),
        eq(replicas.status, "healthy"),
        sql`${devices.status} not in ('draining', 'removed', 'suspected_lost')`
      ))
      .orderBy(desc(devices.lastSeenAt), asc(replicas.createdAt))
      .for("update");
    const selected = candidates.find((candidate) => deriveDeviceStatus(
      candidate.status,
      candidate.lastSeenAt,
      offlineAfterMs,
      transactionNow.getTime(),
      extendedOfflineAfterMs,
      suspectedLostAfterMs
    ) === "online");
    if (!selected) {
      throw AppError.conflict("No online healthy encrypted replica is available for relay fallback", {
        reason: "relay_replica_unavailable",
      });
    }

    const expiresAtSeconds = Math.floor(transactionNow.getTime() / 1000)
      + Math.min(config().transferGrantTtlSeconds, 5 * 60);
    const expiresAt = new Date(expiresAtSeconds * 1000);
    const tickets = ticketPair({
      storageHash: objectHash,
      sizeBytes,
      deviceId: selected.deviceId,
      expiresAtSeconds,
    });
    const [assignment] = await tx
      .insert(relayReadAssignments)
      .values({
        vaultId: vault.id,
        requestId: input.requestId,
        objectHash,
        sizeBytes,
        deviceId: selected.deviceId,
        sessionId: tickets.sessionId,
        clientTicket: tickets.clientTicket,
        nodeTicket: tickets.nodeTicket,
        expiresAt,
      })
      .returning();
    if (!assignment) throw new AppError(500, "SERVER", "Relay assignment could not be persisted");
    return clientResult({
      sessionId: assignment.sessionId,
      clientTicket: assignment.clientTicket,
      storageHash: assignment.objectHash,
      sizeBytes: assignment.sizeBytes,
      expiresAt: assignment.expiresAt,
    });
  });
}

/** A signed device poll consumes at most one pending assignment for that device. */
export async function claimRelayReadForDevice(
  deviceId: string
): Promise<NodeRelayReadAssignment | null> {
  // Relay is optional in local/LAN deployments; ordinary agent heartbeats
  // should not become noisy failures when the explicit fallback is disabled.
  if (!config().relayPublicUrl) return null;
  const relayUrl = publicRelayUrl();
  const now = new Date();
  const [claimed] = await db().transaction(async (tx) => {
    const [device] = await tx
      .select({ vaultId: devices.vaultId, status: devices.status, lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1)
      .for("update");
    if (!device || deriveDeviceStatus(
      device.status,
      device.lastSeenAt,
      config().deviceOfflineAfterSeconds * 1000,
      now.getTime(),
      config().deviceExtendedOfflineAfterSeconds * 1000,
      (config().deviceSuspectedLostAfterSeconds ?? Number.POSITIVE_INFINITY) * 1000
    ) !== "online") return [];

    const [pending] = await tx
      .select()
      .from(relayReadAssignments)
      .where(and(
        eq(relayReadAssignments.deviceId, deviceId),
        gt(relayReadAssignments.expiresAt, now),
        or(
          eq(relayReadAssignments.status, "pending"),
          and(
            eq(relayReadAssignments.status, "claimed"),
            or(
              isNull(relayReadAssignments.claimLeaseExpiresAt),
              lte(relayReadAssignments.claimLeaseExpiresAt, now)
            )
          )
        )
      ))
      .orderBy(asc(relayReadAssignments.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!pending) return [];

    if (pending.claimAttempts >= MAX_CLAIM_ATTEMPTS) {
      await tx.update(relayReadAssignments)
        .set({ status: "failed", completedAt: now, claimLeaseExpiresAt: null })
        .where(eq(relayReadAssignments.id, pending.id));
      return [];
    }

    // A purge can remove the last logical reference after ticket issuance.
    // Do not hand a queued capability to a node after that transition.
    const [reference] = await tx
      .select({ versionId: objectReferences.versionId })
      .from(objectReferences)
      .where(and(
        eq(objectReferences.vaultId, pending.vaultId),
        eq(objectReferences.objectHash, pending.objectHash)
      ))
      .limit(1);
    if (!reference) {
      await tx.update(relayReadAssignments)
        .set({ status: "failed", completedAt: now, claimLeaseExpiresAt: null })
        .where(eq(relayReadAssignments.id, pending.id));
      return [];
    }

    const [replica] = await tx
      .select({ id: replicas.id })
      .from(replicas)
      .where(and(
        eq(replicas.vaultId, pending.vaultId),
        eq(replicas.deviceId, deviceId),
        eq(replicas.objectHash, pending.objectHash),
        eq(replicas.sizeBytes, pending.sizeBytes),
        eq(replicas.encryption, "benzene-encrypted-object-v1"),
        eq(replicas.status, "healthy")
      ))
      .limit(1)
      .for("update");
    if (!replica) {
      await tx.update(relayReadAssignments)
        .set({ status: "failed", completedAt: now, claimLeaseExpiresAt: null })
        .where(eq(relayReadAssignments.id, pending.id));
      return [];
    }

    const [updated] = await tx.update(relayReadAssignments)
      .set({
        status: "claimed",
        claimedAt: now,
        claimLeaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000),
        claimAttempts: pending.claimAttempts + 1,
      })
      .where(and(
        eq(relayReadAssignments.id, pending.id),
        eq(relayReadAssignments.status, pending.status)
      ))
      .returning();
    return updated ? [updated] : [];
  });
  if (!claimed) return null;
  return {
    assignmentId: claimed.id,
    sessionId: claimed.sessionId,
    relayUrl,
    nodeTicket: claimed.nodeTicket,
    storageHash: claimed.objectHash,
    sizeBytes: claimed.sizeBytes,
    expiresAt: claimed.expiresAt.toISOString(),
  };
}

/** Retires a claimed assignment after the node has attempted the transfer. */
export async function completeRelayReadForDevice(
  deviceId: string,
  input: { assignmentId: string; outcome: "sent" | "failed" }
): Promise<{ status: "completed" | "retrying" | "failed" }> {
  const now = new Date();
  const [updated] = await db().update(relayReadAssignments)
    .set(input.outcome === "sent"
      ? { status: "completed", completedAt: now, claimLeaseExpiresAt: null }
      : {
        status: sql`case when ${relayReadAssignments.claimAttempts} >= ${MAX_CLAIM_ATTEMPTS} then 'failed' else 'claimed' end`,
        completedAt: sql`case when ${relayReadAssignments.claimAttempts} >= ${MAX_CLAIM_ATTEMPTS} then ${now} else null end`,
        claimLeaseExpiresAt: sql`case when ${relayReadAssignments.claimAttempts} >= ${MAX_CLAIM_ATTEMPTS} then null else ${new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000)} end`,
      })
    .where(and(
      eq(relayReadAssignments.id, input.assignmentId),
      eq(relayReadAssignments.deviceId, deviceId),
      eq(relayReadAssignments.status, "claimed")
    ))
    .returning({ status: relayReadAssignments.status });
  if (!updated) {
    const [existing] = await db().select({ status: relayReadAssignments.status })
      .from(relayReadAssignments)
      .where(and(
        eq(relayReadAssignments.id, input.assignmentId),
        eq(relayReadAssignments.deviceId, deviceId)
      ))
      .limit(1);
    if (input.outcome === "sent" && existing?.status === "completed") {
      return { status: "completed" };
    }
    if (input.outcome === "failed" && existing?.status === "failed") {
      return { status: "failed" };
    }
    throw AppError.conflict("Relay assignment is not claimed by this device");
  }
  const status = updated.status;
  if (status !== "completed" && status !== "retrying" && status !== "failed") {
    return { status: "retrying" };
  }
  return { status };
}
