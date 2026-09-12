/**
 * Cross-package protection smoke test: a real three-device repair.
 *
 * The upload starts with only A and B online, so the default Protected policy
 * places exactly two copies. A then becomes suspected lost while B continues
 * heartbeating. C comes online afterwards and performs the real agent repair,
 * streaming bytes directly from B and reporting possession with its device
 * signature.
 *
 * Run from the repo root, with both packages built:
 *   node scripts/smoke-protection.mjs
 *
 * Requires a reachable PostgreSQL. Set SMOKE_DATABASE_URL to override.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

const controlPlaneRequire = createRequire(
  new URL("../benzene-control-plane/package.json", import.meta.url)
);
const agentRequire = createRequire(
  new URL("../benzene-node-agent/package.json", import.meta.url)
);

const OWNER = "auth|smoke-protection";
const ALLOCATED = 64 * 1024 * 1024;
const PORT_BASE = Number.parseInt(process.env.SMOKE_PROTECTION_PORT_BASE ?? "7271", 10);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function jsonOrNull(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function main() {
  const baseUrl =
    process.env.SMOKE_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
  const { Client } = controlPlaneRequire("pg");
  const dbName = `benzene_protection_smoke_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  await admin.end();

  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;
  const databaseUrl = dbUrl.toString();

  const { MongoMemoryServer } = controlPlaneRequire("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create();
  const storageRoot = await mkdtemp(path.join(tmpdir(), "benzene-protection-smoke-"));
  let server;
  const transferServers = [];
  const agents = [];

  try {
    // Keep the loss window short, but long enough to exercise the production
    // outage classification sequence in a deterministic way.
    process.env.DATABASE_URL = databaseUrl;
    process.env.MONGOOSE_URI = mongo.getUri();
    process.env.STORAGE_DRIVER = "local";
    process.env.DEVICE_OFFLINE_AFTER_SECONDS = "1";
    process.env.DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS = "2";
    process.env.DEVICE_SUSPECTED_LOST_AFTER_SECONDS = "3";

    const { generateTransferSigningKeys } = controlPlaneRequire(
      "./built/modules/placement/transferGrant.js"
    );
    process.env.TRANSFER_SIGNING_KEY = generateTransferSigningKeys().privateKey;
    process.env.LOCAL_STORAGE_DIR = path.join(storageRoot, "cp");

    const mongoose = controlPlaneRequire("mongoose");
    await mongoose.connect(mongo.getUri());

    const { drizzle } = controlPlaneRequire("drizzle-orm/node-postgres");
    const { migrate } = controlPlaneRequire("drizzle-orm/node-postgres/migrator");
    const { Pool } = controlPlaneRequire("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(
        new URL("../benzene-control-plane/drizzle", import.meta.url)
      ),
    });
    await pool.end();

    const { createApp } = controlPlaneRequire("./built/app.js");
    server = await listen(createApp(), 0);
    const controlPlaneUrl = `http://127.0.0.1:${server.address().port}`;
    console.log(`\ncontrol plane listening on ${controlPlaneUrl}\n`);

    const { Agent } = agentRequire("./built/agent.js");
    const { loadAgentConfig } = agentRequire("./built/config.js");
    const { ObjectStore } = agentRequire("./built/store.js");
    const { ControlPlaneClient } = agentRequire("./built/controlPlane.js");
    const { createTransferServer } = agentRequire("./built/transferServer.js");

    const makeDevice = async (name, port) => {
      const config = loadAgentConfig({
        controlPlaneUrl,
        dataDir: path.join(storageRoot, name),
        storageDir: path.join(storageRoot, name, "storage"),
        identityFile: path.join(storageRoot, name, "identity.json"),
        allocatedBytes: ALLOCATED,
        deviceName: `Protection Smoke ${name}`,
        platform: "linux",
        advertisedUrl: `http://127.0.0.1:${port}`,
        port,
        heartbeatIntervalMs: 0,
        repairIntervalMs: 0,
      });
      const store = new ObjectStore({
        rootDir: config.storageDir,
        allocatedBytes: config.allocatedBytes,
      });
      const agent = new Agent(config, store);
      await agent.initialise();
      agents.push(agent);
      return { config, store, agent, port };
    };

    const a = await makeDevice("device-a", PORT_BASE);
    const b = await makeDevice("device-b", PORT_BASE + 1);
    const c = await makeDevice("device-c", PORT_BASE + 2);

    const enroll = async (device) => {
      const result = await device.agent.ensureEnrolled();
      check(`${device.config.deviceName} received a pairing code`, Boolean(result.prompt?.code));
      let approvalStatus;
      if (result.prompt?.code) {
        const approval = await fetch(`${controlPlaneUrl}/devices/enrollments/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-User-Id": OWNER },
          body: JSON.stringify({ code: result.prompt.code, allocatedBytes: ALLOCATED }),
        });
        approvalStatus = approval.status;
      }
      check(
        `${device.config.deviceName} approval accepted`,
        approvalStatus === 201,
        `status ${approvalStatus ?? "not attempted"}`
      );
      check(
        `${device.config.deviceName} became enrolled`,
        await device.agent.pollEnrollment()
      );
      return device.agent.currentIdentity()?.deviceId;
    };

    console.log("enrollment");
    const aId = await enroll(a);
    const bId = await enroll(b);
    const cId = await enroll(c);
    check("three independent device identities exist", Boolean(aId && bId && cId));

    const startTransferServer = async (device) => {
      const identity = device.agent.currentIdentity();
      if (!identity?.deviceId || !identity.controlPlanePublicKey) return null;
      const transferServer = await listen(
        createTransferServer({
          store: device.store,
          deviceId: identity.deviceId,
          controlPlanePublicKey: identity.controlPlanePublicKey,
          reportPossession: ({ objectHash, sizeBytes }) =>
            device.agent.reportPossession(objectHash, sizeBytes),
        }),
        device.port
      );
      transferServers.push(transferServer);
      return transferServer;
    };

    // C is enrolled but deliberately does not heartbeat or serve yet. Only A
    // and B are therefore eligible for the default Protected upload.
    const aTransfer = await startTransferServer(a);
    const bTransfer = await startTransferServer(b);
    check("A transfer server started", Boolean(aTransfer));
    check("B transfer server started", Boolean(bTransfer));
    const preUploadDevicesRes = await fetch(`${controlPlaneUrl}/devices`, {
      headers: { "X-User-Id": OWNER },
    });
    const preUploadDevices = (await jsonOrNull(preUploadDevicesRes))?.data;
    const preUploadC = Array.isArray(preUploadDevices)
      ? preUploadDevices.find((device) => device.id === cId)
      : undefined;
    check("C remains offline before the upload", preUploadC?.status !== "online", preUploadC?.status);
    const aBeat = await a.agent.sendHeartbeat();
    const bBeat = await b.agent.sendHeartbeat();
    check("A is online before upload", aBeat?.status === "online", JSON.stringify(aBeat));
    check("B is online before upload", bBeat?.status === "online", JSON.stringify(bBeat));

    console.log("\nprotected upload lands on exactly A and B");
    const fileBody = Buffer.from("protection repair smoke payload");
    const objectHash = createHash("sha256").update(fileBody).digest("hex");
    const reserveRes = await fetch(`${controlPlaneUrl}/files/uploads/device`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-User-Id": OWNER },
      body: JSON.stringify({
        name: "protected.txt",
        path: "protection-smoke",
        size: fileBody.length,
        contentType: "text/plain",
        sha256: objectHash,
      }),
    });
    const reservation = (await jsonOrNull(reserveRes))?.data;
    check("protected upload reservation accepted", reserveRes.status === 201);
    const targets = Array.isArray(reservation?.placement?.targets)
      ? reservation.placement.targets
      : [];
    check("Protected upload requests exactly two targets", targets.length === 2, JSON.stringify(targets));
    check(
      "Protected upload targets A and B only",
      targets.length === 2 &&
        new Set(targets.map((target) => target.deviceId)).size === 2 &&
        targets.every((target) => target.deviceId === aId || target.deviceId === bId),
      JSON.stringify(targets.map((target) => target.deviceId))
    );

    for (const target of targets) {
      const putRes = await fetch(target.url, {
        method: "PUT",
        headers: {
          "X-Transfer-Grant": target.grant,
          "Content-Type": "application/octet-stream",
        },
        body: fileBody,
      });
      check(`device ${target.deviceId} accepted upload bytes`, putRes.status === 201);
    }
    if (reservation?.versionId) {
      const completeRes = await fetch(`${controlPlaneUrl}/files/uploads/device/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-User-Id": OWNER },
        body: JSON.stringify({ versionIds: [reservation.versionId] }),
      });
      check("protected upload committed", completeRes.status === 200, `status ${completeRes.status}`);
    } else {
      check("protected upload committed", false, "no version id returned");
    }

    const protectionBefore = await fetch(
      `${controlPlaneUrl}/placement/protection/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const before = (await jsonOrNull(protectionBefore))?.data;
    check(
      "upload starts with healthy two-copy protection",
      before?.healthyReplicas === 2 && before?.desiredReplicas === 2 && before?.state === "healthy",
      JSON.stringify(before)
    );
    check("A holds the uploaded bytes", await a.store.has(objectHash));
    check("B holds the uploaded bytes", await b.store.has(objectHash));
    check("A verifies the uploaded hash", await a.store.verify(objectHash));
    check("B verifies the uploaded hash", await b.store.verify(objectHash));

    console.log("\nA becomes suspected lost while B stays fresh");
    // Anchor the outage clock after the complete upload, so a slow CI runner
    // cannot consume the three-second classification window during setup.
    await a.agent.sendHeartbeat();
    await b.agent.sendHeartbeat();
    if (aTransfer) await new Promise((resolve) => aTransfer.close(resolve));
    const lossWindowMs = 3_600;
    const lossStarted = Date.now();
    while (Date.now() - lossStarted < lossWindowMs) {
      await b.agent.sendHeartbeat();
      await sleep(250);
    }
    const devicesRes = await fetch(`${controlPlaneUrl}/devices`, {
      headers: { "X-User-Id": OWNER },
    });
    const devices = (await jsonOrNull(devicesRes))?.data;
    const deviceA = Array.isArray(devices) ? devices.find((device) => device.id === aId) : null;
    const deviceB = Array.isArray(devices) ? devices.find((device) => device.id === bId) : null;
    check("A is classified as suspected lost", deviceA?.status === "suspected_lost", deviceA?.status);
    check("B remains online during A's loss", deviceB?.status === "online", deviceB?.status);
    const protectionDuringLossRes = await fetch(
      `${controlPlaneUrl}/placement/protection/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const duringLoss = (await jsonOrNull(protectionDuringLossRes))?.data;
    check(
      "loss creates a one-copy protection shortfall",
      duringLoss?.healthyReplicas === 1 && duringLoss?.desiredReplicas === 2,
      JSON.stringify(duringLoss)
    );

    console.log("\nC comes online and performs direct B-to-C repair");
    const cTransfer = await startTransferServer(c);
    check("C transfer server started", Boolean(cTransfer));
    const cBeat = await c.agent.sendHeartbeat();
    check("C is online after A is lost", cBeat?.status === "online", JSON.stringify(cBeat));
    // Keep the healthy source inside the one-second online cutoff immediately
    // before reserving and transferring the repair.
    await b.agent.sendHeartbeat();
    const cIdentity = c.agent.currentIdentity();
    let repairAssignment;
    if (cIdentity?.deviceId) {
      const repairClient = new ControlPlaneClient(controlPlaneUrl);
      repairAssignment = await repairClient.pollRepair({
        deviceId: cIdentity.deviceId,
        privateKey: cIdentity.privateKey,
      });
    }
    check(
      "repair assignment names the uploaded object",
      repairAssignment?.objectHash === objectHash,
      JSON.stringify(repairAssignment)
    );
    check(
      "repair assignment selects B as the source",
      repairAssignment?.source.deviceId === bId,
      repairAssignment?.source.deviceId
    );
    const repaired = await c.agent.attemptRepair();
    check("C completed a real repair assignment", repaired === true);
    check("C stores the repaired bytes", await c.store.has(objectHash));
    check("C verifies the repaired hash", await c.store.verify(objectHash));

    const protectionAfterRes = await fetch(
      `${controlPlaneUrl}/placement/protection/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const after = (await jsonOrNull(protectionAfterRes))?.data;
    check(
      "repair restores healthy two-copy protection",
      after?.healthyReplicas === 2 && after?.desiredReplicas === 2 && after?.state === "healthy",
      JSON.stringify(after)
    );

    const downloadTargetsRes = await fetch(
      `${controlPlaneUrl}/placement/download-targets/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const downloadTargets = (await jsonOrNull(downloadTargetsRes))?.data?.targets;
    const downloadIds = Array.isArray(downloadTargets)
      ? downloadTargets.map((target) => target.deviceId)
      : [];
    check(
      "post-repair downloads target exactly B and C",
      downloadIds.length === 2 &&
        new Set(downloadIds).size === 2 &&
        downloadIds.includes(bId) &&
        downloadIds.includes(cId) &&
        !downloadIds.includes(aId),
      JSON.stringify(downloadIds)
    );
    const cTarget = Array.isArray(downloadTargets)
      ? downloadTargets.find((target) => target.deviceId === cId)
      : undefined;
    check("download plan includes repaired C copy", Boolean(cTarget));
    if (cTarget) {
      const downloaded = await fetch(cTarget.url, {
        headers: { "X-Transfer-Grant": cTarget.grant },
      });
      const roundTripped = Buffer.from(await downloaded.arrayBuffer());
      check("download from C is byte-for-byte identical", downloaded.status === 200 && roundTripped.equals(fileBody));
    } else {
      check("download from C is byte-for-byte identical", false, "no C download target");
    }
  } finally {
    for (const agent of agents) agent.stopHeartbeat();
    for (const transferServer of transferServers) {
      await new Promise((resolve) => transferServer.close(resolve));
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await controlPlaneRequire("mongoose").disconnect().catch(() => {});
    await controlPlaneRequire("./built/db/client.js").closeDb().catch(() => {});
    await mongo.stop();
    await rm(storageRoot, { recursive: true, force: true });

    const cleanup = new Client({ connectionString: baseUrl });
    await cleanup.connect();
    await cleanup.query(`drop database if exists "${dbName}" with (force)`);
    await cleanup.end();
  }

  console.log(failures === 0 ? "\nPROTECTION SMOKE PASSED\n" : `\nPROTECTION SMOKE FAILED (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nprotection smoke test crashed:", err);
  process.exit(1);
});
