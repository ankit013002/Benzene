#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBackup, restoreBackup } from "./metadata-backup.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const controlPlaneDirectory = join(repositoryRoot, "benzene-control-plane");
const controlPlaneRequire = createRequire(join(controlPlaneDirectory, "package.json"));
const { Client } = controlPlaneRequire("pg");
const mongoose = controlPlaneRequire("mongoose");

function localDatabaseUrl(value, variableName) {
  if (!value) throw new Error(`${variableName} is required`);
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!new Set(["localhost", "127.0.0.1", "::1"]).has(hostname)) {
    throw new Error(`${variableName} must point to a local isolated database service`);
  }
  return url;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function databaseUrl(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

async function withPostgresConnection(url, callback) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function withMongoConnection(uri, callback) {
  await mongoose.connect(uri);
  try {
    return await callback(mongoose.connection.db);
  } finally {
    await mongoose.disconnect();
  }
}

function postgresFixture(row) {
  return { id: row.id, ownerId: row.owner_id, name: row.name };
}

function mongoFixture(document) {
  return {
    id: document._id.toHexString(),
    ownerId: document.ownerId,
    version: document.version,
    status: document.status,
    metadata: document.meta,
  };
}

async function main() {
  const postgresAdminUrl = localDatabaseUrl(
    process.env["METADATA_REHEARSAL_POSTGRES_ADMIN_URL"],
    "METADATA_REHEARSAL_POSTGRES_ADMIN_URL",
  );
  const mongoAdminUrl = localDatabaseUrl(
    process.env["METADATA_REHEARSAL_MONGODB_ADMIN_URI"],
    "METADATA_REHEARSAL_MONGODB_ADMIN_URI",
  );
  const databaseName = `benzene_restore_rehearsal_${process.pid}_${randomBytes(5).toString("hex")}`;
  const postgresUrl = databaseUrl(postgresAdminUrl, databaseName);
  const mongoUri = databaseUrl(mongoAdminUrl, databaseName);
  const backupRoot = await mkdtemp(join(tmpdir(), "benzene-metadata-restore-rehearsal-"));
  const backupDirectory = join(backupRoot, "paired-backup");
  const adminClient = new Client({ connectionString: postgresAdminUrl.toString() });
  let postgresCreated = false;
  let mongoTouched = false;

  try {
    await adminClient.connect();
    // The generated name is restricted to lowercase letters, digits and underscores.
    await adminClient.query(`CREATE DATABASE "${databaseName}"`);
    postgresCreated = true;
    await adminClient.end();

    await run("npm", ["run", "db:migrate"], {
      cwd: controlPlaneDirectory,
      env: { ...process.env, DATABASE_URL: postgresUrl },
    });

    const expectedVault = await withPostgresConnection(postgresUrl, async (client) => {
      const result = await client.query(
        "INSERT INTO vaults (owner_id, name) VALUES ($1, $2) RETURNING id, owner_id, name",
        [`metadata-restore-${databaseName}`, "Pre-backup Vault"],
      );
      return postgresFixture(result.rows[0]);
    });

    const objectId = new mongoose.Types.ObjectId();
    const mongoDocument = {
      _id: objectId,
      ownerId: `metadata-restore-${databaseName}`,
      version: 1,
      bytes: 37,
      status: "committed",
      uploadedBy: "metadata-restore-rehearsal",
      isCurrent: true,
      meta: { marker: "pre-backup", contentDigest: digest({ bytes: "benzene-fixture" }) },
      uploadedAt: new Date("2026-01-02T03:04:05.000Z"),
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      updatedAt: new Date("2026-01-02T03:04:05.000Z"),
    };
    mongoTouched = true;
    await withMongoConnection(mongoUri, async (db) => {
      await db.collection("fileversions").insertOne(mongoDocument);
    });

    const expectedPostgresDigest = digest(expectedVault);
    const expectedMongoDigest = digest(mongoFixture(mongoDocument));
    const manifest = await createBackup({
      outputDirectory: backupDirectory,
      postgresUrl,
      mongoUri,
      confirmMaintenanceWindow: true,
    });
    assert.match(manifest.databases.postgresql.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.databases.mongodb.sha256, /^[a-f0-9]{64}$/);

    await withPostgresConnection(postgresUrl, async (client) => {
      await client.query("UPDATE vaults SET name = 'Post-backup mutation' WHERE id = $1", [expectedVault.id]);
    });
    await withMongoConnection(mongoUri, async (db) => {
      await db.collection("fileversions").updateOne(
        { _id: objectId },
        { $set: { "meta.marker": "post-backup mutation" } },
      );
    });

    await restoreBackup({
      backupDirectory,
      postgresUrl,
      mongoUri,
      confirmMaintenanceWindow: true,
      confirmReplaceTargets: `${databaseName},${databaseName}`,
    });

    const restoredVault = await withPostgresConnection(postgresUrl, async (client) => {
      const result = await client.query(
        "SELECT id, owner_id, name FROM vaults WHERE id = $1",
        [expectedVault.id],
      );
      assert.equal(result.rowCount, 1, "PostgreSQL Vault record should be restored");
      return postgresFixture(result.rows[0]);
    });
    const restoredMongoDocument = await withMongoConnection(mongoUri, async (db) => {
      const result = await db.collection("fileversions").findOne({ _id: objectId });
      assert.ok(result, "MongoDB file-version metadata should be restored");
      return result;
    });

    assert.equal(digest(restoredVault), expectedPostgresDigest, "restored PostgreSQL metadata should match its pre-backup checksum");
    assert.equal(digest(mongoFixture(restoredMongoDocument)), expectedMongoDigest, "restored MongoDB metadata should match its pre-backup checksum");
    assert.equal(restoredVault.name, "Pre-backup Vault");
    assert.equal(restoredMongoDocument.meta.marker, "pre-backup");
    console.log(`Paired PostgreSQL + MongoDB restore rehearsal passed for ${databaseName}`);
  } finally {
    await adminClient.end().catch(() => undefined);
    try {
      if (postgresCreated) {
        const cleanupClient = new Client({ connectionString: postgresAdminUrl.toString() });
        await cleanupClient.connect();
        try {
          await cleanupClient.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        } finally {
          await cleanupClient.end();
        }
      }
    } finally {
      try {
        if (mongoTouched) {
          await withMongoConnection(mongoUri, async (db) => db.dropDatabase());
        }
      } finally {
        await rm(backupRoot, { recursive: true, force: true });
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
