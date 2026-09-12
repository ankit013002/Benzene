/**
 * Cross-package smoke test: the real node agent against the real control plane.
 *
 * The two are separate deployables with their own copies of the request-signing
 * format. Their unit suites and the shared protocol vectors each prove one half;
 * this proves the whole loop actually works over HTTP — enrollment, approval,
 * signature-authenticated heartbeat, device-primary metadata, and bytes moving
 * directly between the browser and an agent.
 *
 * Run from the repo root, with both packages built:
 *   node scripts/smoke-agent.mjs
 *
 * Requires a reachable PostgreSQL. Set SMOKE_DATABASE_URL to override.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";

const controlPlaneRequire = createRequire(
  new URL("../benzene-control-plane/package.json", import.meta.url)
);
const agentRequire = createRequire(
  new URL("../benzene-node-agent/package.json", import.meta.url)
);

const OWNER = "auth|smoke-user";
const AGENT_PORT = 7171;
const ALLOCATED = 64 * 1024 * 1024;

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

async function main() {
  const baseUrl =
    process.env.SMOKE_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";

  // --- throwaway Postgres database -----------------------------------------
  const { Client } = controlPlaneRequire("pg");
  const dbName = `benzene_smoke_${Date.now()}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`create database "${dbName}"`);
  await admin.end();

  const dbUrl = new URL(baseUrl);
  dbUrl.pathname = `/${dbName}`;
  const databaseUrl = dbUrl.toString();

  // --- in-memory Mongo, still holding file metadata ------------------------
  const { MongoMemoryServer } = controlPlaneRequire("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create();

  const storageRoot = await mkdtemp(path.join(tmpdir(), "benzene-smoke-"));
  let server;
  let transferServer;

  try {
    process.env.DATABASE_URL = databaseUrl;
    process.env.MONGOOSE_URI = mongo.getUri();
    process.env.STORAGE_DRIVER = "local";
    // Transfer grants are signed with this; the agent receives the public half
    // at enrollment.
    const { generateTransferSigningKeys } = controlPlaneRequire(
      "./built/modules/placement/transferGrant.js"
    );
    process.env.TRANSFER_SIGNING_KEY = generateTransferSigningKeys().privateKey;
    process.env.LOCAL_STORAGE_DIR = path.join(storageRoot, "cp");

    // createApp only configures routes; Mongoose connects lazily when the
    // device-backed metadata path is first used. Connect explicitly so a
    // failed reservation is reported by checks instead of waiting for the
    // driver's server-selection timeout.
    const mongoose = controlPlaneRequire("mongoose");
    await mongoose.connect(mongo.getUri());

    // --- migrate ------------------------------------------------------------
    const { drizzle } = controlPlaneRequire("drizzle-orm/node-postgres");
    const { migrate } = controlPlaneRequire("drizzle-orm/node-postgres/migrator");
    const { Pool } = controlPlaneRequire("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const db = drizzle(pool);
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../benzene-control-plane/drizzle", import.meta.url)
      ),
    });
    await pool.end();

    // --- start the real control plane ---------------------------------------
    const { createApp } = controlPlaneRequire("./built/app.js");
    const app = createApp();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;
    const controlPlaneUrl = `http://127.0.0.1:${port}`;
    console.log(`\ncontrol plane listening on ${controlPlaneUrl}\n`);

    // --- start the real agent -----------------------------------------------
    const { Agent } = agentRequire("./built/agent.js");
    const { loadAgentConfig } = agentRequire("./built/config.js");
    const { ObjectStore } = agentRequire("./built/store.js");
    const { ControlPlaneClient } = agentRequire("./built/controlPlane.js");

    const config = loadAgentConfig({
      controlPlaneUrl,
      dataDir: path.join(storageRoot, "agent"),
      storageDir: path.join(storageRoot, "agent", "storage"),
      identityFile: path.join(storageRoot, "agent", "identity.json"),
      allocatedBytes: ALLOCATED,
      deviceName: "Smoke Test Desktop",
      platform: "linux",
      advertisedUrl: `http://127.0.0.1:${AGENT_PORT}`,
      port: AGENT_PORT,
    });

    const store = new ObjectStore({
      rootDir: config.storageDir,
      allocatedBytes: config.allocatedBytes,
    });
    const agent = new Agent(config, store);
    await agent.initialise();

    console.log("enrollment");
    const { enrolled, prompt } = await agent.ensureEnrolled();
    check("agent is not enrolled before approval", enrolled === false);
    check("agent received a pairing code", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(prompt?.code ?? ""));

    check(
      "polling before approval leaves the device unenrolled",
      (await agent.pollEnrollment()) === false
    );

    // The user approving from the web app. Keep later checks alive if the
    // enrollment response did not contain a usable pairing code.
    let approveStatus;
    if (prompt?.code) {
      const approve = await fetch(`${controlPlaneUrl}/devices/enrollments/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-User-Id": OWNER },
        body: JSON.stringify({ code: prompt.code, allocatedBytes: ALLOCATED }),
      });
      approveStatus = approve.status;
    }
    check(
      "control plane accepted the approval",
      approveStatus === 201,
      `status ${approveStatus ?? "not attempted"}`
    );

    check("agent picks up its device id", (await agent.pollEnrollment()) === true);
    check("device id is persisted", Boolean(agent.currentIdentity()?.deviceId));

    console.log("\nsignature-authenticated heartbeat");
    const beat = await agent.sendHeartbeat();
    check("heartbeat accepted and device is online", beat?.status === "online", JSON.stringify(beat));

    const devicesRes = await fetch(`${controlPlaneUrl}/devices`, {
      headers: { "X-User-Id": OWNER },
    });
    const devicesPayload = await jsonOrNull(devicesRes);
    const devices = Array.isArray(devicesPayload?.data) ? devicesPayload.data : [];
    check("device appears in the vault", devices.length === 1);
    check("device reports online", devices[0]?.status === "online", devices[0]?.status);
    check(
      "allocation matches what the user granted",
      devices[0]?.allocatedBytes === ALLOCATED,
      String(devices[0]?.allocatedBytes)
    );

    console.log("\nstored bytes propagate to the vault");
    const payload = Buffer.from("smoke test payload");
    const stored = await store.put(Readable.from([payload]));
    await agent.sendHeartbeat();

    const vaultRes = await fetch(`${controlPlaneUrl}/vaults/me`, {
      headers: { "X-User-Id": OWNER },
    });
    const vault = (await jsonOrNull(vaultRes))?.data;
    check("vault reports the raw capacity the device contributed", vault?.rawCapacityBytes === ALLOCATED);
    check("vault counts the device as online capacity", vault?.onlineCapacityBytes === ALLOCATED);
    check("vault sees the stored bytes", vault?.usedBytes === payload.length, String(vault?.usedBytes));
    check("object verifies against its hash", (await store.verify(stored.hash)) === true);

    console.log("\nupload lands on the device");
    const { createTransferServer } = agentRequire("./built/transferServer.js");
    const identity = agent.currentIdentity();
    check(
      "agent received the control plane public key at enrollment",
      Boolean(identity.controlPlanePublicKey)
    );

    const transferReady = Boolean(identity?.deviceId && identity.controlPlanePublicKey);
    if (transferReady) {
      transferServer = createTransferServer({
        store,
        deviceId: identity.deviceId,
        controlPlanePublicKey: identity.controlPlanePublicKey,
        // The node, not the browser, proves possession after its store has
        // verified the incoming bytes against the content hash.
        reportPossession: ({ objectHash: storedHash, sizeBytes }) =>
          agent.reportPossession(storedHash, sizeBytes),
      }).listen(AGENT_PORT);
    }

    // Re-heartbeat so the control plane records the advertised address.
    await agent.sendHeartbeat();

    const fileBody = Buffer.from("a file the user dragged into Benzene");
    const objectHash = createHash("sha256").update(fileBody).digest("hex");

    const reserveRes = await fetch(`${controlPlaneUrl}/files/uploads/device`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-User-Id": OWNER },
      body: JSON.stringify({
        name: "smoke.txt",
        path: "smoke",
        size: fileBody.length,
        contentType: "text/plain",
        sha256: objectHash,
      }),
    });
    const reservation = (await jsonOrNull(reserveRes))?.data;
    check("device upload metadata reservation accepted", reserveRes.status === 201);
    check("device reservation is pending", Boolean(reservation?.versionId));
    check(
      "device reservation does not create a legacy storage key",
      Boolean(reservation?.versionId) && !reservation.key
    );

    const plan = reservation?.placement;
    check(
      "control plane returned a device target",
      Array.isArray(plan?.targets) && plan.targets.length === 1,
      JSON.stringify(plan ?? {}).slice(0, 220)
    );

    const target = plan?.targets?.[0];
    const usableTarget =
      target && typeof target.url === "string" && typeof target.grant === "string";
    if (transferServer && usableTarget) {
      const putRes = await fetch(target.url, {
        method: "PUT",
        headers: {
          "X-Transfer-Grant": target.grant,
          "Content-Type": "application/octet-stream",
        },
        body: fileBody,
      });
      check("device accepted the bytes", putRes.status === 201, `status ${putRes.status}`);
      check("bytes are on disk on the device", await store.has(objectHash));
      check("stored object verifies against its hash", (await store.verify(objectHash)) === true);
    } else {
      check("device accepted the bytes", false, "no usable transfer target");
      check("bytes are on disk on the device", false, "no usable transfer target");
      check("stored object verifies against its hash", false, "no usable transfer target");
    }

    let completeStatus;
    let completed;
    if (reservation?.versionId) {
      const completeRes = await fetch(`${controlPlaneUrl}/files/uploads/device/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-User-Id": OWNER },
        body: JSON.stringify({ versionIds: [reservation.versionId] }),
      });
      completeStatus = completeRes.status;
      completed = (await jsonOrNull(completeRes))?.data;
    }
    check(
      "device-backed metadata committed",
      completeStatus === 200,
      `status ${completeStatus ?? "not attempted"}`
    );
    check(
      "completion reports honest protection shortfall",
      completed?.completed?.[0]?.shortfall === true &&
        completed?.completed?.[0]?.protection?.healthyReplicas === 1
    );

    const listingRes = await fetch(`${controlPlaneUrl}/files?path=smoke`, {
      headers: { "X-User-Id": OWNER },
    });
    const listing = (await jsonOrNull(listingRes))?.data;
    check("device-backed file appears in its directory", listing?.files?.length === 1);
    check(
      "directory listing includes its object hash",
      listing?.files?.[0]?.objectHash === objectHash
    );
    check(
      "directory listing includes protection state",
      listing?.files?.[0]?.protection?.healthyReplicas === 1
    );

    const protRes = await fetch(
      `${controlPlaneUrl}/placement/protection/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const protection = (await jsonOrNull(protRes))?.data;
    check("object reports one healthy replica", protection?.healthyReplicas === 1);
    // One copy on one device: safe today, gone if that device dies.
    check(
      "a single remaining copy is reported as at risk",
      protection?.state === "at_risk",
      protection?.state
    );

    console.log("\ndownload comes back from the device");
    const dlRes = await fetch(
      `${controlPlaneUrl}/placement/download-targets/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const dlTargetsPayload = await jsonOrNull(dlRes);
    const dlTargets = Array.isArray(dlTargetsPayload?.data?.targets)
      ? dlTargetsPayload.data.targets
      : [];
    check("a read grant was issued", dlTargets.length === 1);

    const downloadTarget = dlTargets[0];
    const usableDownloadTarget =
      downloadTarget &&
      typeof downloadTarget.url === "string" &&
      typeof downloadTarget.grant === "string";
    if (usableDownloadTarget) {
      const fetched = await fetch(downloadTarget.url, {
        headers: { "X-Transfer-Grant": downloadTarget.grant },
      });
      const roundTripped = Buffer.from(await fetched.arrayBuffer());
      check("bytes round-trip identically", roundTripped.equals(fileBody));
    } else {
      check("bytes round-trip identically", false, "no usable download target");
    }

    console.log("\ndevice refuses unauthorised transfers");
    if (transferServer && usableTarget) {
      const noGrant = await fetch(target.url, { method: "GET" });
      check("device refuses a request with no grant", noGrant.status === 401);
    } else {
      check("device refuses a request with no grant", false, "no usable transfer target");
    }

    if (transferServer && usableDownloadTarget) {
      const wrongObject = await fetch(
        `http://127.0.0.1:${AGENT_PORT}/objects/${"c".repeat(64)}`,
        { headers: { "X-Transfer-Grant": downloadTarget.grant } }
      );
      check(
        "device refuses a grant replayed onto another object",
        wrongObject.status === 401,
        `status ${wrongObject.status}`
      );
    } else {
      check("device refuses a grant replayed onto another object", false, "no usable transfer grant");
    }

    console.log("\npresumed-lost inventory recovery");
    // Keep only the recovery lifecycle short enough for this smoke test. The
    // enrollment/upload flow above must retain production-like timing so a
    // slow CI runner cannot classify the device before placement completes.
    process.env.DEVICE_OFFLINE_AFTER_SECONDS = "1";
    process.env.DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS = "2";
    process.env.DEVICE_SUSPECTED_LOST_AFTER_SECONDS = "3";
    const { resetConfigCache } = controlPlaneRequire("./built/config/env.js");
    resetConfigCache();
    const recoveryIdentity = agent.currentIdentity();
    const recoveryDeviceId = recoveryIdentity?.deviceId;
    const recoveryClient = recoveryIdentity?.deviceId
      ? new ControlPlaneClient(controlPlaneUrl)
      : undefined;
    const recoveryHeartbeatInput = recoveryIdentity?.deviceId
      ? {
          deviceId: recoveryIdentity.deviceId,
          privateKey: recoveryIdentity.privateKey,
          usedBytes: store.usedBytes(),
          availableBytes: store.availableBytes(),
          appVersion: "smoke",
          advertisedUrl: `http://127.0.0.1:${AGENT_PORT}`,
        }
      : undefined;

    // Classification is intentionally opportunistic. Let the last signed
    // heartbeat age, then use the normal user-facing read to classify it.
    await sleep(3_500);
    const staleDevicesRes = await fetch(`${controlPlaneUrl}/devices`, {
      headers: { "X-User-Id": OWNER },
    });
    const staleDevices = (await jsonOrNull(staleDevicesRes))?.data;
    check(
      "stale device is classified as presumed lost",
      Array.isArray(staleDevices) && staleDevices.some(
        (device) => device.id === recoveryDeviceId && device.status === "suspected_lost"
      ),
      JSON.stringify(staleDevices)
    );

    if (recoveryClient && recoveryHeartbeatInput) {
      const quarantinedHeartbeat = await recoveryClient.heartbeat(recoveryHeartbeatInput);
      check(
        "a signed heartbeat alone leaves the device quarantined",
        quarantinedHeartbeat.status === "suspected_lost",
        JSON.stringify(quarantinedHeartbeat)
      );
      const quarantinedDevicesRes = await fetch(`${controlPlaneUrl}/devices`, {
        headers: { "X-User-Id": OWNER },
      });
      const quarantinedDevices = (await jsonOrNull(quarantinedDevicesRes))?.data;
      check(
        "quarantine persists until inventory is reconciled",
        Array.isArray(quarantinedDevices) && quarantinedDevices.some(
          (device) => device.id === recoveryDeviceId && device.status === "suspected_lost"
        ),
        JSON.stringify(quarantinedDevices)
      );
    } else {
      check("a signed heartbeat alone leaves the device quarantined", false, "device was not enrolled");
      check("quarantine persists until inventory is reconciled", false, "device was not enrolled");
    }

    // Agent.sendHeartbeat performs the hash-verified scan and signed inventory
    // submission after the control plane reports suspected loss.
    const recoveredHeartbeat = await agent.sendHeartbeat();
    check(
      "returned agent submits its full verified inventory",
      recoveredHeartbeat?.status === "suspected_lost"
    );
    const recoveredDevicesRes = await fetch(`${controlPlaneUrl}/devices`, {
      headers: { "X-User-Id": OWNER },
    });
    const recoveredDevices = (await jsonOrNull(recoveredDevicesRes))?.data;
    check(
      "inventory recovery brings the device online",
      Array.isArray(recoveredDevices) && recoveredDevices.some(
        (device) => device.id === recoveryDeviceId && device.status === "online"
      ),
      JSON.stringify(recoveredDevices)
    );
    const recoveredProtectionRes = await fetch(
      `${controlPlaneUrl}/placement/protection/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const recoveredProtection = (await jsonOrNull(recoveredProtectionRes))?.data;
    check(
      "present object is healthy again after inventory recovery",
      recoveredProtection?.healthyReplicas === 1,
      JSON.stringify(recoveredProtection)
    );

    // A fresh process gives the next presumed-loss episode a clean
    // reconciliation state, just as a restarted node would have.
    const missingAgent = new Agent(config, store);
    await missingAgent.initialise();

    // Exercise the omission branch deterministically: remove the managed
    // object, let the same device become presumed lost again, and reconcile
    // an inventory that proves the replica is missing.
    await store.delete(objectHash);
    check("missing-object fixture was removed from the device", !(await store.has(objectHash)));
    await sleep(3_500);
    await fetch(`${controlPlaneUrl}/devices`, { headers: { "X-User-Id": OWNER } });
    if (recoveryClient && recoveryHeartbeatInput) {
      const missingHeartbeat = await recoveryClient.heartbeat({
        ...recoveryHeartbeatInput,
        usedBytes: store.usedBytes(),
        availableBytes: store.availableBytes(),
      });
      check(
        "missing-object heartbeat is still quarantined before inventory",
        missingHeartbeat.status === "suspected_lost",
        JSON.stringify(missingHeartbeat)
      );
    } else {
      check("missing-object heartbeat is still quarantined before inventory", false, "device was not enrolled");
    }
    const missingInventoryHeartbeat = await missingAgent.sendHeartbeat();
    check(
      "missing-object inventory is accepted",
      missingInventoryHeartbeat?.status === "suspected_lost"
    );
    const missingProtectionRes = await fetch(
      `${controlPlaneUrl}/placement/protection/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const missingProtection = (await jsonOrNull(missingProtectionRes))?.data;
    check(
      "omitted object is no longer counted as healthy protection",
      missingProtection?.healthyReplicas === 0,
      JSON.stringify(missingProtection)
    );

    // Restore the bytes, then use a fresh agent instance to represent the
    // returning process after the prior missing-inventory episode.
    await store.put(Readable.from([fileBody]), {
      expectedHash: objectHash,
      expectedSize: fileBody.length,
    });
    // The missing inventory brought the device online. Age that fresh
    // heartbeat again so the restarted agent exercises the recovery path
    // rather than taking the normal-online fast path.
    await sleep(3_500);
    const finalStaleDevicesRes = await fetch(`${controlPlaneUrl}/devices`, {
      headers: { "X-User-Id": OWNER },
    });
    const finalStaleDevices = (await jsonOrNull(finalStaleDevicesRes))?.data;
    check(
      "restored device is classified as presumed lost again",
      Array.isArray(finalStaleDevices) && finalStaleDevices.some(
        (device) => device.id === recoveryDeviceId && device.status === "suspected_lost"
      ),
      JSON.stringify(finalStaleDevices)
    );
    const returningAgent = new Agent(config, store);
    await returningAgent.initialise();
    const finalRecoveryHeartbeat = await returningAgent.sendHeartbeat();
    check(
      "restored object is reconciled on the returning agent",
      finalRecoveryHeartbeat?.status === "suspected_lost"
    );
    const finalProtectionRes = await fetch(
      `${controlPlaneUrl}/placement/protection/${objectHash}`,
      { headers: { "X-User-Id": OWNER } }
    );
    const finalProtection = (await jsonOrNull(finalProtectionRes))?.data;
    check(
      "restored object regains healthy protection",
      finalProtection?.healthyReplicas === 1,
      JSON.stringify(finalProtection)
    );
    missingAgent.stopHeartbeat();
    returningAgent.stopHeartbeat();

    // Do not let the smoke-only timing affect the remaining removal checks or
    // the config used while the process shuts down. Use deliberately safe
    // defaults even if the caller supplied unusually short values.
    process.env.DEVICE_OFFLINE_AFTER_SECONDS = "120";
    process.env.DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS = "86400";
    delete process.env.DEVICE_SUSPECTED_LOST_AFTER_SECONDS;
    resetConfigCache();

    console.log("\nrejects a forged signature");
    const forgedDeviceId = agent.currentIdentity()?.deviceId;
    if (forgedDeviceId) {
      const forged = await fetch(`${controlPlaneUrl}/agent/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Device-Id": forgedDeviceId,
          "X-Device-Timestamp": String(Math.floor(Date.now() / 1000)),
          "X-Device-Signature": Buffer.from("not a real signature").toString("base64"),
        },
        body: JSON.stringify({ usedBytes: 0 }),
      });
      check("forged heartbeat is refused", forged.status === 401, `status ${forged.status}`);
    } else {
      check("forged heartbeat is refused", false, "device was not enrolled");
    }

    console.log("\ndevice removal erases only its Benzene store");
    const removalConfig = loadAgentConfig({
      controlPlaneUrl,
      dataDir: path.join(storageRoot, "removal-agent"),
      storageDir: path.join(storageRoot, "removal-agent", "storage"),
      identityFile: path.join(storageRoot, "removal-agent", "identity.json"),
      allocatedBytes: ALLOCATED,
      deviceName: "Smoke Removal Desktop",
      platform: "linux",
      advertisedUrl: "http://127.0.0.1:0",
      port: 0,
    });
    const removalStore = new ObjectStore({
      rootDir: removalConfig.storageDir,
      allocatedBytes: removalConfig.allocatedBytes,
    });
    const { Agent: RemovalAgent } = agentRequire("./built/agent.js");
    const removalAgent = new RemovalAgent(removalConfig, removalStore);
    await removalAgent.initialise();
    const removalEnrollment = await removalAgent.ensureEnrolled();
    check("second agent received a pairing code", Boolean(removalEnrollment.prompt?.code));

    let removalApprovalStatus;
    if (removalEnrollment.prompt?.code) {
      const removalApproval = await fetch(`${controlPlaneUrl}/devices/enrollments/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-User-Id": OWNER },
        body: JSON.stringify({
          code: removalEnrollment.prompt.code,
          allocatedBytes: ALLOCATED,
        }),
      });
      removalApprovalStatus = removalApproval.status;
    }
    check("control plane accepted the second approval", removalApprovalStatus === 201);
    check("second agent became enrolled", (await removalAgent.pollEnrollment()) === true);
    const removalIdentity = removalAgent.currentIdentity();
    check("second agent has removal credentials", Boolean(removalIdentity?.deviceId));

    const removalPayload = await removalStore.put(
      Readable.from([Buffer.from("remove me")])
    );
    await writeFile(path.join(removalConfig.storageDir, "keep.txt"), "leave me");
    const removalBeat = await removalAgent.sendHeartbeat();
    check("second agent is online before removal", removalBeat?.status === "online");

    const removalDeviceId = removalIdentity?.deviceId;
    let removalResponse;
    if (removalDeviceId) {
      removalResponse = await fetch(`${controlPlaneUrl}/devices/${removalDeviceId}/removal`, {
        method: "POST",
        headers: { "X-User-Id": OWNER },
      });
    }
    const removalView = await jsonOrNull(removalResponse);
    check("user removal request entered draining", removalResponse?.status === 202);
    check(
      "draining device is reported by the user endpoint",
      removalView?.data?.status === "draining"
    );

    const removalDone = removalDeviceId ? await removalAgent.pollRemoval() : false;
    check("agent accepted the erase directive", removalDone === true);
    check("managed removal bytes were erased", (await removalStore.list()).length === 0);
    check("removal store usage is zero", removalStore.usedBytes() === 0);
    check(
      "removal store sibling remains",
      await readFile(path.join(removalConfig.storageDir, "keep.txt"), "utf8") === "leave me"
    );
    check(
      "removal agent relinquished its identity",
      removalAgent.currentIdentity()?.deviceId === null
    );

    if (removalDeviceId && removalIdentity) {
      const removalClient = new ControlPlaneClient(controlPlaneUrl);
      const retry = await removalClient.completeRemoval({
        deviceId: removalDeviceId,
        privateKey: removalIdentity.privateKey,
      });
      check("removal completion retry is idempotent", retry.status === "removed");
      try {
        await removalClient.heartbeat({
          deviceId: removalDeviceId,
          privateKey: removalIdentity.privateKey,
          usedBytes: 0,
          availableBytes: ALLOCATED,
          appVersion: "smoke",
        });
        check("removed device rejects normal signed requests", false, "heartbeat was accepted");
      } catch (error) {
        check("removed device rejects normal signed requests", error?.status === 401);
      }
    } else {
      check("removal completion retry is idempotent", false, "second agent was not enrolled");
      check("removed device rejects normal signed requests", false, "second agent was not enrolled");
    }

    if (removalDeviceId) {
      const afterRemovalDevices = await fetch(`${controlPlaneUrl}/devices`, {
        headers: { "X-User-Id": OWNER },
      });
      const afterRemovalPayload = await jsonOrNull(afterRemovalDevices);
      const afterRemovalList = Array.isArray(afterRemovalPayload?.data)
        ? afterRemovalPayload.data
        : [];
      check(
        "removed device disappears from the vault list",
        !afterRemovalList.some((device) => device.id === removalDeviceId)
      );
    } else {
      check("removed device disappears from the vault list", false, "second agent was not enrolled");
    }

    check("removal object was written before erase", removalPayload.size > 0);

    agent.stopHeartbeat();
  } finally {
    if (transferServer) await new Promise((r) => transferServer.close(r));
    if (server) await new Promise((r) => server.close(r));
    const mongooseModule = controlPlaneRequire("mongoose");
    await mongooseModule.disconnect().catch(() => {});
    await controlPlaneRequire("./built/db/client.js").closeDb().catch(() => {});
    await mongo.stop();
    await rm(storageRoot, { recursive: true, force: true });

    const cleanup = new Client({ connectionString: baseUrl });
    await cleanup.connect();
    await cleanup.query(`drop database if exists "${dbName}" with (force)`);
    await cleanup.end();
  }

  console.log(failures === 0 ? "\nSMOKE PASSED\n" : `\nSMOKE FAILED (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nsmoke test crashed:", err);
  process.exit(1);
});
