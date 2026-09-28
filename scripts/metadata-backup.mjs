#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MANIFEST_NAME = "benzene-metadata-backup.json";
const MANIFEST_VERSION = 1;

function databaseName(connectionString, label) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name) throw new Error(`${label} must include a database name in its URL path`);
  return name;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function requiredConnection(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function createBackup({ outputDirectory, postgresUrl, mongoUri, confirmMaintenanceWindow, commandRunner = run }) {
  if (!confirmMaintenanceWindow) {
    throw new Error("backup requires --confirm-maintenance-window after both services and writers are stopped");
  }
  const pgName = databaseName(requiredConnection(postgresUrl, "DATABASE_URL"), "DATABASE_URL");
  const mongoName = databaseName(requiredConnection(mongoUri, "MONGOOSE_URI"), "MONGOOSE_URI");
  if (!outputDirectory) throw new Error("--output is required");

  const destination = resolve(outputDirectory);
  const parent = dirname(destination);
  if (basename(destination) === destination) throw new Error("--output must name a new backup directory, not a filesystem root");
  await mkdir(parent, { recursive: true });
  try {
    await stat(destination);
    throw new Error(`backup destination already exists: ${destination}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
    if (error instanceof Error && error.message.startsWith("backup destination already exists:")) throw error;
  }

  const staging = join(
    parent,
    `.${basename(destination)}.partial-${process.pid}-${randomBytes(6).toString("hex")}`
  );
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const postgresFile = join(staging, "postgres.dump");
    const mongoFile = join(staging, "mongodb.archive.gz");
    await commandRunner("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", postgresFile, postgresUrl]);
    await commandRunner("mongodump", ["--uri", mongoUri, "--db", mongoName, `--archive=${mongoFile}`, "--gzip"]);
    await chmod(postgresFile, 0o600);
    await chmod(mongoFile, 0o600);
    const manifest = {
      format: "benzene-metadata-backup",
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      consistency: "offline-maintenance-window",
      databases: {
        postgresql: { name: pgName, file: "postgres.dump", sha256: await sha256File(postgresFile) },
        mongodb: { name: mongoName, file: "mongodb.archive.gz", sha256: await sha256File(mongoFile) },
      },
    };
    await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(staging, destination);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readAndVerifyBackup(backupDirectory) {
  const directory = resolve(backupDirectory);
  const manifest = JSON.parse(await readFile(join(directory, MANIFEST_NAME), "utf8"));
  if (manifest.format !== "benzene-metadata-backup" || manifest.version !== MANIFEST_VERSION || manifest.consistency !== "offline-maintenance-window") {
    throw new Error("unsupported or invalid Benzene metadata backup manifest");
  }
  for (const [key, expectedFile] of [["postgresql", "postgres.dump"], ["mongodb", "mongodb.archive.gz"]]) {
    const record = manifest.databases?.[key];
    if (!record || record.file !== expectedFile || !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")) {
      throw new Error(`backup manifest is missing valid ${key} metadata`);
    }
    const actualHash = await sha256File(join(directory, expectedFile));
    if (actualHash !== record.sha256) throw new Error(`${key} backup checksum does not match the manifest`);
  }
  return { directory, manifest };
}

export async function restoreBackup({ backupDirectory, postgresUrl, mongoUri, confirmMaintenanceWindow, confirmReplaceTargets, commandRunner = run }) {
  if (!confirmMaintenanceWindow) {
    throw new Error("restore requires --confirm-maintenance-window after services and writers are stopped");
  }
  if (!backupDirectory) throw new Error("--from is required");
  const pgUrl = requiredConnection(postgresUrl, "DATABASE_URL");
  const mongo = requiredConnection(mongoUri, "MONGOOSE_URI");
  const pgName = databaseName(pgUrl, "DATABASE_URL");
  const mongoName = databaseName(mongo, "MONGOOSE_URI");
  const expectedTargets = `${pgName},${mongoName}`;
  if (confirmReplaceTargets !== expectedTargets) {
    throw new Error(`restore requires --confirm-replace-targets=${expectedTargets} to acknowledge the exact PostgreSQL,MongoDB databases`);
  }
  const { directory, manifest } = await readAndVerifyBackup(backupDirectory);
  if (manifest.databases.postgresql.name !== pgName || manifest.databases.mongodb.name !== mongoName) {
    throw new Error(`backup contains ${manifest.databases.postgresql.name},${manifest.databases.mongodb.name}; targets are ${expectedTargets}`);
  }

  await commandRunner("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", pgUrl, join(directory, "postgres.dump")]);
  await commandRunner("mongorestore", ["--uri", mongo, "--db", mongoName, "--drop", "--gzip", `--archive=${join(directory, "mongodb.archive.gz")}`]);
  return manifest;
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const equalsIndex = item.indexOf("=");
    if (equalsIndex >= 0) options.set(item.slice(2, equalsIndex), item.slice(equalsIndex + 1));
    else if (["confirm-maintenance-window"].includes(item.slice(2))) options.set(item.slice(2), "true");
    else {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${item} requires a value`);
      options.set(item.slice(2), value);
      index += 1;
    }
  }
  return { command, options };
}

async function main(args) {
  const { command, options } = parseArgs(args);
  const postgresUrl = process.env["DATABASE_URL"];
  const mongoUri = process.env["MONGOOSE_URI"];
  const common = { postgresUrl, mongoUri, confirmMaintenanceWindow: options.get("confirm-maintenance-window") === "true" };
  if (command === "backup") {
    const manifest = await createBackup({ ...common, outputDirectory: options.get("output") });
    process.stdout.write(`Backup created at ${resolve(options.get("output"))}\n`);
    process.stdout.write(`Databases: ${manifest.databases.postgresql.name}, ${manifest.databases.mongodb.name}\n`);
    return;
  }
  if (command === "restore") {
    const manifest = await restoreBackup({
      ...common,
      backupDirectory: options.get("from"),
      confirmReplaceTargets: options.get("confirm-replace-targets"),
    });
    process.stdout.write(`Restored databases: ${manifest.databases.postgresql.name}, ${manifest.databases.mongodb.name}\n`);
    return;
  }
  throw new Error("usage: metadata-backup.mjs backup --output DIR --confirm-maintenance-window | restore --from DIR --confirm-maintenance-window --confirm-replace-targets=PGDB,MONGODBDB");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
