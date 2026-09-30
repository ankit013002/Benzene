import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import { deleteAccountVaultMetadata } from "./vaultMetadata.service.js";

const OWNER = "account-vault-metadata-owner";
const SECRET = "account-vault-metadata-test-secret-at-least-32-bytes";

let db: NodePgDatabase<typeof schema>;
let mongo: MongoMemoryServer;
let app: import("express").Express;

async function createVault(ownerId = OWNER): Promise<string> {
  const [vault] = await db
    .insert(schema.vaults)
    .values({ ownerId, name: "Deletion test vault" })
    .returning({ id: schema.vaults.id });
  if (!vault) throw new Error("Expected vault fixture");
  return vault.id;
}

async function createDevice(vaultId: string, status: string): Promise<string> {
  const [device] = await db
    .insert(schema.devices)
    .values({
      vaultId,
      name: "Retired account device",
      publicKey: `account-deletion-key-${crypto.randomUUID()}`,
      status,
    })
    .returning({ id: schema.devices.id });
  if (!device) throw new Error("Expected device fixture");
  return device.id;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] = mongo.getUri();
  process.env["ACCOUNT_DELETION_INTERNAL_SECRET"] = SECRET;
  resetConfigCache();
  db = await setupTestDb();
  await mongoose.connect(mongo.getUri());
  await FileVersionModel.init();
  const { createApp } = await import("../../app.js");
  app = createApp();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  await teardownTestDb();
  delete process.env["ACCOUNT_DELETION_INTERNAL_SECRET"];
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  await FileVersionModel.deleteMany({});
  await truncateAll(db);
});

describe("account Vault-metadata cleanup", () => {
  it("fails closed while legacy versions, references, replicas, or unremoved devices remain", async () => {
    const vaultId = await createVault();
    const deviceId = await createDevice(vaultId, "online");
    await db.insert(schema.deviceStorageAllocations).values({ deviceId });
    await db.insert(schema.storagePolicies).values({ vaultId });

    await FileVersionModel.create({
      nodeId: new mongoose.Types.ObjectId(),
      ownerId: OWNER,
      version: 1,
      bytes: 10,
      status: "committed",
      uploadedBy: OWNER,
      isCurrent: true,
    });
    await expect(deleteAccountVaultMetadata(OWNER)).resolves.toMatchObject({
      complete: false,
      reason: "stored_objects_remain",
    });
    await FileVersionModel.deleteMany({ ownerId: OWNER });

    await db.insert(schema.objectReferences).values({
      versionId: "retained-reference",
      vaultId,
      objectHash: "a".repeat(64),
    });
    await db.update(schema.devices).set({ status: "removed" }).where(
      eq(schema.devices.id, deviceId),
    );
    await expect(deleteAccountVaultMetadata(OWNER)).resolves.toMatchObject({
      complete: false,
      reason: "references_remain",
    });
    await db.delete(schema.objectReferences);

    await db.insert(schema.replicas).values({
      vaultId,
      objectHash: "b".repeat(64),
      deviceId,
      sizeBytes: 10,
      status: "deleting",
    });
    await expect(deleteAccountVaultMetadata(OWNER)).resolves.toMatchObject({
      complete: false,
      reason: "replicas_remain",
    });
    await db.delete(schema.replicas);

    await db.update(schema.devices).set({ status: "online" }).where(
      eq(schema.devices.id, deviceId),
    );
    await expect(deleteAccountVaultMetadata(OWNER)).resolves.toMatchObject({
      complete: false,
      reason: "devices_not_removed",
    });
    expect(await db.select().from(schema.vaults)).toHaveLength(1);
  });

  it("authenticates the idempotent handler and cascades safe Vault metadata", async () => {
    const vaultId = await createVault();
    const deviceId = await createDevice(vaultId, "removed");
    await db.insert(schema.deviceStorageAllocations).values({ deviceId });
    await db.insert(schema.storagePolicies).values({ vaultId });
    await db.insert(schema.deviceEnrollments).values({
      code: "SAFE-DELETE",
      publicKey: "safe-deletion-enrollment-key",
      deviceName: "Old pending enrollment",
      status: "expired",
      vaultId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const endpoint = `/internal/account-deletion/${encodeURIComponent(OWNER)}/vault-metadata`;
    await request(app).post(endpoint).expect(401);
    const first = await request(app)
      .post(endpoint)
      .set("X-Benzene-Internal-Secret", SECRET)
      .expect(200);
    expect(first.body).toEqual({ complete: true, deletedVaults: 1 });

    expect(await db.select().from(schema.vaults)).toHaveLength(0);
    expect(await db.select().from(schema.devices)).toHaveLength(0);
    expect(await db.select().from(schema.deviceStorageAllocations)).toHaveLength(0);
    expect(await db.select().from(schema.storagePolicies)).toHaveLength(0);
    expect(await db.select().from(schema.deviceEnrollments)).toHaveLength(0);

    await expect(deleteAccountVaultMetadata(OWNER)).resolves.toEqual({
      complete: true,
      deletedVaults: 0,
    });
  });

  it("keeps a Vault while a live relay ticket is still usable", async () => {
    const vaultId = await createVault();
    const deviceId = await createDevice(vaultId, "removed");
    await db.insert(schema.relayReadAssignments).values({
      vaultId,
      requestId: crypto.randomUUID(),
      objectHash: "c".repeat(64),
      sizeBytes: 10,
      deviceId,
      sessionId: crypto.randomUUID(),
      clientTicket: "client-ticket",
      nodeTicket: "node-ticket",
      status: "claimed",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(deleteAccountVaultMetadata(OWNER)).resolves.toMatchObject({
      complete: false,
      reason: "relay_reads_active",
    });
    expect(await db.select().from(schema.vaults)).toHaveLength(1);
  });

  it("does not report complete for legacy Mongo metadata when the Vault row is already absent", async () => {
    await FileVersionModel.create({
      nodeId: new mongoose.Types.ObjectId(),
      ownerId: "orphaned-vault-owner",
      version: 1,
      bytes: 10,
      status: "committed",
      uploadedBy: "orphaned-vault-owner",
      isCurrent: true,
    });

    await expect(deleteAccountVaultMetadata("orphaned-vault-owner")).resolves.toMatchObject({
      complete: false,
      reason: "stored_objects_remain",
    });
  });
});
