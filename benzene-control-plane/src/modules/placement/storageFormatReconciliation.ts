import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import mongoose from "mongoose";

import * as schema from "../../db/schema.js";
import { db as applicationDb } from "../../db/client.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import {
  encryptedObjectStorageBytes,
  encryptedObjectV1MetadataSchema,
} from "../encryption/encryptedObjectV1.js";

type Database = NodePgDatabase<typeof schema>;
export type StorageEncryption = "none" | "benzene-encrypted-object-v1";

export type ReconciliationReason =
  | "missing_metadata"
  | "owner_mismatch"
  | "metadata_conflict"
  | "size_mismatch"
  | "invalid_size"
  | "cloud_only"
  | "reconciled";

export interface ReconciliationRow {
  replicaId: string;
  vaultId: string;
  ownerId: string;
  objectHash: string;
  sizeBytes: number;
  currentEncryption: string;
  classification?: StorageEncryption;
  reason?: ReconciliationReason;
}

export interface ReconciliationReport {
  mode: "dry-run" | "apply";
  scanned: number;
  classified: number;
  applied: number;
  unchanged: number;
  skipped: number;
  classificationCounts: Record<StorageEncryption, number>;
  reasonCounts: Record<ReconciliationReason, number>;
  rows: ReconciliationRow[];
}

interface MongoVersion {
  _id: mongoose.Types.ObjectId;
  ownerId?: unknown;
  status?: unknown;
  objectHash?: unknown;
  sha256?: unknown;
  bytes?: unknown;
  storageBytes?: unknown;
  storageFormat?: unknown;
  encryptedObject?: unknown;
  storage?: unknown;
}

function safeSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hashMatches(value: unknown, hash: string): boolean {
  return typeof value === "string" && value.toLowerCase() === hash.toLowerCase();
}

function hasCloudStorage(version: MongoVersion): boolean {
  return Boolean(version.storage);
}

function authoritativeHash(version: MongoVersion): unknown {
  return version.objectHash ?? version.sha256;
}

function classify(
  replica: { objectHash: string; sizeBytes: number; vaultId: string },
  ownerId: string,
  versions: MongoVersion[]
): { classification?: StorageEncryption; reason: ReconciliationReason } {
  if (!safeSize(replica.sizeBytes)) return { reason: "invalid_size" };

  const committed = versions.filter((version) => version.status === "committed");
  const matchingHash = committed.filter((version) =>
    hashMatches(authoritativeHash(version), replica.objectHash)
  );
  if (matchingHash.length === 0) {
    const wrongOwner = committed.some((version) =>
      hashMatches(authoritativeHash(version), replica.objectHash) &&
      version.ownerId !== ownerId
    );
    return { reason: wrongOwner ? "owner_mismatch" : "missing_metadata" };
  }

  const owned = matchingHash.filter((version) => version.ownerId === ownerId);
  if (owned.length === 0) return { reason: "owner_mismatch" };
  const deviceBacked = owned.filter((version) => !hasCloudStorage(version));
  if (deviceBacked.length === 0) return { reason: "cloud_only" };

  const classifications = new Set<StorageEncryption>();
  for (const version of deviceBacked) {
    if (!hashMatches(authoritativeHash(version), replica.objectHash)) return { reason: "metadata_conflict" };
    if (version.objectHash && version.sha256 && !hashMatches(version.objectHash, String(version.sha256))) {
      return { reason: "metadata_conflict" };
    }
    if (!safeSize(version.bytes)) return { reason: "invalid_size" };

    if (version.storageFormat === "benzene-encrypted-object-v1") {
      if (!version.encryptedObject || typeof version.encryptedObject !== "object") {
        return { reason: "metadata_conflict" };
      }
      const parsed = encryptedObjectV1MetadataSchema.safeParse(version.encryptedObject);
      if (!parsed.success || parsed.data.vaultId !== replica.vaultId || version.objectHash !== parsed.data.storageHash) {
        return { reason: "metadata_conflict" };
      }
      const encryptedObject = parsed.data;
      if (!safeSize(encryptedObject.plaintextSize) || encryptedObject.plaintextSize !== version.bytes) {
        return { reason: "metadata_conflict" };
      }
      const physicalBytes = version.storageBytes;
      if (!safeSize(physicalBytes) ||
        physicalBytes !== encryptedObjectStorageBytes(encryptedObject)) {
        return { reason: "metadata_conflict" };
      }
      if (replica.sizeBytes !== physicalBytes) return { reason: "size_mismatch" };
      classifications.add("benzene-encrypted-object-v1");
    } else {
      if (version.storageFormat || version.encryptedObject) return { reason: "metadata_conflict" };
      if (replica.sizeBytes !== version.bytes) return { reason: "size_mismatch" };
      classifications.add("none");
    }
  }

  if (classifications.size !== 1) return { reason: "metadata_conflict" };
  const [classification] = classifications;
  return classification
    ? { classification, reason: "reconciled" }
    : { reason: "metadata_conflict" };
}

/**
 * Reconciles only legacy `unknown` device replicas. MongoDB metadata is the
 * source of truth; PostgreSQL is updated only for a single consistent owner,
 * hash and physical size interpretation.
 */
export async function reconcileStorageFormats(options: {
  apply?: boolean;
  database?: Database;
} = {}): Promise<ReconciliationReport> {
  const database = options.database ?? applicationDb();
  const pending = await database
    .select({
      id: schema.replicas.id,
      vaultId: schema.replicas.vaultId,
      deviceVaultId: schema.devices.vaultId,
      ownerId: schema.vaults.ownerId,
      objectHash: schema.replicas.objectHash,
      sizeBytes: schema.replicas.sizeBytes,
      encryption: schema.replicas.encryption,
    })
    .from(schema.replicas)
    .innerJoin(schema.vaults, eq(schema.vaults.id, schema.replicas.vaultId))
    .innerJoin(schema.devices, eq(schema.devices.id, schema.replicas.deviceId))
    .where(eq(schema.replicas.encryption, "unknown"));

  const report: ReconciliationReport = {
    mode: options.apply ? "apply" : "dry-run",
    scanned: pending.length,
    classified: 0,
    applied: 0,
    unchanged: 0,
    skipped: 0,
    classificationCounts: {
      none: 0,
      "benzene-encrypted-object-v1": 0,
    },
    reasonCounts: {
      missing_metadata: 0,
      owner_mismatch: 0,
      metadata_conflict: 0,
      size_mismatch: 0,
      invalid_size: 0,
      cloud_only: 0,
      reconciled: 0,
    },
    rows: [],
  };

  const hashSet = [...new Set(pending.map((row) => row.objectHash))];
  const hashVariants = [...new Set(hashSet.flatMap((hash) => [hash.toLowerCase(), hash.toUpperCase()]))];
  const docs = hashSet.length
    ? await FileVersionModel.collection.find({
        $or: [
          { objectHash: { $in: hashVariants } },
          { sha256: { $in: hashVariants } },
        ],
      }).toArray() as unknown as MongoVersion[]
    : [];

  for (const replica of pending) {
    const row: ReconciliationRow = {
      replicaId: replica.id,
      vaultId: replica.vaultId,
      ownerId: replica.ownerId,
      objectHash: replica.objectHash,
      sizeBytes: replica.sizeBytes,
      currentEncryption: replica.encryption,
    };
    if (replica.deviceVaultId !== replica.vaultId) {
      row.reason = "metadata_conflict";
      report.skipped += 1;
      report.rows.push(row);
      continue;
    }
    const versions = docs.filter((version) =>
      hashMatches(version.objectHash, replica.objectHash) || hashMatches(version.sha256, replica.objectHash)
    );
    const result = classify(replica, replica.ownerId, versions);
    row.classification = result.classification;
    row.reason = result.reason;
    report.rows.push(row);
  }

  if (options.apply) {
    await database.transaction(async (tx) => {
      for (const row of report.rows) {
        if (!row.classification) continue;
        const updated = await tx
          .update(schema.replicas)
          .set({ encryption: row.classification, updatedAt: new Date() })
          .where(and(eq(schema.replicas.id, row.replicaId), eq(schema.replicas.encryption, "unknown")))
          .returning({ id: schema.replicas.id });
        if (updated.length === 1) {
          report.applied += 1;
          row.currentEncryption = row.classification;
        } else {
          report.unchanged += 1;
          row.reason = "metadata_conflict";
          row.classification = undefined;
        }
      }
    });
  }

  for (const row of report.rows) {
    if (row.classification) report.classificationCounts[row.classification] += 1;
    if (row.reason) report.reasonCounts[row.reason] += 1;
  }
  report.classified = Object.values(report.classificationCounts).reduce((sum, count) => sum + count, 0);
  report.skipped = Object.entries(report.reasonCounts)
    .filter(([reason]) => reason !== "reconciled")
    .reduce((sum, [, count]) => sum + count, 0);

  return report;
}
