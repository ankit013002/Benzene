import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import * as relayTicketModule from "../src/modules/placement/relayTicket.js";
import { acceptRemoteRelay, validateRemoteRelayInput } from "./accept-remote-relay.mts";

const relayTicketApi = (("default" in relayTicketModule ? relayTicketModule.default : relayTicketModule) as unknown) as typeof import("../src/modules/placement/relayTicket.js");
const { issueRelayTicket } = relayTicketApi;
const NOW = Math.floor(Date.now() / 1000);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const CIPHERTEXT = Buffer.from("encrypted acceptance fixture");
const HASH = createHash("sha256").update(CIPHERTEXT).digest("hex");

function fixture(role: "client" | "node" = "client") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const exp = NOW + 180;
  const ticket = issueRelayTicket(privateKeyB64, {
    v: 1,
    sessionId: SESSION_ID,
    ticketId: "22222222-2222-4222-8222-222222222222",
    storageHash: HASH,
    deviceId: DEVICE_ID,
    op: "get",
    role,
    exp,
    maxBytes: CIPHERTEXT.byteLength,
  }, NOW);
  const fallback = {
    kind: "relay_fallback",
    relayUrl: "wss://relay.benzene.net",
    sessionId: SESSION_ID,
    ticket,
    storageHash: HASH,
    ciphertextBytes: CIPHERTEXT.byteLength,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
  return { publicKeyB64, fallback };
}

test("acceptance input requires a signed client/get ticket scoped to exact ciphertext", () => {
  const good = fixture();
  assert.equal(validateRemoteRelayInput(good.fallback, good.publicKeyB64, NOW).storageHash, HASH);

  const node = fixture("node");
  assert.throws(() => validateRemoteRelayInput(node.fallback, node.publicKeyB64, NOW), /exact encrypted object and session/);
  assert.throws(() => validateRemoteRelayInput(good.fallback, "MCowBQYDK2VwAyEAQiXjegSw+hk+G7q3AsZ9Prf9CfvbowdPIkPkR4ASVPU=", NOW), /signature or scope/);
  assert.throws(() => validateRemoteRelayInput({ ...good.fallback, ciphertextBytes: CIPHERTEXT.byteLength + 1 }, good.publicKeyB64, NOW), /exact encrypted object and session/);
  assert.throws(() => validateRemoteRelayInput({ ...good.fallback, relayUrl: "ws://relay.benzene.test" }, good.publicKeyB64, NOW), /WSS origin/);
});

test("acceptance verifies deployment and ciphertext hash before exclusive output", async () => {
  const { publicKeyB64, fallback } = fixture();
  const root = await mkdtemp(path.join(tmpdir(), "benzene-remote-relay-test-"));
  const outputPath = path.join(root, "ciphertext.bin");
  const phases: string[] = [];
  try {
    const result = await acceptRemoteRelay({
      fallback,
      controlPlanePublicKey: publicKeyB64,
      outputPath,
      verifyDeployment: async (url, options) => {
        assert.equal(url, "wss://relay.benzene.net");
        assert.equal(options?.WebSocketImpl, WebSocket);
        phases.push("ingress");
        return [];
      },
      receive: async () => { phases.push("receive"); return new Uint8Array(CIPHERTEXT); },
    });
    assert.deepEqual(phases, ["ingress", "receive"]);
    assert.deepEqual(result, { storageHash: HASH, ciphertextBytes: CIPHERTEXT.byteLength });
    assert.deepEqual(await readFile(outputPath), CIPHERTEXT);
    await assert.rejects(acceptRemoteRelay({
      fallback,
      controlPlanePublicKey: publicKeyB64,
      outputPath,
      verifyDeployment: async () => [],
      receive: async () => new Uint8Array(Buffer.from("wrong ciphertext")),
    }), /encrypted object hash and exact size/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
