import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import { reconcileStorageFormats } from "./storageFormatReconciliation.js";

const OWNER = "storage-format-owner";
const OTHER_OWNER = "other-storage-format-owner";

let db: NodePgDatabase<typeof schema>;
let mongo: MongoMemoryServer | undefined;
let vaultId: string;
let deviceId: string;

function hash(fill: string): string {
  return fill.repeat(64).slice(0, 64);
}

async function unknownReplica(objectHash: string, sizeBytes: number): Promise<string> {
  const [replica] = await db
    .insert(schema.replicas)
    .values({ vaultId, deviceId, objectHash, sizeBytes, status: "healthy", encryption: "unknown" })
    .returning({ id: schema.replicas.id });
  if (!replica) throw new Error("Replica fixture was not created");
  return replica.id;
}

async function version(input: Record<string, unknown>): Promise<void> {
  await FileVersionModel.collection.insertOne({
    _id: new mongoose.Types.ObjectId(),
    ownerId: OWNER,
    version: 1,
    bytes: 12,
    status: "committed",
    uploadedBy: OWNER,
    uploadedAt: new Date(),
    isCurrent: true,
    meta: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input,
  });
}

function encryptedMetadata(storageHash: string): Record<string, unknown> {
  return {
    format: "benzene-encrypted-object",
    version: 1,
    payloadAlgorithm: "AES-256-GCM",
    keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
    vaultId,
    objectId: hash("j"),
    storageHash,
    plaintextSize: 12,
    payloadNonce: "AAAAAAAAAAAAAAAA",
    wrappedKeyNonce: "AAAAAAAAAAAAAAAA",
    wrappedKeyCiphertext: "A".repeat(64),
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] = mongo.getUri();
  resetConfigCache();
  db = await setupTestDb();
  await mongoose.connect(mongo.getUri());
  await FileVersionModel.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (db) await teardownTestDb();
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await FileVersionModel.deleteMany({});
  await truncateAll(db);
});

async function createVaultAndDevice(ownerId = OWNER): Promise<void> {
  const [vault] = await db.insert(schema.vaults).values({ ownerId }).returning();
  if (!vault) throw new Error("Vault fixture was not created");
  vaultId = vault.id;
  const [device] = await db.insert(schema.devices).values({
    vaultId,
    name: "reconciliation fixture",
    platform: "linux",
    publicKey: randomBytes(32).toString("base64"),
  }).returning();
  if (!device) throw new Error("Device fixture was not created");
  deviceId = device.id;
}

describe("storage-format reconciliation", () => {
  it("dry-runs plaintext and encrypted classifications without writing and excludes cloud metadata", async () => {
    await createVaultAndDevice();
    const plainHash = hash("a");
    const encryptedHash = hash("b");
    const cloudHash = hash("c");
    const missingHash = hash("d");
    const crossOwnerHash = hash("n");
    const cloudAndDeviceHash = hash("o");
    const plainId = await unknownReplica(plainHash, 12);
    const encryptedId = await unknownReplica(encryptedHash, 28);
    const cloudId = await unknownReplica(cloudHash, 12);
    await unknownReplica(missingHash, 12);
    const crossOwnerId = await unknownReplica(crossOwnerHash, 12);
    const cloudAndDeviceId = await unknownReplica(cloudAndDeviceHash, 12);

    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash: plainHash, sha256: plainHash, bytes: 12 });
    await version({
      nodeId: new mongoose.Types.ObjectId(),
      objectHash: encryptedHash,
      sha256: encryptedHash,
      bytes: 12,
      storageBytes: 28,
      storageFormat: "benzene-encrypted-object-v1",
      encryptedObject: encryptedMetadata(encryptedHash),
    });
    await version({
      nodeId: new mongoose.Types.ObjectId(),
      objectHash: cloudHash,
      sha256: cloudHash,
      bytes: 12,
      storage: { driver: "s3", bucket: "fixture", key: "fixture" },
    });
    await version({
      nodeId: new mongoose.Types.ObjectId(), objectHash: crossOwnerHash, sha256: crossOwnerHash, bytes: 12, ownerId: OTHER_OWNER,
    });
    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash: crossOwnerHash, sha256: crossOwnerHash, bytes: 12 });
    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash: cloudAndDeviceHash, sha256: cloudAndDeviceHash, bytes: 12 });
    await version({
      nodeId: new mongoose.Types.ObjectId(),
      objectHash: cloudAndDeviceHash,
      sha256: cloudAndDeviceHash,
      bytes: 12,
      storage: { driver: "s3", bucket: "fixture", key: "same-hash-cloud-copy" },
    });

    const report = await reconcileStorageFormats({ database: db });
    expect(report).toMatchObject({
      mode: "dry-run",
      scanned: 6,
      classified: 4,
      applied: 0,
      skipped: 2,
      classificationCounts: { none: 3, "benzene-encrypted-object-v1": 1 },
      reasonCounts: {
        missing_metadata: 1,
        owner_mismatch: 0,
        metadata_conflict: 0,
        size_mismatch: 0,
        invalid_size: 0,
        cloud_only: 1,
        reconciled: 4,
      },
    });
    expect(report.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ replicaId: plainId, classification: "none", reason: "reconciled" }),
      expect.objectContaining({ replicaId: encryptedId, classification: "benzene-encrypted-object-v1", reason: "reconciled" }),
      expect.objectContaining({ replicaId: cloudId, reason: "cloud_only" }),
      expect.objectContaining({ objectHash: missingHash, reason: "missing_metadata" }),
      expect.objectContaining({ replicaId: crossOwnerId, classification: "none", reason: "reconciled" }),
      expect.objectContaining({ replicaId: cloudAndDeviceId, classification: "none", reason: "reconciled" }),
    ]));
    const rows = await db.select({ encryption: schema.replicas.encryption }).from(schema.replicas);
    expect(rows.every((row) => row.encryption === "unknown")).toBe(true);
  });

  it("applies unambiguous rows and makes the next run a no-op", async () => {
    await createVaultAndDevice();
    const objectHash = hash("e");
    const replicaId = await unknownReplica(objectHash, 12);
    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash, sha256: objectHash, bytes: 12 });

    const applied = await reconcileStorageFormats({ database: db, apply: true });
    expect(applied).toMatchObject({
      mode: "apply",
      classified: 1,
      applied: 1,
      skipped: 0,
      classificationCounts: { none: 1, "benzene-encrypted-object-v1": 0 },
      reasonCounts: {
        missing_metadata: 0,
        owner_mismatch: 0,
        metadata_conflict: 0,
        size_mismatch: 0,
        invalid_size: 0,
        cloud_only: 0,
        reconciled: 1,
      },
    });
    await expect(
      db.select({ encryption: schema.replicas.encryption }).from(schema.replicas).where(eq(schema.replicas.id, replicaId))
    ).resolves.toMatchObject([{ encryption: "none" }]);

    const rerun = await reconcileStorageFormats({ database: db, apply: true });
    expect(rerun).toMatchObject({
      mode: "apply",
      scanned: 0,
      classified: 0,
      applied: 0,
      classificationCounts: { none: 0, "benzene-encrypted-object-v1": 0 },
      reasonCounts: {
        missing_metadata: 0,
        owner_mismatch: 0,
        metadata_conflict: 0,
        size_mismatch: 0,
        invalid_size: 0,
        cloud_only: 0,
        reconciled: 0,
      },
    });
  });

  it("reports owner conflicts, inconsistent hashes, and physical-size mismatches without applying them", async () => {
    await createVaultAndDevice();
    const ownerConflictHash = hash("f");
    const hashConflict = hash("g");
    const mismatchHash = hash("h");
    const encryptedHashConflict = hash("k");
    const duplicateInterpretation = hash("l");
    const encryptedSizeMismatch = hash("p");
    const logicalHashOnly = hash("q");
    await unknownReplica(ownerConflictHash, 12);
    await unknownReplica(hashConflict, 12);
    await unknownReplica(mismatchHash, 11);
    await unknownReplica(encryptedHashConflict, 28);
    await unknownReplica(duplicateInterpretation, 28);
    await unknownReplica(encryptedSizeMismatch, 29);
    await unknownReplica(logicalHashOnly, 12);

    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash: ownerConflictHash, sha256: ownerConflictHash, bytes: 12, ownerId: OTHER_OWNER });
    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash: hashConflict, sha256: hash("i"), bytes: 12 });
    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash: mismatchHash, sha256: mismatchHash, bytes: 12 });
    await version({
      nodeId: new mongoose.Types.ObjectId(),
      objectHash: encryptedHashConflict,
      sha256: encryptedHashConflict,
      bytes: 12,
      storageBytes: 28,
      storageFormat: "benzene-encrypted-object-v1",
      encryptedObject: encryptedMetadata(hash("m")),
    });
    await version({
      nodeId: new mongoose.Types.ObjectId(),
      objectHash: encryptedSizeMismatch,
      sha256: encryptedSizeMismatch,
      bytes: 12,
      storageBytes: 28,
      storageFormat: "benzene-encrypted-object-v1",
      encryptedObject: encryptedMetadata(encryptedSizeMismatch),
    });
    await version({ nodeId: new mongoose.Types.ObjectId(), objectHash: duplicateInterpretation, sha256: duplicateInterpretation, bytes: 28 });
    await version({
      nodeId: new mongoose.Types.ObjectId(),
      objectHash: duplicateInterpretation,
      sha256: duplicateInterpretation,
      bytes: 12,
      storageBytes: 28,
      storageFormat: "benzene-encrypted-object-v1",
      encryptedObject: encryptedMetadata(duplicateInterpretation),
    });
    await version({
      nodeId: new mongoose.Types.ObjectId(),
      objectHash: hash("r"),
      sha256: logicalHashOnly,
      bytes: 12,
      ownerId: OTHER_OWNER,
    });

    const report = await reconcileStorageFormats({ database: db, apply: true });
    expect(report).toMatchObject({
      classified: 0,
      applied: 0,
      skipped: 7,
      reasonCounts: {
        missing_metadata: 1,
        owner_mismatch: 1,
        metadata_conflict: 3,
        size_mismatch: 2,
        invalid_size: 0,
        cloud_only: 0,
        reconciled: 0,
      },
    });
    expect(report.rows.map((row) => row.reason)).toEqual(expect.arrayContaining([
      "owner_mismatch",
      "metadata_conflict",
      "size_mismatch",
    ]));
    const rows = await db.select({ encryption: schema.replicas.encryption }).from(schema.replicas);
    expect(rows.every((row) => row.encryption === "unknown")).toBe(true);
  });
});
