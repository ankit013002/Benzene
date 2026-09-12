/**
 * Cross-service authentication acceptance test.
 *
 * This starts the real auth service, Java gateway, control-plane app and
 * Next.js frontend. It seeds one bcrypt credential (signup sends email through
 * SMTP, which is not a dependency of this boundary test), logs in through the
 * frontend proxy, and proves that a session reaches a user-facing
 * control-plane route with gateway-owned identity headers. Requests without a
 * session are refused at both the gateway and browser-facing frontend.
 *
 * The direct gateway request with spoofed headers remains intentional: it
 * isolates the gateway's identity-header stripping from the frontend proxy.
 *
 * Run from the repository root after building the control plane and frontend:
 *   node scripts/smoke-auth-gateway.mjs
 *
 * Requires a reachable PostgreSQL. Set SMOKE_DATABASE_URL to override.
 */
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const controlPlaneDir = path.join(repoRoot, "benzene-control-plane");
const authDir = path.join(repoRoot, "benzene-auth-service");
const gatewayDir = path.join(repoRoot, "nebula-gateway");
const frontendDir = path.join(repoRoot, "nebulavault-frontend");

const controlPlaneRequire = createRequire(
  new URL("../benzene-control-plane/package.json", import.meta.url)
);
const authRequire = createRequire(
  new URL("../benzene-auth-service/package.json", import.meta.url)
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

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
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
      const response = await fetch(url);
      if (response.status < 500) return response;
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

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
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
  let storageRoot;

  try {
    const admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    await admin.end();

    const dbUrl = new URL(baseUrl);
    dbUrl.pathname = `/${dbName}`;
    databaseUrl = dbUrl.toString();

    const authPool = new Pool({ connectionString: databaseUrl });
    let credentialId;
    try {
      const authMigration = await readFile(
        path.join(authDir, "src/db/migrations/001_initial.sql"),
        "utf8"
      );
      await authPool.query(authMigration);

      const bcrypt = authRequire("bcrypt");
      const passwordHash = await bcrypt.hash(LOGIN_PASSWORD, 4);
      const credential = await authPool.query(
        `insert into credentials (email, password_hash, email_verified)
         values ($1, $2, true) returning id`,
        [LOGIN_EMAIL, passwordHash]
      );
      credentialId = credential.rows[0]?.id;
    } finally {
      await authPool.end();
    }
    check("acceptance credential was seeded", typeof credentialId === "string");

    process.env.DATABASE_URL = databaseUrl;
    process.env.MONGOOSE_URI = "mongodb://127.0.0.1:27017/benzene-acceptance-unused";
    process.env.STORAGE_DRIVER = "local";
    process.env.DEVICE_OFFLINE_AFTER_SECONDS = "120";
    process.env.DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS = "86400";
    storageRoot = await mkdtemp(path.join(tmpdir(), "benzene-auth-gateway-"));
    process.env.LOCAL_STORAGE_DIR = path.join(storageRoot, "control-plane");

    const { drizzle } = controlPlaneRequire("drizzle-orm/node-postgres");
    const { migrate } = controlPlaneRequire("drizzle-orm/node-postgres/migrator");
    const migrationPool = new Pool({ connectionString: databaseUrl });
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

    authProcess = startProcess(
      "npm",
      ["run", "start"],
      authDir,
      {
        AUTH_SECRET,
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
        PORT: String(AUTH_PORT),
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
    const frontendUrl = `http://127.0.0.1:${FRONTEND_PORT}`;
    console.log(`frontend listening on ${frontendUrl}`);

    console.log("\nlogin through the Next.js frontend proxy");
    const loginResponse = await fetch(`${frontendUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
    const loginBody = await jsonOrNull(loginResponse);
    const rawCookies = responseSetCookies(loginResponse);
    const cookies = responseCookies(loginResponse);
    const session = cookieValue(cookies, "session");
    const claims = decodeJwtPayload(session);
    check("frontend proxy forwarded a successful real password login", loginResponse.status === 200, JSON.stringify(loginBody));
    check(
      "frontend forwarded an httpOnly session cookie",
      typeof session === "string" &&
        session.length > 0 &&
        rawCookies.some((cookie) => /^\s*session=/.test(cookie) && /;\s*HttpOnly(?:;|$)/i.test(cookie))
    );
    check("frontend session JWT identifies the seeded credential", claims?.sub === credentialId);
    check("frontend session JWT carries the login email", claims?.email === LOGIN_EMAIL);

    const cookieHeader = cookies.join("; ");
    const browserVaultResponse = await fetch(`${frontendUrl}/api/vault`, {
      headers: { Cookie: cookieHeader },
    });
    const browserVaultBody = await jsonOrNull(browserVaultResponse);
    const vaultId = browserVaultBody?.data?.id;
    check("frontend proxy reached the real control plane", browserVaultResponse.status === 200, JSON.stringify(browserVaultBody));
    check("frontend returned a vault for the authenticated user", typeof vaultId === "string");

    const spoofedResponse = await fetch(`${gatewayUrl}/vaults/me`, {
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

    const gatewayAnonymousResponse = await fetch(`${gatewayUrl}/vaults/me`);
    check("direct gateway anonymous request is refused", gatewayAnonymousResponse.status === 401, `status ${gatewayAnonymousResponse.status}`);

    const frontendAnonymousResponse = await fetch(`${frontendUrl}/api/vault`, {
      redirect: "manual",
    });
    const frontendRedirect = frontendAnonymousResponse.headers.get("location") ?? "";
    check(
      "browser-facing anonymous request is redirected without following it",
      frontendAnonymousResponse.status >= 300 && frontendAnonymousResponse.status < 400 &&
        new URL(frontendRedirect, frontendUrl).pathname === "/login",
      `status ${frontendAnonymousResponse.status}, location ${frontendRedirect || "missing"}`
    );

    console.log("\nfrontend proxy, gateway identity boundary and control-plane request passed");
  } finally {
    await stopProcess(frontendProcess);
    await stopProcess(gatewayProcess);
    await stopProcess(authProcess);
    await closeServer(controlPlaneServer);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });

    if (databaseUrl) {
      try {
        const { closeDb } = controlPlaneRequire("./built/db/client.js");
        await closeDb();
      } catch {
        // The assertion output is more useful than masking its failure with
        // cleanup noise when the control-plane module never initialized.
      }
      try {
        const admin = new Client({ connectionString: baseUrl });
        await admin.connect();
        await admin.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [dbName]
        );
        await admin.query(`drop database if exists "${dbName}"`);
        await admin.end();
      } catch (error) {
        console.warn(`could not drop acceptance database ${dbName}: ${error}`);
      }
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} acceptance check(s) failed`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
