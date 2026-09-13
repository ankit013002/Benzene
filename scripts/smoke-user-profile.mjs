/**
 * User-profile acceptance test.
 *
 * Starts the real auth service, Java gateway, Java user service and built
 * Next.js frontend. It signs up a fresh user through the Next route, then
 * proves that the session can bootstrap and read the persisted profile both
 * through the gateway and through the Next same-origin bridges.
 *
 * Run from the repository root after building the frontend and packaging the
 * Java services:
 *   node scripts/smoke-user-profile.mjs
 *
 * Requires a reachable PostgreSQL. Set SMOKE_DATABASE_URL to override.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const authDir = path.join(repoRoot, "benzene-auth-service");
const gatewayDir = path.join(repoRoot, "nebula-gateway");
const userServiceDir = path.join(repoRoot, "nebulavault-user-service");
const frontendDir = path.join(repoRoot, "nebulavault-frontend");
const authRequire = createRequire(
  new URL("../benzene-auth-service/package.json", import.meta.url),
);

const AUTH_SECRET =
  process.env.SMOKE_AUTH_SECRET ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const AUTH_PORT = Number.parseInt(process.env.SMOKE_USER_AUTH_PORT ?? "14100", 10);
const GATEWAY_PORT = Number.parseInt(
  process.env.SMOKE_USER_GATEWAY_PORT ?? "18180",
  10,
);
const USER_SERVICE_PORT = Number.parseInt(
  process.env.SMOKE_USER_SERVICE_PORT ?? "18082",
  10,
);
const FRONTEND_PORT = Number.parseInt(
  process.env.SMOKE_USER_FRONTEND_PORT ?? "13100",
  10,
);
const LOGIN_EMAIL = `profile-acceptance-${process.pid}@example.com`;
const LOGIN_PASSWORD = "profile-acceptance-password-123";
const REQUEST_TIMEOUT_MS = 15_000;

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
  child.getOutput = () => output.slice(-5000);
  return child;
}

function signalProcess(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try {
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
  const deadline = Date.now() + 90_000;
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
  return responseSetCookies(response)
    .map((cookie) => cookie.split(";", 1)[0].trim())
    .filter((cookie) => cookie.includes("="));
}

function cookieHeader(cookies) {
  return cookies.join("; ");
}

function startSmtpCapture() {
  const server = createNetServer();
  let messageReceived = false;
  let messageWaiter;
  server.on("connection", (socket) => {
    let data = "";
    let inMessage = false;
    socket.setEncoding("utf8");
    socket.write("220 benzene acceptance SMTP\r\n");
    socket.on("data", (chunk) => {
      data += chunk;
      while (true) {
        const boundary = data.indexOf("\r\n");
        if (boundary < 0) break;
        const line = data.slice(0, boundary);
        data = data.slice(boundary + 2);
        if (inMessage) {
          if (line === ".") {
            inMessage = false;
            messageReceived = true;
            messageWaiter?.();
            messageWaiter = undefined;
            socket.write("250 2.0.0 accepted\r\n");
          }
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) {
          socket.write("250-benzene\r\n250 OK\r\n");
        } else if (command.startsWith("MAIL FROM") || command.startsWith("RCPT TO")) {
          socket.write("250 OK\r\n");
        } else if (command === "DATA") {
          inMessage = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (command === "QUIT") {
          socket.write("221 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("SMTP server did not expose a TCP address"));
        return;
      }
      resolve({
        port: address.port,
        hasMessage: () => messageReceived,
        waitForMessage: () =>
          messageReceived
            ? Promise.resolve()
            : new Promise((done) => {
                messageWaiter = done;
              }),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function jdbcUrl(baseUrl, databaseName) {
  const parsed = new URL(baseUrl);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const credentials = new URLSearchParams({ user, password });
  return `jdbc:postgresql://${parsed.hostname}:${parsed.port || "5432"}/${databaseName}?${credentials}`;
}

async function cleanupStep(label, action) {
  console.log(`cleanup: ${label}`);
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cleanup deadline exceeded")), 5_000),
      ),
    ]);
  } catch (error) {
    console.warn(`cleanup warning (${label}): ${error}`);
  }
}

async function main() {
  const baseUrl =
    process.env.SMOKE_DATABASE_URL ??
    "postgres://postgres@127.0.0.1:55432/postgres";
  const { Client, Pool } = authRequire("pg");
  const databaseName = `benzene_user_profile_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  let databaseUrl;
  let admin;
  let pool;
  let smtp;
  let authProcess;
  let gatewayProcess;
  let userServiceProcess;
  let frontendProcess;

  try {
    admin = new Client({
      connectionString: baseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    await admin.end();
    admin = undefined;

    const database = new URL(baseUrl);
    database.pathname = `/${databaseName}`;
    databaseUrl = database.toString();
    pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    await pool.query(
      await readFile(path.join(authDir, "src/db/migrations/001_initial.sql"), "utf8"),
    );
    await pool.query(
      await readFile(
        path.join(userServiceDir, "src/main/resources/schema.sql"),
        "utf8",
      ),
    );

    smtp = await startSmtpCapture();
    const authUrl = `http://127.0.0.1:${AUTH_PORT}`;
    const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`;
    const userServiceUrl = `http://127.0.0.1:${USER_SERVICE_PORT}`;
    const frontendUrl = `http://127.0.0.1:${FRONTEND_PORT}`;

    authProcess = startProcess(
      "npm",
      ["run", "start"],
      authDir,
      {
        AUTH_SECRET,
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
        PORT: String(AUTH_PORT),
        APP_ORIGIN: frontendUrl,
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.port),
        SMTP_SECURE: "false",
      },
    );
    await waitForHttp(`${authUrl}/api/health`, authProcess, "auth service");
    console.log(`auth service listening on ${authUrl}`);

    userServiceProcess = startProcess(
      "java",
      ["-jar", path.join(userServiceDir, "target/user-service-0.0.1-SNAPSHOT.jar")],
      userServiceDir,
      {
        DB_URL: jdbcUrl(baseUrl, databaseName),
        SERVER_PORT: String(USER_SERVICE_PORT),
      },
    );
    await waitForHttp(`${userServiceUrl}/user/me`, userServiceProcess, "user service");
    console.log(`user service listening on ${userServiceUrl}`);

    gatewayProcess = startProcess(
      "java",
      ["-jar", path.join(gatewayDir, "target/nebula-gateway-0.0.1-SNAPSHOT.jar")],
      gatewayDir,
      {
        AUTH_SECRET,
        AUTH_SERVICE_URI: authUrl,
        USER_SERVICE_URI: userServiceUrl,
        SERVER_PORT: String(GATEWAY_PORT),
      },
    );
    await waitForHttp(
      `${gatewayUrl}/actuator/health`,
      gatewayProcess,
      "Java gateway",
    );
    console.log(`gateway listening on ${gatewayUrl}`);

    frontendProcess = startProcess(
      "npm",
      ["run", "start"],
      frontendDir,
      {
        APP_BASE_URL: frontendUrl,
        AUTH_SECRET,
        GATEWAY_ORIGIN: gatewayUrl,
        NEXT_PUBLIC_GATEWAY_ORIGIN: gatewayUrl,
        HOSTNAME: "127.0.0.1",
        PORT: String(FRONTEND_PORT),
      },
    );
    await waitForHttp(`${frontendUrl}/login`, frontendProcess, "Next.js frontend");
    console.log(`frontend listening on ${frontendUrl}`);

    console.log("\nsign up through Next.js and capture the real verification email");
    const signupResponse = await request(`${frontendUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
    const signupBody = await jsonOrNull(signupResponse);
    const signupCookies = responseCookies(signupResponse);
    check(
      "fresh signup returned an authenticated unverified account",
      signupResponse.status === 201 && signupBody?.ok === true && signupBody?.emailVerified === false,
      JSON.stringify(signupBody),
    );
    check(
      "fresh signup forwarded both httpOnly session cookies",
      ["session", "refresh_token"].every((name) =>
        responseSetCookies(signupResponse).some(
          (cookie) =>
            cookie.trimStart().startsWith(`${name}=`) &&
            /;\s*HttpOnly(?:;|$)/i.test(cookie) &&
            !/;\s*Secure(?:;|$)/i.test(cookie),
        ),
      ),
    );
    await Promise.race([
      smtp.waitForMessage(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SMTP capture timed out")), REQUEST_TIMEOUT_MS),
      ),
    ]).catch((error) => {
      check("signup delivered the verification email", false, error.message);
    });
    if (smtp.hasMessage()) check("signup delivered the verification email", true);
    const cookies = cookieHeader(signupCookies);

    const credential = await pool.query(
      "select id from credentials where email = $1",
      [LOGIN_EMAIL],
    );
    const credentialId = credential.rows[0]?.id;
    check("signup persisted the auth subject", typeof credentialId === "string");

    const beforeBootstrap = await request(`${gatewayUrl}/user/me`, {
      headers: { cookie: cookies },
    });
    check("gateway reported no profile before bootstrap", beforeBootstrap.status === 404);
    await beforeBootstrap.body?.cancel();

    console.log("\nbootstrap and read the profile through the Next bridges");
    const bootstrapResponse = await request(
      `${frontendUrl}/api/dev-proxy/user/bootstrap`,
      {
        method: "POST",
        headers: { cookie: cookies, "content-type": "application/json" },
      },
    );
    const bootstrapBody = await jsonOrNull(bootstrapResponse);
    check(
      "Next bootstrap bridge returned the persisted profile",
      bootstrapResponse.status === 200 &&
        bootstrapBody?.email === LOGIN_EMAIL &&
        bootstrapBody?.id,
      JSON.stringify(bootstrapBody),
    );
    check(
      "profile defaults are owned by the user service",
      bootstrapBody?.plan === "STARTER" &&
        bootstrapBody?.quotaBytes === 104857600 &&
        bootstrapBody?.usedBytes === 0,
      JSON.stringify(bootstrapBody),
    );

    const gatewayMeResponse = await request(`${gatewayUrl}/user/me`, {
      headers: { cookie: cookies },
    });
    const gatewayMe = await jsonOrNull(gatewayMeResponse);
    check(
      "gateway profile read returned the same user",
      gatewayMeResponse.status === 200 &&
        gatewayMe?.id === bootstrapBody?.id &&
        gatewayMe?.email === LOGIN_EMAIL,
      JSON.stringify(gatewayMe),
    );

    const nextMeResponse = await request(`${frontendUrl}/api/dev-proxy/user/me`, {
      headers: { cookie: cookies },
    });
    const nextMe = await jsonOrNull(nextMeResponse);
    check(
      "Next profile read bridge returned the same user",
      nextMeResponse.status === 200 &&
        nextMe?.id === bootstrapBody?.id &&
        nextMe?.email === LOGIN_EMAIL,
      JSON.stringify(nextMe),
    );

    const storedProfile = await pool.query(
      "select auth_sub, email, plan, quota_bytes, used_bytes from users where auth_sub = $1",
      [credentialId],
    );
    const row = storedProfile.rows[0];
    check(
      "user service persisted the profile against the auth subject",
      row?.auth_sub === credentialId &&
        row.email === LOGIN_EMAIL &&
        row.plan === "STARTER" &&
        Number(row.quota_bytes) === 104857600 &&
        Number(row.used_bytes) === 0,
      JSON.stringify(row),
    );

    const anonymousResponse = await request(`${frontendUrl}/api/dev-proxy/user/me`);
    check("Next profile bridge rejects anonymous requests", anonymousResponse.status === 401);
    await anonymousResponse.body?.cancel();
    const anonymousGatewayResponse = await request(`${gatewayUrl}/user/me`);
    check("gateway profile route rejects anonymous requests", anonymousGatewayResponse.status === 401);
    await anonymousGatewayResponse.body?.cancel();

    if (failures > 0) throw new Error(`${failures} acceptance check(s) failed`);
    console.log("\nuser-profile acceptance passed");
  } finally {
    await cleanupStep("stopping frontend", () => stopProcess(frontendProcess));
    await cleanupStep("stopping gateway", () => stopProcess(gatewayProcess));
    await cleanupStep("stopping user service", () => stopProcess(userServiceProcess));
    await cleanupStep("stopping auth service", () => stopProcess(authProcess));
    await cleanupStep("closing SMTP capture", () => smtp?.close());
    await cleanupStep("closing database pool", () => pool?.end());
    if (admin) await cleanupStep("closing admin database client", () => admin.end());
    if (databaseUrl) {
      await cleanupStep("dropping acceptance database", async () => {
        const cleanupClient = new Client({
          connectionString: baseUrl,
          connectionTimeoutMillis: 5_000,
          query_timeout: 5_000,
        });
        await cleanupClient.connect();
        await cleanupClient.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [databaseName],
        );
        await cleanupClient.query(`drop database if exists "${databaseName}"`);
        await cleanupClient.end();
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
