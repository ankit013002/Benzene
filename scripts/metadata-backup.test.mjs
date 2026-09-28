import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackup, restoreBackup } from "./metadata-backup.mjs";

const postgresUrl = "postgres://user:pass@localhost:5432/benzene";
const mongoUri = "mongodb://localhost:27017/benzene";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "benzene-metadata-backup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function backup(t) {
  const root = await temporaryDirectory(t);
  const outputDirectory = join(root, "backup");
  const calls = [];
  await createBackup({
    outputDirectory,
    postgresUrl,
    mongoUri,
    confirmMaintenanceWindow: true,
    commandRunner: async (command, args) => {
      calls.push({ command, args });
      const path = command === "pg_dump" ? args[args.indexOf("--file") + 1] : args.find((arg) => arg.startsWith("--archive=")).slice("--archive=".length);
      await writeFile(path, `${command} fixture`);
    },
  });
  return { outputDirectory, calls };
}

test("creates a paired, checksummed archive only after maintenance is confirmed", async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(
    createBackup({ outputDirectory: join(root, "backup"), postgresUrl, mongoUri, confirmMaintenanceWindow: false }),
    /confirm-maintenance-window/,
  );
  const { outputDirectory, calls } = await backup(t);
  assert.deepEqual(calls.map(({ command }) => command), ["pg_dump", "mongodump"]);
  assert.deepEqual(calls[0].args.slice(0, 4), ["--format=custom", "--no-owner", "--no-acl", "--file"]);
  assert.match(calls[0].args[4], /postgres\.dump$/);
  const manifest = JSON.parse(await readFile(join(outputDirectory, "benzene-metadata-backup.json"), "utf8"));
  assert.equal(manifest.databases.postgresql.name, "benzene");
  assert.equal(manifest.databases.mongodb.name, "benzene");
  assert.match(manifest.databases.postgresql.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.databases.mongodb.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.consistency, "offline-maintenance-window");
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(outputDirectory, "postgres.dump"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(outputDirectory, "mongodb.archive.gz"))).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(outputDirectory, "benzene-metadata-backup.json"))).mode & 0o777,
    0o600
  );
});

test("removes a partial archive when either dump command fails", async (t) => {
  const root = await temporaryDirectory(t);
  await assert.rejects(
    createBackup({
      outputDirectory: join(root, "backup"),
      postgresUrl,
      mongoUri,
      confirmMaintenanceWindow: true,
      commandRunner: async () => {
        throw new Error("dump failed");
      },
    }),
    /dump failed/
  );
  assert.deepEqual(await readdir(root), []);
});

test("refuses restore unless exact target databases and maintenance window are acknowledged", async (t) => {
  const { outputDirectory } = await backup(t);
  const calls = [];
  const commandRunner = async (...args) => calls.push(args);
  await assert.rejects(restoreBackup({ backupDirectory: outputDirectory, postgresUrl, mongoUri, confirmMaintenanceWindow: false, confirmReplaceTargets: "benzene,benzene", commandRunner }), /confirm-maintenance-window/);
  await assert.rejects(restoreBackup({ backupDirectory: outputDirectory, postgresUrl, mongoUri, confirmMaintenanceWindow: true, confirmReplaceTargets: "other,benzene", commandRunner }), /confirm-replace-targets=benzene,benzene/);
  assert.equal(calls.length, 0);
});

test("verifies both archives before running either destructive restore command", async (t) => {
  const { outputDirectory } = await backup(t);
  await writeFile(join(outputDirectory, "mongodb.archive.gz"), "corrupt archive");
  const calls = [];
  await assert.rejects(
    restoreBackup({
      backupDirectory: outputDirectory,
      postgresUrl,
      mongoUri,
      confirmMaintenanceWindow: true,
      confirmReplaceTargets: "benzene,benzene",
      commandRunner: async (...args) => calls.push(args),
    }),
    /mongodb backup checksum/,
  );
  assert.equal(calls.length, 0);
});

test("restores only matching database names and invokes both native restore tools", async (t) => {
  const { outputDirectory } = await backup(t);
  const calls = [];
  await assert.rejects(
    restoreBackup({
      backupDirectory: outputDirectory,
      postgresUrl: "postgres://localhost/other",
      mongoUri,
      confirmMaintenanceWindow: true,
      confirmReplaceTargets: "other,benzene",
      commandRunner: async (...args) => calls.push(args),
    }),
    /backup contains benzene,benzene; targets are other,benzene/,
  );
  assert.equal(calls.length, 0);

  await restoreBackup({
    backupDirectory: outputDirectory,
    postgresUrl,
    mongoUri,
    confirmMaintenanceWindow: true,
    confirmReplaceTargets: "benzene,benzene",
    commandRunner: async (command, args) => calls.push({ command, args }),
  });
  assert.deepEqual(calls.map(({ command }) => command), ["pg_restore", "mongorestore"]);
  assert.ok(calls[0].args.includes("--clean"));
  assert.ok(calls[1].args.includes("--drop"));
});
