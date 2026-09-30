import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { eq } from "drizzle-orm";
import WebSocket from "ws";

import { resetConfigCache } from "../src/config/env.js";
import { db as getDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { createApp } from "../src/app.js";
import DriveNodeModel from "../src/models/driveNode.model.js";
import FileVersionModel from "../src/models/fileVersion.model.js";
import { setupTestDb, teardownTestDb, truncateAll } from "../src/test/postgres.js";
import { approveEnrollment, recordHeartbeat, requestEnrollment } from "../src/modules/devices/devices.service.js";
import { generateDeviceKeyPair } from "../src/modules/devices/deviceIdentity.js";
import { GRANT_TEST_PRIVATE_KEY } from "../src/modules/placement/grantVectors.js";
import { confirmReplica, reservePlacement } from "../src/modules/placement/placement.service.js";
import { RELAY_SCOPE_VECTOR } from "../src/modules/placement/relayScopeVectors.js";
import { ControlPlaneClient } from "../../benzene-node-agent/src/controlPlane.js";
import { ObjectStore } from "../../benzene-node-agent/src/store.js";
import { sendStoredRelayObject } from "../../benzene-node-agent/src/relayTransport.js";
import { createRelayServer } from "../../benzene-relay-service/src/relayServer.js";
import { encryptObjectWithRandomValues, decryptObject } from "../../benzene-mobile/src/crypto/encryptedObjectCore.js";
import { receiveRelayCiphertext, type RelaySocketLike } from "../../benzene-mobile/src/files/relayCiphertext.js";

const OWNER = "relay-vertical-acceptance";
const VMK = new Uint8Array(32).fill(0x4b);
const PLAINTEXT = new TextEncoder().encode("Benzene encrypted relay acceptance · 2026");

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
  let testDb: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let mongoConnected = false;
  let relay: ReturnType<typeof createRelayServer> | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;
  let objectRoot: string | undefined;
  let assertions = 0;
  const check = (condition: unknown, message: string): void => {
    assert.ok(condition, message);
    assertions += 1;
    process.stdout.write(`ok ${assertions} - ${message}\n`);
  };

  try {
    process.env["DATABASE_URL"] ??= process.env["TEST_DATABASE_URL"] ?? "";
    process.env["MONGOOSE_URI"] = mongo.getUri();
    process.env["TRANSFER_SIGNING_KEY"] = GRANT_TEST_PRIVATE_KEY;
    process.env["RELAY_PUBLIC_URL"] = "wss://127.0.0.1:8090";
    resetConfigCache();
    testDb = await setupTestDb();
    await mongoose.connect(mongo.getUri());
    mongoConnected = true;
    await FileVersionModel.init();
    await DriveNodeModel.init();

    const app = createApp();
    httpServer = createServer(app);
    await new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(0, "127.0.0.1", resolve);
    });
    const controlPlaneAddress = httpServer.address();
    if (!controlPlaneAddress || typeof controlPlaneAddress === "string") throw new Error("Control plane did not bind a local port");
    const controlPlaneUrl = `http://127.0.0.1:${controlPlaneAddress.port}`;

    const signing = generateDeviceKeyPair();
    const enrollment = await requestEnrollment({ publicKey: signing.publicKey, deviceName: "relay-vertical-node", platform: "linux" });
    const device = await approveEnrollment(OWNER, enrollment.code, 1024 * 1024 * 1024);
    await recordHeartbeat(device.id, { advertisedUrl: "http://127.0.0.1:7070", usedBytes: 0 });

    const encrypted = await encryptObjectWithRandomValues(PLAINTEXT, VMK, "relay-acceptance-vault", async (length) => new Uint8Array(length).fill(length));
    const storageHash = encrypted.metadata.storageHash;
    const ciphertext = Buffer.from(encrypted.ciphertext);
    const node = await DriveNodeModel.create({
      ownerId: OWNER,
      type: "file",
      name: "relay-acceptance.txt",
      path: "",
      bytes: PLAINTEXT.byteLength,
      versionsCount: 1,
      isDeleted: false,
    });
    const versionId = new Types.ObjectId();
    await FileVersionModel.create({
      _id: versionId,
      nodeId: node._id,
      ownerId: OWNER,
      version: 1,
      bytes: PLAINTEXT.byteLength,
      objectHash: storageHash,
      storageFormat: "benzene-encrypted-object-v1",
      storageBytes: ciphertext.byteLength,
      encryptedObject: encrypted.metadata,
      status: "committed",
      uploadedBy: OWNER,
      isCurrent: true,
    });
    const [vault] = await getDb().select().from(schema.vaults).where(eq(schema.vaults.ownerId, OWNER)).limit(1);
    if (!vault) throw new Error("Enrollment did not create the owner's Vault");
    await getDb().insert(schema.objectReferences).values({ versionId: versionId.toString(), vaultId: vault.id, objectHash: storageHash });
    await reservePlacement(OWNER, {
      objectHash: storageHash,
      sizeBytes: ciphertext.byteLength,
      deviceIds: [device.id],
      encryption: "benzene-encrypted-object-v1",
    });
    await confirmReplica(OWNER, { objectHash: storageHash, deviceId: device.id, sizeBytes: ciphertext.byteLength });

    objectRoot = await mkdtemp(path.join(tmpdir(), "benzene-relay-vertical-"));
    const store = new ObjectStore({ rootDir: objectRoot, allocatedBytes: 1024 * 1024 });
    await store.load();
    await store.put(Readable.from([ciphertext]), {
      expectedHash: storageHash,
      expectedSize: ciphertext.byteLength,
      encryption: "benzene-encrypted-object-v1",
    });
    check(await store.verify(storageHash), "node object store verifies the locally encrypted object before relay");

    const pool = testDb.$client;
    const migration = await import("node:fs/promises").then(({ readFile }) => readFile("../benzene-relay-service/migrations/001_relay_sessions.sql", "utf8"));
    await pool.query(migration);
    relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      publicKey: RELAY_SCOPE_VECTOR.publicKey,
      instanceId: "local-vertical-acceptance",
      maxSessions: 4,
      maxFrameBytes: 64 * 1024,
      idleTimeoutMs: 5_000,
      authTimeoutMs: 2_000,
      pool,
    });
    await relay.listen();
    const relayAddress = relay.server.address();
    if (!relayAddress || typeof relayAddress === "string") throw new Error("Relay did not bind a local port");
    const insecureLocalRelayUrl = `ws://127.0.0.1:${relayAddress.port}`;
    process.env["RELAY_PUBLIC_URL"] = `wss://127.0.0.1:${relayAddress.port}`;
    resetConfigCache();

    const requestId = "8b5bbd4c-9eef-4b21-8a0b-b8337b1bf227";
    const fallbackResponse = await fetch(`${controlPlaneUrl}/placement/relay-read`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": OWNER },
      body: JSON.stringify({ nodeId: node.id, requestId }),
    });
    check(fallbackResponse.status === 201, "authorized control-plane route creates a relay read assignment for a referenced encrypted version");
    const fallbackPayload = await fallbackResponse.json() as { data: {
      kind: string; relayUrl: string; sessionId: string; ticket: string; storageHash: string; ciphertextBytes: number; expiresAt: string;
    } };
    const fallback = fallbackPayload.data;
    check(fallback.kind === "relay_fallback" && fallback.storageHash === storageHash && fallback.ciphertextBytes === ciphertext.byteLength, "control plane returns only a client capability bound to the exact ciphertext");
    check(!("nodeTicket" in fallback), "client response does not reveal the complementary node ticket");
    check(fallback.relayUrl === `wss://127.0.0.1:${relayAddress.port}`, "assignment advertises the configured secure relay origin");

    const controlPlaneClient = new ControlPlaneClient(controlPlaneUrl);
    const assignment = await controlPlaneClient.pollRelayRead({ deviceId: device.id, privateKey: signing.privateKey });
    check(assignment !== null && assignment.storageHash === storageHash && assignment.sizeBytes === ciphertext.byteLength, "node claims its relay assignment through the signed /agent route");
    if (!assignment) throw new Error("The enrolled source did not receive its relay assignment");
    check(assignment.sessionId === fallback.sessionId && assignment.nodeTicket.length > 0, "signed node claim receives the matching private node ticket");

    const socketFactory = (url: string) => {
      const localUrl = url.replace(/^wss:/, "ws:");
      return new WebSocket(localUrl) as unknown as RelaySocketLike;
    };
    const receive = receiveRelayCiphertext({
      fallback,
      expectedStorageHash: storageHash,
      expectedCiphertextBytes: ciphertext.byteLength,
      timeoutMs: 10_000,
    }, socketFactory);
    const send = sendStoredRelayObject({
      relayUrl: insecureLocalRelayUrl,
      ticket: assignment.nodeTicket,
      controlPlanePublicKey: RELAY_SCOPE_VECTOR.publicKey,
      store,
      deviceId: device.id,
      storageHash,
      sizeBytes: ciphertext.byteLength,
      allowInsecureLocalhost: true,
    });
    const [receivedCiphertext, sent] = await Promise.all([receive, send]);
    check(Buffer.from(receivedCiphertext).equals(ciphertext), "mobile receive implementation gets byte-identical opaque ciphertext from the real relay server");
    check(sent.storageHash === storageHash && sent.sizeBytes === ciphertext.byteLength, "node producer verifies the signed exact hash and byte ceiling after streaming");
    const recoveredPlaintext = decryptObject(encrypted.metadata, receivedCiphertext, VMK);
    check(Buffer.from(recoveredPlaintext).equals(Buffer.from(PLAINTEXT)), "mobile encrypted-object implementation authenticates and decrypts the relayed ciphertext");

    const completed = await controlPlaneClient.completeRelayRead({
      deviceId: device.id,
      privateKey: signing.privateKey,
      assignmentId: assignment.assignmentId,
      outcome: "sent",
    });
    check(completed.status === "completed", "node reports successful relay completion through its signed control-plane route");
    process.stdout.write(`Relay vertical acceptance passed (${assertions} checks). Local WebSocket downgrade is test-only; no public WSS deployment was exercised.\n`);
  } finally {
    await relay?.close();
    if (httpServer?.listening) await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    if (mongoConnected) await mongoose.disconnect();
    if (testDb) {
      await FileVersionModel.deleteMany({});
      await DriveNodeModel.deleteMany({});
      await truncateAll(testDb);
      await teardownTestDb();
    }
    if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
    await mongo.stop();
    delete process.env["TRANSFER_SIGNING_KEY"];
    delete process.env["RELAY_PUBLIC_URL"];
    resetConfigCache();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
