import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(serviceRoot, "dist");

// A build must not retain files emitted by an earlier development typecheck.
await rm(distDirectory, { force: true, recursive: true });
