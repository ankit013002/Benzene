import { createPublicKey, verify } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../config/env.js";
import * as schema from "../../db/schema.js";
import { db as getDb } from "../../db/client.js";
import DriveNodeModel from "../../models/driveNode.model.js";
import FileVersionModel from "../../models/fileVersion.model.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../../test/postgres.js";
import {
  approveEnrollment,
  recordHeartbeat,
  requestEnrollment,
} from "../devices/devices.service.js";
import { generateDeviceKeyPair } from "../devices/deviceIdentity.js";
import { GRANT_TEST_PRIVATE_KEY } from "./grantVectors.js";
import { claimRelayReadForDevice, completeRelayReadForDevice, createRelayReadFallback } from "./relayRead.service.js";
import { RELAY_SCOPE_VECTOR } from "./relayScopeVectors.js";
import { confirmReplica, reservePlacement } from "./placement.service.js";

const OWNER = "relay-read-owner";
const CIPHERTEXT_BYTES = 32;
const STORAGE_HASH = "a".repeat(64);
const TEST_PUBLIC_KEY = RELAY_SCOPE_VECTOR.publicKey;

let db: NodePgDatabase<typeof schema> | undefined;
let mongo: MongoMemoryServer | undefined;

function scopeOf(ticket: string): Record<string, unknown> {
  const encoded = ticket.split(".")[0] ?? "";
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}

function ticketVerifies(ticket: string): boolean {
  const [encoded, signature] = ticket.split(".") as [string, string];
  return verify(
    null,
    Buffer.from(encoded, "utf8"),
    createPublicKey({ key: Buffer.from(TEST_PUBLIC_KEY, "base64"), format: "der", type: "spki" }),
    Buffer.from(signature, "base64url")
  );
}

async function onlineDevice(name: string): Promise<string> {
  const enrollment = await requestEnrollment({
    publicKey: generateDeviceKeyPair().publicKey,
    deviceName: name,
    platform: "linux",
  });
  const device = await approveEnrollment(OWNER, enrollment.code, 1024 * 1024 * 1024);
  await recordHeartbeat(device.id, { advertisedUrl: "http://192.168.1.10:7070", usedBytes: 0 });
  return device.id;
}

async function encryptedFile(): Promise<{ nodeId: string; versionId: string }> {
  const node = await DriveNodeModel.create({
    ownerId: OWNER,
    type: "file",
    name: "secret.bin",
    path: "",
    bytes: 16,
    versionsCount: 1,
    isDeleted: false,
  });
  const versionId = new Types.ObjectId();
  await FileVersionModel.create({
    _id: versionId,
    nodeId: node._id,
    ownerId: OWNER,
    version: 1,
    bytes: 16,
    objectHash: STORAGE_HASH,
    storageFormat: "benzene-encrypted-object-v1",
    storageBytes: CIPHERTEXT_BYTES,
    encryptedObject: {
      format: "benzene-encrypted-object",
      version: 1,
      payloadAlgorithm: "AES-256-GCM",
      keyWrapAlgorithm: "HKDF-SHA-256+AES-256-GCM",
      vaultId: "test-vault",
      objectId: "b".repeat(64),
      storageHash: STORAGE_HASH,
      plaintextSize: CIPHERTEXT_BYTES - 16,
      payloadNonce: Buffer.alloc(12).toString("base64url"),
      wrappedKeyNonce: Buffer.alloc(12).toString("base64url"),
      wrappedKeyCiphertext: Buffer.alloc(48).toString("base64url"),
    },
    status: "committed",
    uploadedBy: OWNER,
    isCurrent: true,
  });
  return { nodeId: node.id, versionId: versionId.toString() };
}

async function referencedReplica(): Promise<{ nodeId: string; deviceId: string }> {
  const deviceId = await onlineDevice("relay-source");
  const { nodeId, versionId } = await encryptedFile();
  const [vault] = await getDb().select().from(schema.vaults)
    .where(eq(schema.vaults.ownerId, OWNER)).limit(1);
  if (!vault) throw new Error("Expected enrolled owner vault");
  await getDb().insert(schema.objectReferences).values({
    versionId,
    vaultId: vault.id,
    objectHash: STORAGE_HASH,
  });
  await reservePlacement(OWNER, {
    objectHash: STORAGE_HASH,
    sizeBytes: CIPHERTEXT_BYTES,
    deviceIds: [deviceId],
    encryption: "benzene-encrypted-object-v1",
  });
  await confirmReplica(OWNER, { objectHash: STORAGE_HASH, deviceId, sizeBytes: CIPHERTEXT_BYTES });
  return { nodeId, deviceId };
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
  process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
  process.env["MONGOOSE_URI"] = mongo.getUri();
  process.env["TRANSFER_SIGNING_KEY"] = GRANT_TEST_PRIVATE_KEY;
  process.env["RELAY_PUBLIC_URL"] = "wss://relay.example.test";
  resetConfigCache();
  db = await setupTestDb();
  await mongoose.connect(mongo.getUri());
  await FileVersionModel.init();
  await DriveNodeModel.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (db) await teardownTestDb();
  delete process.env["TRANSFER_SIGNING_KEY"];
  delete process.env["RELAY_PUBLIC_URL"];
  resetConfigCache();
}, 60_000);

afterEach(async () => {
  if (!db) return;
  await FileVersionModel.deleteMany({});
  await DriveNodeModel.deleteMany({});
  await truncateAll(db);
});

describe("encrypted GET relay fallback assignments", () => {
  it("issues only the client ticket and privately delivers the complementary node ticket to its signed target", async () => {
    const { nodeId, deviceId: target } = await referencedReplica();
    const other = await onlineDevice("other-node");

    const requestId = "55555555-5555-4555-8555-555555555555";
    const client = await createRelayReadFallback(OWNER, { nodeId, requestId });
    expect(client).toMatchObject({
      kind: "relay_fallback",
      relayUrl: "wss://relay.example.test",
      storageHash: STORAGE_HASH,
      ciphertextBytes: CIPHERTEXT_BYTES,
    });
    expect(client).not.toHaveProperty("nodeTicket");
    expect(client).not.toHaveProperty("clientTicket");
    expect(ticketVerifies(client.ticket)).toBe(true);
    const clientScope = scopeOf(client.ticket);
    expect(clientScope).toMatchObject({
      sessionId: client.sessionId,
      storageHash: STORAGE_HASH,
      deviceId: target,
      op: "get",
      role: "client",
      maxBytes: CIPHERTEXT_BYTES,
    });
    expect(Date.parse(client.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(client.expiresAt)).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);

    const retry = await createRelayReadFallback(OWNER, { nodeId, requestId });
    expect(retry).toEqual(client);
    expect(await claimRelayReadForDevice(other)).toBeNull();
    const assignment = await claimRelayReadForDevice(target);
    expect(assignment).toMatchObject({
      assignmentId: expect.any(String),
      sessionId: client.sessionId,
      relayUrl: "wss://relay.example.test",
      storageHash: STORAGE_HASH,
      sizeBytes: CIPHERTEXT_BYTES,
      expiresAt: client.expiresAt,
    });
    expect(assignment).toHaveProperty("nodeTicket");
    expect(assignment?.nodeTicket).not.toBe(client.ticket);
    expect(ticketVerifies(assignment?.nodeTicket ?? "")).toBe(true);
    const nodeScope = scopeOf(assignment?.nodeTicket ?? "");
    expect(nodeScope).toMatchObject({
      sessionId: clientScope["sessionId"],
      storageHash: clientScope["storageHash"],
      deviceId: clientScope["deviceId"],
      op: "get",
      role: "node",
      exp: clientScope["exp"],
      maxBytes: clientScope["maxBytes"],
    });
    expect(nodeScope["ticketId"]).not.toBe(clientScope["ticketId"]);
    expect(await claimRelayReadForDevice(target)).toBeNull();
    if (!assignment) throw new Error("Expected the selected device to claim its assignment");

    await db.update(schema.relayReadAssignments)
      .set({ claimLeaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.relayReadAssignments.id, assignment.assignmentId));
    const retriedClaim = await claimRelayReadForDevice(target);
    expect(retriedClaim).toMatchObject({
      assignmentId: assignment.assignmentId,
      nodeTicket: assignment.nodeTicket,
      sessionId: assignment.sessionId,
    });
    expect(await claimRelayReadForDevice(target)).toBeNull();
    await expect(completeRelayReadForDevice(target, {
      assignmentId: assignment.assignmentId,
      outcome: "sent",
    })).resolves.toEqual({ status: "completed" });

    const [row] = await db.select().from(schema.relayReadAssignments)
      .where(and(eq(schema.relayReadAssignments.id, assignment.assignmentId), eq(schema.relayReadAssignments.deviceId, target)));
    expect(row?.status).toBe("completed");
    expect(row?.nodeTicket).toBe(assignment.nodeTicket);
  });

  it("bounds lease retries and requires a new request id after a failed assignment", async () => {
    const { nodeId, deviceId } = await referencedReplica();
    const requestId = "66666666-6666-4666-8666-666666666666";
    const client = await createRelayReadFallback(OWNER, { nodeId, requestId });
    const first = await claimRelayReadForDevice(deviceId);
    if (!first) throw new Error("Expected the selected device to claim its assignment");
    await expect(completeRelayReadForDevice(deviceId, {
      assignmentId: first.assignmentId,
      outcome: "failed",
    })).resolves.toEqual({ status: "retrying" });

    let latest = first;
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await db.update(schema.relayReadAssignments)
        .set({ claimLeaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.relayReadAssignments.id, first.assignmentId));
      const retried = await claimRelayReadForDevice(deviceId);
      if (!retried) throw new Error(`Expected relay claim attempt ${attempt}`);
      expect(retried.nodeTicket).toBe(first.nodeTicket);
      latest = retried;
      await expect(completeRelayReadForDevice(deviceId, {
        assignmentId: first.assignmentId,
        outcome: "failed",
      })).resolves.toEqual({ status: attempt === 3 ? "failed" : "retrying" });
    }

    const [failed] = await db.select().from(schema.relayReadAssignments)
      .where(eq(schema.relayReadAssignments.id, first.assignmentId));
    expect(failed).toMatchObject({ status: "failed", claimAttempts: 3 });
    expect(client.sessionId).toBe(latest.sessionId);
    await expect(createRelayReadFallback(OWNER, { nodeId, requestId }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a client fallback without a live online encrypted replica", async () => {
    await onlineDevice("no-replica");
    const { nodeId, versionId } = await encryptedFile();
    const [vault] = await getDb().select().from(schema.vaults)
      .where(eq(schema.vaults.ownerId, OWNER)).limit(1);
    if (!vault) throw new Error("Expected enrolled owner vault");
    await getDb().insert(schema.objectReferences).values({ versionId, vaultId: vault.id, objectHash: STORAGE_HASH });
    await expect(createRelayReadFallback(OWNER, {
      nodeId,
      requestId: "66666666-6666-4666-8666-666666666666",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
