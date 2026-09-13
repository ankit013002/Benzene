/**
 * Cross-service authentication acceptance test.
 *
 * This starts the real auth service, Java gateway, control-plane app, Next.js
 * frontend and two node agents. It signs up a fresh credential through the
 * Next route, captures its verification email through a loopback SMTP server,
 * verifies the link through the Next bridge, logs in through the Next web
 * route, enrolls agents through the gateway, approves their pairing codes
 * through Next, and completes a Protected upload whose bytes travel directly
 * between the caller and the agents.
 *
 * This is an authenticated HTTP web-route/topology acceptance harness, not a
 * browser-runtime test: it does not execute frontend helper code or validate
 * browser CORS, mixed-content, or other browser-enforcement behavior.
 *
 * The direct gateway request with spoofed headers remains intentional: it
 * isolates the gateway's identity-header stripping from the Next web route.
 *
 * Run from the repository root after building the control plane, node agent
 * and frontend:
 *   node scripts/smoke-auth-gateway.mjs
 *
 * Requires a reachable PostgreSQL. Set SMOKE_DATABASE_URL to override.
 */
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const controlPlaneDir = path.join(repoRoot, "benzene-control-plane");
const authDir = path.join(repoRoot, "benzene-auth-service");
const gatewayDir = path.join(repoRoot, "nebula-gateway");
const frontendDir = path.join(repoRoot, "nebulavault-frontend");

const controlPlaneRequire = createRequire(
  new URL("../benzene-control-plane/package.json", import.meta.url)
);
const agentRequire = createRequire(
  new URL("../benzene-node-agent/package.json", import.meta.url)
);

const AUTH_SECRET =
  process.env.SMOKE_AUTH_SECRET ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const GATEWAY_PORT = Number.parseInt(
  process.env.SMOKE_GATEWAY_PORT ?? "18080",
  10
);
const AUTH_PORT = Number.parseInt(process.env.SMOKE_AUTH_PORT ?? "14000", 10);
const FRONTEND_PORT = Number.parseInt(
  process.env.SMOKE_FRONTEND_PORT ?? "13000",
  10
);
const LOGIN_EMAIL = `acceptance-${process.pid}@example.com`;
const LOGIN_PASSWORD = "acceptance-password-123";
const REQUEST_TIMEOUT_MS = 15_000;
const MONGO_START_TIMEOUT_MS = 120_000;
const MONGO_CONNECT_TIMEOUT_MS = 15_000;
const AGENT_PORT_BASE = Number.parseInt(
  process.env.SMOKE_LAN_AGENT_PORT_BASE ?? "7274",
  10
);
const AGENT_ALLOCATED_BYTES = 64 * 1024 * 1024;

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

async function withTimeout(label, operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function startProcess(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.getOutput = () => output.slice(-4000);
  return child;
}

function signalProcess(child, signal) {
  if (!child?.pid) return;

  if (process.platform !== "win32") {
    try {
      // Detached children become their own process-group leaders. Signalling
      // the group also terminates npm/tsx, Maven and the app they launched.
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

async function stopProcess(child) {
  if (!child) return;
  signalProcess(child, "SIGTERM");
  await waitForExit(child, 2_000);
  if (child.exitCode === null) {
    signalProcess(child, "SIGKILL");
    await waitForExit(child, 1_000);
  }
}

function request(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + 60_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label} exited early (${child.exitCode})\n${child.getOutput()}`);
    }
    try {
      const response = await request(url);
      if (response.status < 500) {
        await response.body?.cancel();
        return response;
      }
      await response.body?.cancel();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError}\n${child?.getOutput?.() ?? ""}`);
}

async function jsonOrNull(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseSetCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=]+=[^;,=]+)/);
}

function responseCookies(response) {
  const values = responseSetCookies(response);
  return values
    .map((cookie) => cookie.split(";", 1)[0].trim())
    .filter((cookie) => cookie.includes("="));
}

function cookieValue(cookies, name) {
  return cookies
    .map((cookie) => cookie.split("=", 2))
    .find(([key]) => key === name)?.[1];
}

function decodeJwtPayload(token) {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function listen(app, port = 0) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function startSmtpCapture() {
  const messages = [];
  const waiters = [];
  const sockets = new Set();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    let input = "";
    let dataLines = null;

    const send = (response) => socket.write(`${response}\r\n`);
    send("220 benzene-smoke.local ESMTP ready");

    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      while (true) {
        const end = input.indexOf("\r\n");
        if (end < 0) break;
        const line = input.slice(0, end);
        input = input.slice(end + 2);

        if (dataLines) {
          if (line === ".") {
            const message = dataLines.join("\r\n");
            dataLines = null;
            messages.push(message);
            const waiter = waiters.shift();
            if (waiter) {
              clearTimeout(waiter.timer);
              waiter.resolve(message);
            }
            send("250 2.0.0 queued");
          } else {
            dataLines.push(line.startsWith("..") ? line.slice(1) : line);
          }
          continue;
        }

        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) {
          socket.write(
            "250-benzene-smoke.local\r\n250-SIZE 10485760\r\n250-8BITMIME\r\n250 OK\r\n"
          );
        } else if (command.startsWith("MAIL FROM") || command.startsWith("RCPT TO")) {
          send("250 2.1.0 accepted");
        } else if (command === "DATA") {
          dataLines = [];
          send("354 End data with <CR><LF>.<CR><LF>");
        } else if (command === "RSET") {
          send("250 2.0.0 reset");
        } else if (command === "QUIT") {
          send("221 2.0.0 closing");
          socket.end();
        } else {
          send("250 2.0.0 accepted");
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });

  return {
    port: server.address().port,
    waitForMessage(timeoutMs = REQUEST_TIMEOUT_MS) {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`SMTP capture timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(resolve);
      });
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("SMTP capture closed"));
      }
    },
  };
}

function decodeQuotedPrintable(value) {
  return value
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll("&amp;", "&");
}

function extractVerificationUrl(message) {
  const decodedMessage = decodeQuotedPrintable(message);
  const match = decodedMessage.match(
    /https?:\/\/[^\s"'<>]+\/api\/auth\/verify-email\?token=[^\s"'<>]+/
  );
  return match?.[0] ?? null;
}

async function closeServer(server, label) {
  if (!server) return;
  console.log(`cleanup: closing ${label}`);
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      finish();
    }, 2_000);
    try {
      server.close(finish);
    } catch {
      finish();
    }
  });
}

async function cleanupStep(label, action) {
  console.log(`cleanup: ${label}`);
  const operation = Promise.resolve().then(action);
  operation.catch(() => {});
  try {
    await Promise.race([
      operation,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cleanup deadline exceeded")), 5_000)
      ),
    ]);
  } catch (error) {
    console.warn(`cleanup warning (${label}): ${error}`);
  }
}

async function main() {
  const baseUrl =
    process.env.SMOKE_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
  const { Client, Pool } = controlPlaneRequire("pg");
  const dbName = `benzene_auth_gateway_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let databaseUrl;
  let controlPlaneServer;
  let authProcess;
  let gatewayProcess;
  let frontendProcess;
  let authPool;
  let smtpCapture;
  let storageRoot;
  let mongo;
  const agents = [];
  const transferServers = [];

  try {
    const admin = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    await admin.end();

    const dbUrl = new URL(baseUrl);
    dbUrl.pathname = `/${dbName}`;
    databaseUrl = dbUrl.toString();

    authPool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    const authMigration = await readFile(
      path.join(authDir, "src/db/migrations/001_initial.sql"),
      "utf8"
    );
    await authPool.query(authMigration);

    const { MongoMemoryServer } = controlPlaneRequire("mongodb-memory-server");
    mongo = await withTimeout(
      "MongoMemoryServer startup",
      () => MongoMemoryServer.create(),
      MONGO_START_TIMEOUT_MS
    );
    process.env.DATABASE_URL = databaseUrl;
    process.env.MONGOOSE_URI = mongo.getUri();
    process.env.STORAGE_DRIVER = "local";
    process.env.DEVICE_OFFLINE_AFTER_SECONDS = "120";
    process.env.DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS = "86400";
    storageRoot = await mkdtemp(path.join(tmpdir(), "benzene-auth-gateway-"));
    process.env.LOCAL_STORAGE_DIR = path.join(storageRoot, "control-plane");
    process.env.TRANSFER_SIGNING_KEY = controlPlaneRequire(
      "./built/modules/placement/transferGrant.js"
    ).generateTransferSigningKeys().privateKey;

    const mongoose = controlPlaneRequire("mongoose");
    await withTimeout(
      "Mongoose connection",
      () =>
        mongoose.connect(mongo.getUri(), {
          serverSelectionTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
          connectTimeoutMS: MONGO_CONNECT_TIMEOUT_MS,
        }),
      MONGO_CONNECT_TIMEOUT_MS
    );

    const { drizzle } = controlPlaneRequire("drizzle-orm/node-postgres");
    const { migrate } = controlPlaneRequire("drizzle-orm/node-postgres/migrator");
    const migrationPool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    try {
      await migrate(drizzle(migrationPool), {
        migrationsFolder: fileURLToPath(
          new URL("../benzene-control-plane/drizzle", import.meta.url)
        ),
      });
    } finally {
      await migrationPool.end();
    }

    const { createApp } = controlPlaneRequire("./built/app.js");
    controlPlaneServer = await listen(createApp());
    const controlPlaneUrl = `http://127.0.0.1:${controlPlaneServer.address().port}`;
    console.log(`\ncontrol plane listening on ${controlPlaneUrl}`);

    smtpCapture = await startSmtpCapture();
    const frontendOrigin = `http://127.0.0.1:${FRONTEND_PORT}`;
    authProcess = startProcess(
      "npm",
      ["run", "start"],
      authDir,
      {
        AUTH_SECRET,
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
        PORT: String(AUTH_PORT),
        APP_ORIGIN: frontendOrigin,
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtpCapture.port),
        SMTP_SECURE: "false",
      }
    );
    await waitForHttp(`http://127.0.0.1:${AUTH_PORT}/api/health`, authProcess, "auth service");
    console.log(`auth service listening on http://127.0.0.1:${AUTH_PORT}`);

    gatewayProcess = startProcess(
      "./mvnw",
      ["-B", "-ntp", "spring-boot:run"],
      gatewayDir,
      {
        AUTH_SECRET,
        AUTH_SERVICE_URI: `http://127.0.0.1:${AUTH_PORT}`,
        FILES_SERVICE_URI: controlPlaneUrl,
        SERVER_PORT: String(GATEWAY_PORT),
      }
    );
    await waitForHttp(
      `http://127.0.0.1:${GATEWAY_PORT}/actuator/health`,
      gatewayProcess,
      "Java gateway"
    );
    const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`;
    console.log(`gateway listening on ${gatewayUrl}`);

    frontendProcess = startProcess(
      "npm",
      ["run", "start"],
      frontendDir,
      {
        APP_BASE_URL: `http://127.0.0.1:${FRONTEND_PORT}`,
        AUTH_SECRET,
        GATEWAY_ORIGIN: gatewayUrl,
        NEXT_PUBLIC_GATEWAY_ORIGIN: gatewayUrl,
        HOSTNAME: "127.0.0.1",
        PORT: String(FRONTEND_PORT),
      }
    );
    await waitForHttp(
      `http://127.0.0.1:${FRONTEND_PORT}/login`,
      frontendProcess,
      "Next.js frontend"
    );
    const frontendUrl = frontendOrigin;
    console.log(`frontend listening on ${frontendUrl}`);

    console.log("\nsign up through the Next.js web route and verify through its SMTP link");
    const signupResponse = await request(`${frontendUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
    const signupBody = await jsonOrNull(signupResponse);
    const signupRawCookies = responseSetCookies(signupResponse);
    const signupCookieNames = responseCookies(signupResponse).map((cookie) => cookie.split("=", 1)[0]);
    check("Next signup route created an unverified credential", signupResponse.status === 201 && signupBody?.emailVerified === false, JSON.stringify(signupBody));
    check(
      "Next signup route forwarded httpOnly loopback auth cookies without Secure",
      ["session", "refresh_token"].every((name) =>
        signupRawCookies.some(
          (cookie) =>
            cookie.trimStart().startsWith(`${name}=`) &&
            /;\s*HttpOnly(?:;|$)/i.test(cookie) &&
            !/;\s*Secure(?:;|$)/i.test(cookie)
        )
      ) && signupCookieNames.includes("session") && signupCookieNames.includes("refresh_token")
    );

    const signupCredential = await authPool.query(
      "select id, email_verified from credentials where email = $1",
      [LOGIN_EMAIL]
    );
    const credentialId = signupCredential.rows[0]?.id;
    check("signup persisted the acceptance credential", typeof credentialId === "string" && signupCredential.rows[0]?.email_verified === false);

    let verificationMessage;
    try {
      verificationMessage = await smtpCapture.waitForMessage();
    } catch (error) {
      check("SMTP capture received the verification email", false, error instanceof Error ? error.message : String(error));
    }
    const verificationUrl = verificationMessage ? extractVerificationUrl(verificationMessage) : null;
    check("SMTP capture contained a verification URL", Boolean(verificationUrl));
    check(
      "SMTP verification URL targets the frontend origin",
      verificationUrl?.startsWith(`${frontendUrl}/api/auth/verify-email?token=`) === true
    );
    let verificationLocation;
    if (verificationUrl) {
      const verificationResponse = await request(verificationUrl, { redirect: "manual" });
      verificationLocation = verificationResponse.headers.get("location") ?? "";
      let localResultUrl;
      try {
        localResultUrl = new URL(verificationLocation, frontendUrl);
      } catch {
        localResultUrl = null;
      }
      const hasExpectedResult =
        verificationResponse.status >= 300 && verificationResponse.status < 400 &&
        localResultUrl?.origin === frontendUrl &&
        localResultUrl.pathname === "/verify-email" &&
        localResultUrl.searchParams.get("status") === "success";
      check(
        "Next verification bridge returned the local success result",
        hasExpectedResult,
        `status ${verificationResponse.status}, location ${verificationLocation || "missing"}`
      );
      if (hasExpectedResult) {
        const resultPageResponse = await request(localResultUrl, { redirect: "manual" });
        const resultPage = await resultPageResponse.text();
        check(
          "public verification result page rendered",
          resultPageResponse.status === 200 &&
            resultPage.includes("Email verified") &&
            resultPage.includes("Your Benzene account is ready.")
        );
      }
    }
    const verifiedCredential = await authPool.query(
      "select email_verified from credentials where id = $1",
      [credentialId ?? null]
    );
    check("email verification persisted true", verifiedCredential.rows[0]?.email_verified === true);

    console.log("\nlogin through the Next.js web route");
    const loginResponse = await request(`${frontendUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
    const loginBody = await jsonOrNull(loginResponse);
    const rawCookies = responseSetCookies(loginResponse);
    const cookies = responseCookies(loginResponse);
    const session = cookieValue(cookies, "session");
    const claims = decodeJwtPayload(session);
    check("Next login route forwarded a successful real password login", loginResponse.status === 200, JSON.stringify(loginBody));
    check(
      "Next login route forwarded an httpOnly session cookie",
      typeof session === "string" &&
        session.length > 0 &&
        rawCookies.some((cookie) => /^\s*session=/.test(cookie) && /;\s*HttpOnly(?:;|$)/i.test(cookie))
    );
    check("Next login route session JWT identifies the created credential", claims?.sub === credentialId);
    check("Next login route session JWT carries the login email", claims?.email === LOGIN_EMAIL);

    const cookieHeader = cookies.join("; ");
    const webVaultResponse = await request(`${frontendUrl}/api/vault`, {
      headers: { Cookie: cookieHeader },
    });
    const webVaultBody = await jsonOrNull(webVaultResponse);
    const vaultId = webVaultBody?.data?.id;
    check("Next vault route reached the real control plane", webVaultResponse.status === 200, JSON.stringify(webVaultBody));
    check("Next vault route returned a vault for the authenticated user", typeof vaultId === "string");

    const spoofedResponse = await request(`${gatewayUrl}/vaults/me`, {
      headers: {
        Cookie: cookieHeader,
        "X-User-Id": "attacker-id",
        "X-User-AuthSub": "attacker-sub",
        "X-User-Email": "attacker@example.com",
      },
    });
    const spoofedBody = await jsonOrNull(spoofedResponse);
    check("spoofed identity headers do not bypass the gateway", spoofedResponse.status === 200);
    check(
      "gateway strips spoofed identity headers before routing",
      spoofedBody?.data?.id === vaultId,
      `expected ${vaultId ?? "a vault"}, got ${spoofedBody?.data?.id ?? "none"}`
    );

    const gatewayAnonymousResponse = await request(`${gatewayUrl}/vaults/me`);
    await gatewayAnonymousResponse.body?.cancel();
    check("direct gateway anonymous request is refused", gatewayAnonymousResponse.status === 401, `status ${gatewayAnonymousResponse.status}`);

    const frontendAnonymousResponse = await request(`${frontendUrl}/api/vault`, {
      redirect: "manual",
    });
    await frontendAnonymousResponse.body?.cancel();
    const frontendRedirect = frontendAnonymousResponse.headers.get("location") ?? "";
    check(
      "Next vault route anonymous request is redirected without following it",
      frontendAnonymousResponse.status >= 300 && frontendAnonymousResponse.status < 400 &&
        new URL(frontendRedirect, frontendUrl).pathname === "/login",
      `status ${frontendAnonymousResponse.status}, location ${frontendRedirect || "missing"}`
    );

    console.log("\nreal agents enroll through the gateway and approval goes through the Next web route");
    const { Agent } = agentRequire("./built/agent.js");
    const { loadAgentConfig } = agentRequire("./built/config.js");
    const { ObjectStore } = agentRequire("./built/store.js");
    const { createTransferServer } = agentRequire("./built/transferServer.js");

    const makeAgent = async (name, port) => {
      const config = loadAgentConfig({
        controlPlaneUrl: gatewayUrl,
        dataDir: path.join(storageRoot, name),
        storageDir: path.join(storageRoot, name, "storage"),
        identityFile: path.join(storageRoot, name, "identity.json"),
        allocatedBytes: AGENT_ALLOCATED_BYTES,
        deviceName: `LAN Acceptance ${name}`,
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

    const enrollThroughWebRoute = async (device) => {
      const enrollment = await device.agent.ensureEnrolled();
      check(`${device.config.deviceName} received a pairing code`, Boolean(enrollment.prompt?.code));
      let approval;
      if (enrollment.prompt?.code) {
        approval = await request(`${frontendUrl}/api/devices/enrollments`, {
          method: "POST",
          headers: { Cookie: cookieHeader, "content-type": "application/json" },
          body: JSON.stringify({
            code: enrollment.prompt.code,
            allocatedBytes: AGENT_ALLOCATED_BYTES,
          }),
        });
      }
      check(
        `${device.config.deviceName} approval passed through the Next web route`,
        approval?.status === 201,
        `status ${approval?.status ?? "not attempted"}`
      );
      await approval?.body?.cancel();
      check(`${device.config.deviceName} became enrolled through the gateway`, await device.agent.pollEnrollment());
      return device.agent.currentIdentity()?.deviceId;
    };

    const first = await makeAgent("agent-a", AGENT_PORT_BASE);
    const second = await makeAgent("agent-b", AGENT_PORT_BASE + 1);
    const firstId = await enrollThroughWebRoute(first);
    const secondId = await enrollThroughWebRoute(second);
    check("two real agents have distinct device identities", Boolean(firstId && secondId && firstId !== secondId));

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

    const firstTransfer = await startTransferServer(first);
    const secondTransfer = await startTransferServer(second);
    check("first agent transfer server started", Boolean(firstTransfer));
    check("second agent transfer server started", Boolean(secondTransfer));
    check("first agent heartbeat is accepted by the gateway", (await first.agent.sendHeartbeat())?.status === "online");
    check("second agent heartbeat is accepted by the gateway", (await second.agent.sendHeartbeat())?.status === "online");

    console.log("\nNext upload route reserves Protected placement; bytes go directly to agents");
    const fileBody = Buffer.from("authenticated LAN journey payload");
    const objectHash = createHash("sha256").update(fileBody).digest("hex");
    const reservationResponse = await request(`${frontendUrl}/api/files/uploads/device`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({
        name: "lan-journey.txt",
        path: "lan-journey",
        size: fileBody.length,
        contentType: "text/plain",
        sha256: objectHash,
      }),
    });
    const reservation = (await jsonOrNull(reservationResponse))?.data;
    check("Next upload route reservation succeeded", reservationResponse.status === 201, JSON.stringify(reservation));
    const targets = Array.isArray(reservation?.placement?.targets)
      ? reservation.placement.targets
      : [];
    check("default Protected policy selected exactly two devices", targets.length === 2);
    check(
      "selected devices are the two enrolled agents",
      targets.length === 2 &&
        new Set(targets.map((target) => target.deviceId)).size === 2 &&
        targets.every((target) => target.deviceId === firstId || target.deviceId === secondId),
      JSON.stringify(targets.map((target) => target.deviceId))
    );
    const serviceOrigins = new Set([frontendUrl, gatewayUrl, controlPlaneUrl]);
    const agentOrigins = new Set([
      `http://127.0.0.1:${AGENT_PORT_BASE}`,
      `http://127.0.0.1:${AGENT_PORT_BASE + 1}`,
    ]);
    check(
      "upload targets bypass Next, gateway and control plane",
      targets.length === 2 &&
        targets.every((target) => {
          try {
            return !serviceOrigins.has(new URL(target.url).origin) &&
              agentOrigins.has(new URL(target.url).origin);
          } catch {
            return false;
          }
        }),
      JSON.stringify(targets.map((target) => target.url))
    );

    for (const target of targets) {
      const putResponse = await request(target.url, {
        method: "PUT",
        headers: {
          "X-Transfer-Grant": target.grant,
          "Content-Type": "application/octet-stream",
        },
        body: fileBody,
      });
      check(`agent ${target.deviceId} accepted direct bytes`, putResponse.status === 201, `status ${putResponse.status}`);
      await putResponse.body?.cancel();
    }
    check("first agent verifies the uploaded bytes", await first.store.verify(objectHash));
    check("second agent verifies the uploaded bytes", await second.store.verify(objectHash));

    const completeResponse = await request(`${frontendUrl}/api/files/uploads/device/complete`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ versionIds: [reservation?.versionId] }),
    });
    const completed = (await jsonOrNull(completeResponse))?.data;
    check("Next completion route succeeded", completeResponse.status === 200, JSON.stringify(completed));
    check(
      "completion reports healthy Protected protection",
      completed?.completed?.[0]?.protection?.healthyReplicas === 2 &&
        completed?.completed?.[0]?.protection?.desiredReplicas === 2,
      JSON.stringify(completed)
    );

    const listingResponse = await request(`${frontendUrl}/api/files?path=lan-journey`, {
      headers: { Cookie: cookieHeader },
    });
    const listing = (await jsonOrNull(listingResponse))?.data;
    check("Next directory-listing route succeeded", listingResponse.status === 200);
    check("listing exposes the device-backed object hash", listing?.files?.[0]?.objectHash === objectHash);

    const protectionResponse = await request(`${frontendUrl}/api/protection`, {
      headers: { Cookie: cookieHeader },
    });
    const protection = (await jsonOrNull(protectionResponse))?.data;
    check(
      "Next protection route reports a healthy summary",
      protectionResponse.status === 200 &&
        protection?.mode === "protected" &&
        protection?.desiredReplicas === 2 &&
        protection?.healthyObjects === 1 &&
        protection?.state === "healthy",
      JSON.stringify(protection)
    );

    const downloadPlanResponse = await request(
      `${frontendUrl}/api/placement/download-targets/${objectHash}`,
      { headers: { Cookie: cookieHeader } }
    );
    const downloadTargets = (await jsonOrNull(downloadPlanResponse))?.data?.targets;
    const downloadIds = Array.isArray(downloadTargets)
      ? downloadTargets.map((target) => target.deviceId)
      : [];
    const downloadOrigins = Array.isArray(downloadTargets)
      ? downloadTargets.map((target) => {
          try {
            return new URL(target.url).origin;
          } catch {
            return "invalid";
          }
        })
      : [];
    check(
      "Next read-plan route returns two unique agent targets",
        downloadPlanResponse.status === 200 &&
        downloadIds.length === 2 &&
        new Set(downloadIds).size === 2 &&
        downloadIds.includes(firstId) &&
        downloadIds.includes(secondId) &&
        downloadOrigins.every((origin) => agentOrigins.has(origin)) &&
        downloadOrigins.every((origin) => !serviceOrigins.has(origin)),
      JSON.stringify({ downloadIds, downloadOrigins })
    );
    if (Array.isArray(downloadTargets)) {
      for (const downloadTarget of downloadTargets) {
        const downloadResponse = await request(downloadTarget.url, {
          headers: { "X-Transfer-Grant": downloadTarget.grant },
        });
        const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
        check(
          `direct download from agent ${downloadTarget.deviceId} is byte-for-byte identical`,
          downloadResponse.status === 200 && downloaded.equals(fileBody)
        );
      }
    }

    console.log("\nauthenticated web-route and LAN-topology acceptance passed");
  } finally {
    for (const agent of agents) agent.stopHeartbeat();
    for (const transferServer of transferServers) {
      await cleanupStep("closing agent transfer server", () =>
        closeServer(transferServer, "agent transfer server")
      );
    }
    await cleanupStep("stopping frontend process group", () => stopProcess(frontendProcess));
    await cleanupStep("stopping gateway process group", () => stopProcess(gatewayProcess));
    await cleanupStep("stopping auth process group", () => stopProcess(authProcess));
    await cleanupStep("closing SMTP capture server", () => smtpCapture?.close());
    await cleanupStep("closing auth database pool", () => authPool?.end());
    await cleanupStep("closing control-plane server", () => closeServer(controlPlaneServer, "control plane"));
    await cleanupStep("disconnecting control-plane MongoDB", async () => {
      await controlPlaneRequire("mongoose").disconnect();
    });
    await cleanupStep("stopping MongoMemoryServer", async () => {
      await mongo?.stop();
    });
    if (storageRoot) await cleanupStep("removing temporary storage", () => rm(storageRoot, { recursive: true, force: true }));

    if (databaseUrl) {
      await cleanupStep("closing control-plane database pool", async () => {
        const { closeDb } = controlPlaneRequire("./built/db/client.js");
        await closeDb();
      });
      await cleanupStep("dropping acceptance database", async () => {
        const admin = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
        await admin.connect();
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [dbName]
        );
        await admin.query(`drop database if exists "${dbName}"`);
        await admin.end();
      });
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} acceptance check(s) failed`);
  }
}

main()
  .then(() => {
    // Do not let a library-owned idle handle keep a successful acceptance job
    // alive after all services and temporary resources have been cleaned up.
    setTimeout(() => process.exit(0), 50);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    setTimeout(() => process.exit(1), 50);
  });
