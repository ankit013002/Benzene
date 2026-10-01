import { createHash } from "node:crypto";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import type { Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config/env.js";
import * as schema from "../db/schema.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../test/postgres.js";
import { generateDeviceKeyPair } from "../modules/devices/deviceIdentity.js";
import {
  approveEnrollment,
  recordHeartbeat,
  requestEnrollment,
} from "../modules/devices/devices.service.js";
import { confirmReplicaForDevice } from "../modules/placement/placement.service.js";
import { planDownload } from "../modules/placement/uploadTargets.service.js";
import { ensureVaultForOwner } from "../modules/vaults/vaults.service.js";
import { GRANT_TEST_PRIVATE_KEY } from "../modules/placement/grantVectors.js";
import DriveNodeModel from "../models/driveNode.model.js";
import FileVersionModel from "../models/fileVersion.model.js";

const OWNER = "device-upload-owner";
const OTHER_OWNER = "other-device-upload-owner";

let mongo: MongoMemoryServer;
let db: NodePgDatabase<typeof schema>;
let app: Express;

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function deviceFor(ownerId: string): Promise<{ id: string }> {
  const keys = generateDeviceKeyPair();
  const enrollment = await requestEnrollment({
    publicKey: keys.publicKey,
    deviceName: "Device upload test node",
    platform: "linux",
  });
  const device = await approveEnrollment(ownerId, enrollment.code, 100 * 1024 * 1024);
  await recordHeartbeat(device.id, { advertisedUrl: "http://192.168.1.10:7070" });
  return { id: device.id };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env["MONGOOSE_URI"] = mongo.getUri();
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["TRANSFER_SIGNING_KEY"] = GRANT_TEST_PRIVATE_KEY;
  resetConfigCache();
  db = await setupTestDb();
  await mongoose.connect(mongo.getUri());
  await Promise.all([DriveNodeModel.init(), FileVersionModel.init()]);
  const { createApp } = await import("../app.js");
  app = createApp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await teardownTestDb();
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await Promise.all([DriveNodeModel.deleteMany({}), FileVersionModel.deleteMany({})]);
  await truncateAll(db);
});

describe("device-primary upload metadata", () => {
  it("reserves pending metadata without creating a legacy storage object", async () => {
    await deviceFor(OWNER);
    const objectHash = hashOf("device bytes");

    const response = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({
        name: "photo.jpg",
        path: "photos/2026",
        size: 12,
        contentType: "image/jpeg",
        sha256: objectHash,
      })
      .expect(201);

    const reservation = response.body.data;
    const version = await FileVersionModel.findById(reservation.versionId).lean();
    expect(version).toMatchObject({
      ownerId: OWNER,
      objectHash,
      sha256: objectHash,
      status: "pending",
      isCurrent: false,
    });
    expect(version?.storage).toBeUndefined();
  });

  it("reserves encrypted v1 metadata with separate logical and physical identities", async () => {
    await deviceFor(OWNER);
    const vault = await ensureVaultForOwner(OWNER);
    const plaintext = "private contents";
    const storageHash = hashOf("encrypted bytes plus tag");
    const encryptedObject = {
      format: "benzene-encrypted-object" as const,
      version: 1 as const,
      payloadAlgorithm: "AES-256-GCM" as const,
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM" as const,
      vaultId: vault.id,
      objectId: hashOf(plaintext),
      storageHash,
      plaintextSize: Buffer.byteLength(plaintext),
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    };

    const response = await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({ name: "private.bin", path: "vault", encryptedObject })
      .expect(201);

    const reservation = response.body.data;
    const version = await FileVersionModel.findById(reservation.versionId).lean();
    expect(reservation).toMatchObject({
      objectId: encryptedObject.objectId,
      storageHash,
      plaintextBytes: Buffer.byteLength(plaintext),
      storageBytes: Buffer.byteLength(plaintext) + 16,
      placement: { storageHash, sizeBytes: Buffer.byteLength(plaintext) + 16 },
    });
    expect(reservation.placement.targets[0]?.url).toContain(storageHash);
    const grantPayload = JSON.parse(
      Buffer.from(reservation.placement.targets[0]!.grant.split(".")[0]!, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    expect(grantPayload).toMatchObject({
      v: 2,
      objectHash: storageHash,
      op: "put",
      encryption: "benzene-encrypted-object-v1",
    });
    expect(version).toMatchObject({
      bytes: Buffer.byteLength(plaintext),
      storageBytes: Buffer.byteLength(plaintext) + 16,
      objectHash: storageHash,
      storageFormat: "benzene-encrypted-object-v1",
      encryptedObject,
      status: "pending",
    });
    expect(version).not.toHaveProperty("ciphertext");
    const references = await db.select().from(schema.objectReferences);
    expect(references).toMatchObject([{ objectHash: storageHash }]);

    const target = reservation.placement.targets[0];
    if (!target) throw new Error("Expected an encrypted upload target");
    await confirmReplicaForDevice(target.deviceId, {
      objectHash: storageHash,
      sizeBytes: Buffer.byteLength(plaintext) + 16,
    });
    const downloads = await planDownload(OWNER, storageHash);
    const downloadPayload = JSON.parse(
      Buffer.from(downloads[0]!.grant.split(".")[0]!, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    expect(downloadPayload).toMatchObject({
      v: 2,
      op: "get",
      objectHash: storageHash,
      encryption: "benzene-encrypted-object-v1",
    });
  });

  it("copies a current device-backed plaintext version forward without mutating its source", async () => {
    const device = await deviceFor(OWNER);
    const vault = await ensureVaultForOwner(OWNER);
    const sourceHash = hashOf("original plaintext object");
    const node = await DriveNodeModel.create({
      ownerId: OWNER,
      type: "file",
      name: "archive.txt",
      nameLower: "archive.txt",
      path: "docs/",
      parentId: null,
      ancestors: [],
      bytes: Buffer.byteLength("original plaintext object"),
      contentType: "application/x-node",
      uploadedAt: new Date(),
      createdBy: OWNER,
      updatedBy: "source-owner",
    });
    const source = await FileVersionModel.create({
      nodeId: node._id,
      ownerId: OWNER,
      version: 1,
      bytes: Buffer.byteLength("original plaintext object"),
      contentType: "text/x-source-version",
      objectHash: sourceHash,
      status: "committed",
      uploadedBy: OWNER,
      isCurrent: true,
    });
    const encryptedObject = {
      format: "benzene-encrypted-object" as const,
      version: 1 as const,
      payloadAlgorithm: "AES-256-GCM" as const,
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM" as const,
      vaultId: vault.id,
      objectId: hashOf("original plaintext object"),
      storageHash: hashOf("encrypted copy of original"),
      plaintextSize: Buffer.byteLength("original plaintext object"),
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    };

    const reservation = await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({
        name: "archive.txt",
        path: "docs/",
        contentType: "application/x-request",
        encryptedObject,
        migrationSource: { versionId: source._id.toString(), objectHash: sourceHash },
      })
      .expect(201);

    const encryptedVersion = await FileVersionModel.findById(reservation.body.data.versionId).lean();
    const unchangedSource = await FileVersionModel.findById(source._id).lean();
    expect(encryptedVersion).toMatchObject({
      nodeId: node._id,
      version: 2,
      storageFormat: "benzene-encrypted-object-v1",
      status: "pending",
      isCurrent: false,
    });
    expect(unchangedSource).toMatchObject({ objectHash: sourceHash, isCurrent: true, status: "committed" });
    expect(unchangedSource?.storageFormat).toBeUndefined();
    expect(encryptedVersion?.migrationSource).toEqual({ versionId: source._id.toString(), objectHash: sourceHash });
    expect(encryptedVersion?.contentType).toBe("text/x-source-version");
    expect(await DriveNodeModel.findById(node._id).select("contentType updatedBy").lean()).toMatchObject({
      contentType: "application/x-node",
      updatedBy: "source-owner",
    });

    await confirmReplicaForDevice(device.id, {
      objectHash: encryptedObject.storageHash,
      sizeBytes: encryptedObject.plaintextSize + 16,
    });
    await request(app)
      .post("/files/uploads/device/v1/encrypted/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [reservation.body.data.versionId] })
      .expect(200);

    const retainedSource = await FileVersionModel.findById(source._id).lean();
    const promotedCopy = await FileVersionModel.findById(reservation.body.data.versionId).lean();
    expect(retainedSource).toMatchObject({ objectHash: sourceHash, isCurrent: false, status: "committed" });
    expect(promotedCopy).toMatchObject({ storageFormat: "benzene-encrypted-object-v1", isCurrent: true, status: "committed" });
    expect(await DriveNodeModel.findById(node._id).select("contentType").lean()).toMatchObject({ contentType: "text/x-source-version" });
  });

  it("rejects migration metadata whose logical hash or plaintext size differs from the source", async () => {
    await deviceFor(OWNER);
    const vault = await ensureVaultForOwner(OWNER);
    const plaintext = "source bytes";
    const sourceHash = hashOf(plaintext);
    const wrongMetadata = [
      { objectId: hashOf("different contents"), plaintextSize: Buffer.byteLength(plaintext) },
      { objectId: sourceHash, plaintextSize: Buffer.byteLength(plaintext) + 1 },
    ];

    for (const [index, mismatch] of wrongMetadata.entries()) {
      const name = `mismatch-${index}.txt`;
      const node = await DriveNodeModel.create({
        ownerId: OWNER, type: "file", name, nameLower: name, path: "", parentId: null, ancestors: [],
        bytes: Buffer.byteLength(plaintext), contentType: "text/plain", uploadedAt: new Date(),
        createdBy: OWNER, updatedBy: "source-owner",
      });
      const source = await FileVersionModel.create({
        nodeId: node._id, ownerId: OWNER, version: 1, bytes: Buffer.byteLength(plaintext), objectHash: sourceHash,
        status: "committed", uploadedBy: OWNER, isCurrent: true,
      });
      const encryptedObject = {
        format: "benzene-encrypted-object" as const,
        version: 1 as const,
        payloadAlgorithm: "AES-256-GCM" as const,
        keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM" as const,
        vaultId: vault.id,
        objectId: mismatch.objectId,
        storageHash: hashOf(`ciphertext-${index}`),
        plaintextSize: mismatch.plaintextSize,
        payloadNonce: "AAAAAAAAAAAAAAAA",
        wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
        wrappedKeyCiphertext: "C".repeat(64),
      };

      await request(app)
        .post("/files/uploads/device/v1/encrypted")
        .set("X-User-Id", OWNER)
        .send({
          name,
          path: "unrelated/nested/",
          contentType: "application/x-changed",
          encryptedObject,
          migrationSource: { versionId: source._id.toString(), objectHash: sourceHash },
        })
        .expect(409);
      expect(await FileVersionModel.countDocuments({ nodeId: node._id })).toBe(1);
      expect(await DriveNodeModel.findById(node._id).select("path contentType updatedBy").lean()).toMatchObject({
        path: "",
        contentType: "text/plain",
        updatedBy: "source-owner",
      });
      expect(await DriveNodeModel.countDocuments({ type: "folder" })).toBe(0);
    }
  });

  it("supports source identity from sha256 when a legacy version lacks objectHash", async () => {
    await deviceFor(OWNER);
    const vault = await ensureVaultForOwner(OWNER);
    const plaintext = "sha-only legacy object";
    const sourceHash = hashOf(plaintext);
    const node = await DriveNodeModel.create({
      ownerId: OWNER, type: "file", name: "sha-only.txt", nameLower: "sha-only.txt", path: "", parentId: null,
      ancestors: [], bytes: Buffer.byteLength(plaintext), uploadedAt: new Date(), createdBy: OWNER, updatedBy: OWNER,
    });
    const source = await FileVersionModel.create({
      nodeId: node._id, ownerId: OWNER, version: 1, bytes: Buffer.byteLength(plaintext), sha256: sourceHash,
      status: "committed", uploadedBy: OWNER, isCurrent: true,
    });
    const encryptedObject = {
      format: "benzene-encrypted-object" as const,
      version: 1 as const,
      payloadAlgorithm: "AES-256-GCM" as const,
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM" as const,
      vaultId: vault.id,
      objectId: sourceHash,
      storageHash: hashOf("sha-only encrypted object"),
      plaintextSize: Buffer.byteLength(plaintext),
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    };

    const response = await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({ name: "sha-only.txt", path: "", encryptedObject, migrationSource: { versionId: source._id.toString(), objectHash: sourceHash } })
      .expect(201);
    const created = await FileVersionModel.findById(response.body.data.versionId).lean();
    expect(created?.migrationSource).toEqual({ versionId: source._id.toString(), objectHash: sourceHash });
    expect(created?.nodeId.toString()).toBe(node._id.toString());
  });

  it("refuses to complete a migration if a newer version becomes current after reservation", async () => {
    const device = await deviceFor(OWNER);
    const vault = await ensureVaultForOwner(OWNER);
    const plaintext = "original legacy version";
    const sourceHash = hashOf(plaintext);
    const node = await DriveNodeModel.create({
      ownerId: OWNER, type: "file", name: "race.txt", nameLower: "race.txt", path: "", parentId: null, ancestors: [],
      bytes: Buffer.byteLength(plaintext), uploadedAt: new Date(), createdBy: OWNER, updatedBy: OWNER,
    });
    const source = await FileVersionModel.create({
      nodeId: node._id, ownerId: OWNER, version: 1, bytes: Buffer.byteLength(plaintext), objectHash: sourceHash,
      status: "committed", uploadedBy: OWNER, isCurrent: true,
    });
    const metadataFor = (contents: string, cipher: string) => ({
      format: "benzene-encrypted-object" as const,
      version: 1 as const,
      payloadAlgorithm: "AES-256-GCM" as const,
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM" as const,
      vaultId: vault.id,
      objectId: hashOf(contents),
      storageHash: hashOf(cipher),
      plaintextSize: Buffer.byteLength(contents),
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    });
    const migrationMetadata = metadataFor(plaintext, "migration ciphertext");
    const migrationReservation = await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({
        name: "race.txt", path: "", encryptedObject: migrationMetadata,
        migrationSource: { versionId: source._id.toString(), objectHash: sourceHash },
      })
      .expect(201);
    const migrationTarget = migrationReservation.body.data.placement.targets[0];
    await confirmReplicaForDevice(migrationTarget.deviceId, {
      objectHash: migrationMetadata.storageHash,
      sizeBytes: migrationMetadata.plaintextSize + 16,
    });

    const newerMetadata = metadataFor("newer contents", "newer ciphertext");
    const newerReservation = await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({ name: "race.txt", path: "", encryptedObject: newerMetadata })
      .expect(201);
    await confirmReplicaForDevice(device.id, {
      objectHash: newerMetadata.storageHash,
      sizeBytes: newerMetadata.plaintextSize + 16,
    });
    await request(app)
      .post("/files/uploads/device/v1/encrypted/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [newerReservation.body.data.versionId] })
      .expect(200);

    await request(app)
      .post("/files/uploads/device/v1/encrypted/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [migrationReservation.body.data.versionId] })
      .expect(409);

    const retainedSource = await FileVersionModel.findById(source._id).lean();
    const retainedMigration = await FileVersionModel.findById(migrationReservation.body.data.versionId).lean();
    const current = await FileVersionModel.findOne({ nodeId: node._id, isCurrent: true }).lean();
    expect(retainedSource).toMatchObject({ status: "committed", isCurrent: false });
    expect(retainedMigration).toMatchObject({ status: "pending", isCurrent: false });
    expect(current?._id.toString()).toBe(newerReservation.body.data.versionId);
  });

  it("rejects copy-forward when the expected plaintext source is no longer current", async () => {
    await deviceFor(OWNER);
    const vault = await ensureVaultForOwner(OWNER);
    const sourceHash = hashOf("stale plaintext object");
    const node = await DriveNodeModel.create({
      ownerId: OWNER,
      type: "file",
      name: "changed.txt",
      nameLower: "changed.txt",
      path: "",
      parentId: null,
      ancestors: [],
      bytes: 1,
      uploadedAt: new Date(),
      createdBy: OWNER,
      updatedBy: OWNER,
    });
    const source = await FileVersionModel.create({
      nodeId: node._id, ownerId: OWNER, version: 1, bytes: 1, objectHash: sourceHash,
      status: "committed", uploadedBy: OWNER, isCurrent: false,
    });
    const encryptedObject = {
      format: "benzene-encrypted-object" as const,
      version: 1 as const,
      payloadAlgorithm: "AES-256-GCM" as const,
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM" as const,
      vaultId: vault.id,
      objectId: hashOf("stale plaintext object"),
      storageHash: hashOf("encrypted stale object"),
      plaintextSize: 1,
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    };

    await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({
        name: "changed.txt",
        path: "",
        encryptedObject,
        migrationSource: { versionId: source._id.toString(), objectHash: sourceHash },
      })
      .expect(409);
    expect(await FileVersionModel.countDocuments({ nodeId: node._id })).toBe(1);
  });

  it("completes encrypted v1 using ciphertext possession and rejects ciphertext in metadata requests", async () => {
    const device = await deviceFor(OWNER);
    const vault = await ensureVaultForOwner(OWNER);
    const plaintext = "encrypted upload completion";
    const storageHash = hashOf("ciphertext object");
    const encryptedObject = {
      format: "benzene-encrypted-object" as const,
      version: 1 as const,
      payloadAlgorithm: "AES-256-GCM" as const,
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM" as const,
      vaultId: vault.id,
      objectId: hashOf(plaintext),
      storageHash,
      plaintextSize: Buffer.byteLength(plaintext),
      payloadNonce: "AAAAAAAAAAAAAAAA",
      wrappedKeyNonce: "BBBBBBBBBBBBBBBB",
      wrappedKeyCiphertext: "C".repeat(64),
    };
    await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({ name: "bad.bin", encryptedObject, ciphertext: "must not persist" })
      .expect(400);
    const reserved = await request(app)
      .post("/files/uploads/device/v1/encrypted")
      .set("X-User-Id", OWNER)
      .send({ name: "done.bin", encryptedObject })
      .expect(201);
    const versionId = reserved.body.data.versionId as string;

    await confirmReplicaForDevice(device.id, {
      objectHash: storageHash,
      sizeBytes: Buffer.byteLength(plaintext) + 16,
    });
    const completed = await request(app)
      .post("/files/uploads/device/v1/encrypted/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [versionId] })
      .expect(200);

    expect(completed.body.data.completed[0]).toMatchObject({
      versionId,
      objectId: encryptedObject.objectId,
      storageHash,
      plaintextBytes: Buffer.byteLength(plaintext),
      storageBytes: Buffer.byteLength(plaintext) + 16,
    });
    const metadata = await request(app)
      .get(`/files/${reserved.body.data.nodeId}/encrypted-object`)
      .set("X-User-Id", OWNER)
      .expect(200);
    expect(metadata.body.data.encryptedObject).toEqual(encryptedObject);
    expect(metadata.body.data).not.toHaveProperty("ciphertext");
  });

  it("does not commit a device upload until a healthy replica exists", async () => {
    const device = await deviceFor(OWNER);
    const objectHash = hashOf("pending until possessed");
    const reserved = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({ name: "pending.bin", path: "", size: 22, sha256: objectHash })
      .expect(201);

    const versionId = reserved.body.data.versionId as string;
    const failed = await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [versionId] })
      .expect(409);

    expect(failed.body.code).toBe("NO_HEALTHY_REPLICA");
    expect(failed.body.details.protection.healthyReplicas).toBe(0);
    const stillPending = await FileVersionModel.findById(versionId).lean();
    expect(stillPending).toMatchObject({ status: "pending", isCurrent: false });

    await confirmReplicaForDevice(device.id, { objectHash, sizeBytes: 22 });
    const completed = await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [versionId] })
      .expect(200);

    expect(completed.body.data.completed[0]).toMatchObject({
      versionId,
      objectHash,
      bytes: 22,
      protection: {
        healthyReplicas: 1,
        reachableHealthyReplicas: 1,
        state: "at_risk",
        availability: "available",
      },
    });
    const listing = await request(app)
      .get("/files")
      .set("X-User-Id", OWNER)
      .expect(200);
    expect(listing.body.data.files[0]).toMatchObject({
      objectHash,
      hasContent: true,
      protection: {
        healthyReplicas: 1,
        reachableHealthyReplicas: 1,
        availability: "available",
      },
    });
  });

  it("keeps device-backed versions and completion isolated by owner", async () => {
    await deviceFor(OWNER);
    const objectHash = hashOf("private device bytes");
    const reserved = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({ name: "private.bin", path: "", size: 19, sha256: objectHash })
      .expect(201);

    const versionId = reserved.body.data.versionId as string;
    await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OTHER_OWNER)
      .send({ versionIds: [versionId] })
      .expect(404);

    expect((await request(app).get("/files").set("X-User-Id", OTHER_OWNER)).body.data.files)
      .toEqual([]);
    expect((await FileVersionModel.findById(versionId).lean())?.status).toBe("pending");
  });

  it("purges device metadata without trying to delete an absent legacy key", async () => {
    const device = await deviceFor(OWNER);
    const objectHash = hashOf("bytes retained on device");
    const reserved = await request(app)
      .post("/files/uploads/device")
      .set("X-User-Id", OWNER)
      .send({ name: "retained.bin", path: "", size: 24, sha256: objectHash })
      .expect(201);
    const versionId = reserved.body.data.versionId as string;
    await confirmReplicaForDevice(device.id, { objectHash, sizeBytes: 24 });
    await request(app)
      .post("/files/uploads/device/complete")
      .set("X-User-Id", OWNER)
      .send({ versionIds: [versionId] })
      .expect(200);

    const nodeId = reserved.body.data.nodeId as string;
    const deleted = await request(app)
      .delete(`/drive-nodes/${nodeId}?purge=true`)
      .set("X-User-Id", OWNER)
      .expect(200);

    expect(deleted.body.data).toMatchObject({ deletedNodes: 1, purgedObjects: 0 });
    expect(await FileVersionModel.exists({ _id: versionId })).toBeNull();
  });
});
