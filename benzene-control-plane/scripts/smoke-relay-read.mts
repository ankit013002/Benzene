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
import { DriveNodeModel } from "../src/models/driveNode.model.js";
import { FileVersionModel } from "../src/models/fileVersion.model.js";
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
const PHASE_TIMEOUT_MS = 45_000;
const OVERALL_TIMEOUT_MS = 4 * 60_000;

async function phase<T>(name: string, operation: () => Promise<T>, timeoutMs = PHASE_TIMEOUT_MS): Promise<T> {
  process.stdout.write(`[relay-acceptance] start: ${name}\n`);
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`[relay-acceptance] phase timed out after ${timeoutMs}ms: ${name}`)), timeoutMs);
    });
    const result = await Promise.race([operation(), timeout]);
    process.stdout.write(`[relay-acceptance] done: ${name}\n`);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  let currentPhase = "start MongoDB memory server";
  const watchdog = setTimeout(() => {
    process.stderr.write(`[relay-acceptance] overall timeout after ${OVERALL_TIMEOUT_MS}ms; last phase: ${currentPhase}\n`);
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  watchdog.unref();
  const mongo = await phase(currentPhase, () => MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } }), 60_000);
  let testDb: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let mongoConnected = false;
  let relay: ReturnType<typeof createRelayServer> | undefined;
  let relayListening = false;
  let httpServer: ReturnType<typeof createServer> | undefined;
  let objectRoot: string | undefined;
  let assertions = 0;
  let failure: unknown;
  const cleanupErrors: Error[] = [];
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
    currentPhase = "create and migrate isolated PostgreSQL database";
    testDb = await phase(currentPhase, () => setupTestDb(), 60_000);
    currentPhase = "connect MongoDB and initialize metadata models";
    await phase(currentPhase, async () => {
      await mongoose.connect(mongo.getUri());
      mongoConnected = true;
      await FileVersionModel.init();
      await DriveNodeModel.init();
    });

    currentPhase = "start local control-plane HTTP server";
    const app = createApp();
    httpServer = createServer(app);
    await phase(currentPhase, () => new Promise<void>((resolve, reject) => {
      httpServer?.once("error", reject);
      httpServer?.listen(0, "127.0.0.1", resolve);
    }));
    const controlPlaneAddress = httpServer.address();
    if (!controlPlaneAddress || typeof controlPlaneAddress === "string") throw new Error("Control plane did not bind a local port");
    const controlPlaneUrl = `http://127.0.0.1:${controlPlaneAddress.port}`;

    currentPhase = "enroll source and create referenced encrypted version";
    const { signing, device, encrypted, node, ciphertext } = await phase(currentPhase, async () => {
      const signing = generateDeviceKeyPair();
      const enrollment = await requestEnrollment({ publicKey: signing.publicKey, deviceName: "relay-vertical-node", platform: "linux" });
      const device = await approveEnrollment(OWNER, enrollment.code, 1024 * 1024 * 1024);
      await recordHeartbeat(device.id, { advertisedUrl: "http://127.0.0.1:7070", usedBytes: 0 });
      const encrypted = await encryptObjectWithRandomValues(PLAINTEXT, VMK, "relay-acceptance-vault", async (length) => new Uint8Array(length).fill(length));
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
        objectHash: encrypted.metadata.storageHash,
        storageFormat: "benzene-encrypted-object-v1",
        storageBytes: ciphertext.byteLength,
        encryptedObject: encrypted.metadata,
        status: "committed",
        uploadedBy: OWNER,
        isCurrent: true,
      });
      const [vault] = await getDb().select().from(schema.vaults).where(eq(schema.vaults.ownerId, OWNER)).limit(1);
      if (!vault) throw new Error("Enrollment did not create the owner's Vault");
      await getDb().insert(schema.objectReferences).values({ versionId: versionId.toString(), vaultId: vault.id, objectHash: encrypted.metadata.storageHash });
      await reservePlacement(OWNER, {
        objectHash: encrypted.metadata.storageHash,
        sizeBytes: ciphertext.byteLength,
        deviceIds: [device.id],
        encryption: "benzene-encrypted-object-v1",
      });
      await confirmReplica(OWNER, { objectHash: encrypted.metadata.storageHash, deviceId: device.id, sizeBytes: ciphertext.byteLength });
      return { signing, device, encrypted, node, ciphertext };
    });
    const storageHash = encrypted.metadata.storageHash;

    currentPhase = "store ciphertext on source node";
    objectRoot = await mkdtemp(path.join(tmpdir(), "benzene-relay-vertical-"));
    const store = new ObjectStore({ rootDir: objectRoot, allocatedBytes: 1024 * 1024 });
    await phase(currentPhase, async () => {
      await store.load();
      await store.put(Readable.from([ciphertext]), {
        expectedHash: storageHash,
        expectedSize: ciphertext.byteLength,
        encryption: "benzene-encrypted-object-v1",
      });
    });
    check(await store.verify(storageHash), "node object store verifies the locally encrypted object before relay");

    const pool = testDb.$client;
    currentPhase = "initialize relay PostgreSQL state and start WebSocket server";
    await phase(currentPhase, async () => {
      const migration = await import("node:fs/promises").then(({ readFile }) => readFile("../benzene-relay-service/migrations/001_relay_sessions.sql", "utf8"));
      await pool.query(migration);
    });
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
    await phase("listen on local relay socket", () => relay?.listen() ?? Promise.reject(new Error("Relay server was not created")));
    relayListening = true;
    const relayAddress = relay.server.address();
    if (!relayAddress || typeof relayAddress === "string") throw new Error("Relay did not bind a local port");
    const insecureLocalRelayUrl = `ws://127.0.0.1:${relayAddress.port}`;
    process.env["RELAY_PUBLIC_URL"] = `wss://127.0.0.1:${relayAddress.port}`;
    resetConfigCache();

    const requestId = "8b5bbd4c-9eef-4b21-8a0b-b8337b1bf227";
    const fallbackResponse = await phase("create authorized control-plane fallback", () => fetch(`${controlPlaneUrl}/placement/relay-read`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": OWNER },
      body: JSON.stringify({ nodeId: node.id, requestId }),
      signal: AbortSignal.timeout(20_000),
    }));
    check(fallbackResponse.status === 201, "authorized control-plane route creates a relay read assignment for a referenced encrypted version");
    const fallbackPayload = await fallbackResponse.json() as { data: {
      kind: string; relayUrl: string; sessionId: string; ticket: string; storageHash: string; ciphertextBytes: number; expiresAt: string;
    } };
    const fallback = fallbackPayload.data;
    check(fallback.kind === "relay_fallback" && fallback.storageHash === storageHash && fallback.ciphertextBytes === ciphertext.byteLength, "control plane returns only a client capability bound to the exact ciphertext");
    check(!("nodeTicket" in fallback), "client response does not reveal the complementary node ticket");
    check(fallback.relayUrl === `wss://127.0.0.1:${relayAddress.port}`, "assignment advertises the configured secure relay origin");

    const controlPlaneClient = new ControlPlaneClient(controlPlaneUrl);
    currentPhase = "claim assignment through signed node route";
    const assignment = await phase(currentPhase, () => controlPlaneClient.pollRelayRead({ deviceId: device.id, privateKey: signing.privateKey }));
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
    currentPhase = "pair relay tickets, stream ciphertext and receive exact bytes";
    const [receivedCiphertext, sent] = await phase(currentPhase, () => Promise.all([receive, send]), 30_000);
    check(Buffer.from(receivedCiphertext).equals(ciphertext), "mobile receive implementation gets byte-identical opaque ciphertext from the real relay server");
    check(sent.storageHash === storageHash && sent.sizeBytes === ciphertext.byteLength, "node producer verifies the signed exact hash and byte ceiling after streaming");
    const recoveredPlaintext = decryptObject(encrypted.metadata, receivedCiphertext, VMK);
    check(Buffer.from(recoveredPlaintext).equals(Buffer.from(PLAINTEXT)), "mobile encrypted-object implementation authenticates and decrypts the relayed ciphertext");

    currentPhase = "report signed relay completion";
    const completed = await phase(currentPhase, () => controlPlaneClient.completeRelayRead({
      deviceId: device.id,
      privateKey: signing.privateKey,
      assignmentId: assignment.assignmentId,
      outcome: "sent",
    }));
    check(completed.status === "completed", "node reports successful relay completion through its signed control-plane route");
    process.stdout.write(`Relay vertical acceptance passed (${assertions} checks). Local WebSocket downgrade is test-only; no public WSS deployment was exercised.\n`);
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
      try {
        await phase(`cleanup: ${name}`, operation, 10_000);
      } catch (error) {
        const cleanupError = error instanceof Error ? error : new Error(String(error));
        cleanupErrors.push(cleanupError);
        process.stderr.write(`[relay-acceptance] ${cleanupError.message}\n`);
      }
    };
    if (relay && relayListening) await cleanup("relay server", () => relay?.close() ?? Promise.resolve());
    if (httpServer?.listening) await cleanup("control-plane server", () => new Promise<void>((resolve, reject) => {
      httpServer?.close((error) => error ? reject(error) : resolve());
    }));
    if (mongoConnected) {
      await cleanup("MongoDB fixture removal", async () => {
        await FileVersionModel.deleteMany({ ownerId: OWNER });
        await DriveNodeModel.deleteMany({ ownerId: OWNER });
      });
      await cleanup("MongoDB connection", () => mongoose.disconnect());
    }
    if (testDb) {
      await cleanup("PostgreSQL fixture truncation", () => truncateAll(testDb as NonNullable<typeof testDb>));
      await cleanup("isolated PostgreSQL database", () => teardownTestDb());
    }
    if (objectRoot) await cleanup("temporary node store", () => rm(objectRoot as string, { recursive: true, force: true }));
    await cleanup("MongoDB memory server", () => mongo.stop());
    delete process.env["TRANSFER_SIGNING_KEY"];
    delete process.env["RELAY_PUBLIC_URL"];
    resetConfigCache();
    clearTimeout(watchdog);
  }
  if (failure && cleanupErrors.length > 0) throw new AggregateError([failure, ...cleanupErrors], "Relay acceptance failed and cleanup reported additional errors");
  if (failure) throw failure;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Relay acceptance cleanup failed");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
