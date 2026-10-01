#!/usr/bin/env -S npx tsx

/**
 * Receives one real, control-plane-authorized encrypted GET through the public
 * relay. The producer remains the enrolled node agent polling its normal
 * signed /agent/relay-read queue. The fallback JSON is a short-lived bearer
 * capability; keep it mode 0600, never paste it into a command, and delete it
 * after use.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

import * as nodeRelayScopeModule from "../../benzene-node-agent/src/relayScope.js";
import * as mobileRelayModule from "../../benzene-mobile/src/files/relayCiphertext.js";
import * as mobileLimitsModule from "../../benzene-mobile/src/files/limits.js";
import type { RelayFallbackResponse, RelaySocketLike } from "../../benzene-mobile/src/files/relayCiphertext.js";
import { validateRelayPublicUrl, verifyRelayDeployment } from "../../scripts/verify-relay-deployment.mjs";

const MAX_INPUT_BYTES = 16 * 1024;
const RECEIVE_TIMEOUT_MS = 120_000;
type NodeRelayScopeApi = typeof import("../../benzene-node-agent/src/relayScope.js");
const nodeRelayScope = (("default" in nodeRelayScopeModule ? nodeRelayScopeModule.default : nodeRelayScopeModule) as unknown) as NodeRelayScopeApi;
const { verifyRelayScope } = nodeRelayScope;
type MobileRelayApi = typeof import("../../benzene-mobile/src/files/relayCiphertext.js");
const mobileRelay = (("default" in mobileRelayModule ? mobileRelayModule.default : mobileRelayModule) as unknown) as MobileRelayApi;
const mobileLimits = (("default" in mobileLimitsModule ? mobileLimitsModule.default : mobileLimitsModule) as unknown) as typeof import("../../benzene-mobile/src/files/limits.js");
const { receiveRelayCiphertext } = mobileRelay;
const { MAX_ENCRYPTED_FILE_BYTES } = mobileLimits;

export function validateRemoteRelayInput(
  value: unknown,
  controlPlanePublicKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): RelayFallbackResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Fallback input must be a JSON object.");
  }
  const envelope = value as Record<string, unknown>;
  const input = Object.keys(envelope).length === 1 && "data" in envelope && envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : envelope;
  const keys = Object.keys(input).sort();
  const expectedKeys = ["ciphertextBytes", "expiresAt", "kind", "relayUrl", "sessionId", "storageHash", "ticket"].sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
    || input.kind !== "relay_fallback"
    || typeof input.relayUrl !== "string"
    || typeof input.sessionId !== "string"
    || typeof input.ticket !== "string"
    || typeof input.storageHash !== "string"
    || !/^[a-f0-9]{64}$/.test(input.storageHash)
    || typeof input.ciphertextBytes !== "number"
    || !Number.isSafeInteger(input.ciphertextBytes)
    || input.ciphertextBytes < 16
    || input.ciphertextBytes > MAX_ENCRYPTED_FILE_BYTES + 16
    || typeof input.expiresAt !== "string"
    || !Number.isFinite(Date.parse(input.expiresAt))
    || new Date(input.expiresAt).toISOString() !== input.expiresAt) {
    throw new Error("Fallback input is malformed or exceeds the encrypted transfer limit.");
  }

  const relayOrigin = validateRelayPublicUrl(input.relayUrl);
  if (input.ticket.length > 8192) throw new Error("Fallback ticket exceeds the contract limit.");
  const verified = verifyRelayScope({ token: input.ticket, controlPlanePublicKey, now: nowSeconds });
  if (!verified.ok) throw new Error("Fallback ticket signature or scope is invalid.");
  const scope = verified.scope;
  if (scope.role !== "client" || scope.op !== "get"
    || scope.sessionId !== input.sessionId
    || scope.storageHash !== input.storageHash
    || scope.maxBytes !== input.ciphertextBytes
    || Date.parse(input.expiresAt) !== scope.exp * 1000) {
    throw new Error("Fallback ticket does not authorize this exact encrypted object and session.");
  }
  // Canonicalize before handing this to the mobile receive helper. The URL
  // validator also rejects local, private and placeholder destinations.
  return {
    kind: "relay_fallback",
    relayUrl: relayOrigin.origin,
    sessionId: scope.sessionId,
    ticket: input.ticket,
    storageHash: scope.storageHash,
    ciphertextBytes: scope.maxBytes,
    expiresAt: new Date(scope.exp * 1000).toISOString(),
  };
}

async function readProtectedFallback(filePath: string): Promise<unknown> {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("Fallback input could not be opened safely; use a regular non-symlink file.");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 2 || info.size > MAX_INPUT_BYTES) {
      throw new Error("Fallback input must be a small regular file.");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Fallback input permissions are too broad; run chmod 600 on the file first.");
    }
    try {
      return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
    } catch {
      throw new Error("Fallback input is not valid JSON.");
    }
  } finally {
    await file.close();
  }
}

async function writeCiphertextExclusively(filePath: string, bytes: Uint8Array): Promise<void> {
  const output = await open(filePath, "wx", 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } catch (error) {
    await output.close();
    throw error;
  }
  await output.close();
}

export async function acceptRemoteRelay(input: {
  fallback: unknown;
  controlPlanePublicKey: string;
  outputPath: string;
  verifyDeployment?: typeof verifyRelayDeployment;
  receive?: typeof receiveRelayCiphertext;
}): Promise<{ storageHash: string; ciphertextBytes: number }> {
  const fallback = validateRemoteRelayInput(input.fallback, input.controlPlanePublicKey);
  const verifyDeployment = input.verifyDeployment ?? verifyRelayDeployment;
  const receiveCiphertext = input.receive ?? receiveRelayCiphertext;
  await verifyDeployment(fallback.relayUrl, { WebSocketImpl: WebSocket });
  const ciphertext = await receiveCiphertext({
    fallback,
    expectedStorageHash: fallback.storageHash,
    expectedCiphertextBytes: fallback.ciphertextBytes,
    timeoutMs: RECEIVE_TIMEOUT_MS,
  }, (url) => new WebSocket(url) as unknown as RelaySocketLike);
  const digest = createHash("sha256").update(ciphertext).digest("hex");
  if (ciphertext.byteLength !== fallback.ciphertextBytes || digest !== fallback.storageHash) {
    ciphertext.fill(0);
    throw new Error("Received bytes did not match the signed encrypted object hash and exact size.");
  }
  try {
    await writeCiphertextExclusively(input.outputPath, ciphertext);
  } finally {
    ciphertext.fill(0);
  }
  return { storageHash: digest, ciphertextBytes: fallback.ciphertextBytes };
}

async function main(): Promise<void> {
  const fallbackPath = process.env["BENZENE_RELAY_FALLBACK_FILE"];
  const outputPath = process.env["BENZENE_RELAY_CIPHERTEXT_OUT"];
  const publicKey = process.env["BENZENE_TRANSFER_PUBLIC_KEY"];
  if (!fallbackPath || !outputPath || !publicKey) {
    throw new Error("Set BENZENE_RELAY_FALLBACK_FILE, BENZENE_RELAY_CIPHERTEXT_OUT, and BENZENE_TRANSFER_PUBLIC_KEY.");
  }
  const fallback = await readProtectedFallback(path.resolve(fallbackPath));
  const result = await acceptRemoteRelay({ fallback, controlPlanePublicKey: publicKey, outputPath: path.resolve(outputPath) });
  process.stdout.write(`Remote relay acceptance passed: public WSS ingress, signed client ticket, exact ciphertext hash/size (${result.ciphertextBytes} bytes).\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`Remote relay acceptance failed: ${error instanceof Error ? error.message : "unexpected error"}\n`);
    process.exitCode = 1;
  });
}
