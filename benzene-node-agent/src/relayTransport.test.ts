import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer } from "../../benzene-relay-service/src/relayServer.js";
import type {
  AccountResult,
  ClaimResult,
  RelaySessionStore,
} from "../../benzene-relay-service/src/sessionStore.js";
import type { RelayScope, RelayRole } from "../../benzene-relay-service/src/scope.js";
import { ObjectStore } from "./store.js";
import { sendStoredRelayObject } from "./relayTransport.js";

const ENCRYPTION = "benzene-encrypted-object-v1";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const controlPlanePublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privateKeyDer = privateKey.export({ format: "der", type: "pkcs8" });

interface Session {
  binding: Omit<RelayScope, "role" | "ticketId">;
  roles: Set<RelayRole>;
  state: "waiting" | "paired" | "closed";
  bytes: number;
}

class MemoryRelaySessionStore implements RelaySessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ticketIds = new Set<string>();

  async claim(scope: RelayScope): Promise<ClaimResult> {
    if (this.ticketIds.has(scope.ticketId)) return { ok: false, reason: "replayed_ticket" };
    const binding = {
      v: scope.v,
      sessionId: scope.sessionId,
      storageHash: scope.storageHash,
      deviceId: scope.deviceId,
      op: scope.op,
      exp: scope.exp,
      maxBytes: scope.maxBytes,
    };
    let session = this.sessions.get(scope.sessionId);
    if (session && JSON.stringify(session.binding) !== JSON.stringify(binding)) {
      return { ok: false, reason: "scope_mismatch" };
    }
    if (session?.state === "closed") return { ok: false, reason: "closed" };
    if (session?.roles.has(scope.role)) return { ok: false, reason: "duplicate_role" };
    if (!session) {
      session = { binding, roles: new Set(), state: "waiting", bytes: 0 };
      this.sessions.set(scope.sessionId, session);
    }
    this.ticketIds.add(scope.ticketId);
    session.roles.add(scope.role);
    if (session.roles.size === 2) session.state = "paired";
    return { ok: true, state: session.state };
  }

  async accountBytes(input: { sessionId: string; sender: RelayRole; byteCount: number }): Promise<AccountResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.state === "closed") return { ok: false, reason: "closed" };
    if (session.state !== "paired") return { ok: false, reason: "not_paired" };
    const expectedSender = session.binding.op === "get" ? "node" : "client";
    if (input.sender !== expectedSender) return { ok: false, reason: "wrong_sender" };
    if (session.bytes + input.byteCount > session.binding.maxBytes) {
      session.state = "closed";
      return { ok: false, reason: "size_exceeded" };
    }
    session.bytes += input.byteCount;
    const complete = session.bytes === session.binding.maxBytes;
    if (complete) session.state = "closed";
    return { ok: true, totalBytes: session.bytes, complete };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.state = "closed";
  }
}

interface RunningRelay {
  url: string;
  close: () => Promise<void>;
  sockets: WebSocket[];
}

const relays: RunningRelay[] = [];
const roots: string[] = [];

async function startRelay(): Promise<RunningRelay> {
  const relay = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    publicKey: controlPlanePublicKey,
    instanceId: randomUUID(),
    maxSessions: 4,
    maxFrameBytes: 64 * 1024,
    idleTimeoutMs: 5_000,
    authTimeoutMs: 1_000,
    store: new MemoryRelaySessionStore(),
  });
  await relay.listen();
  const address = relay.server.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind a TCP port");
  const running = { url: `ws://127.0.0.1:${address.port}`, close: relay.close, sockets: [] };
  relays.push(running);
  return running;
}

function mint(scope: RelayScope): string {
  const payload = Buffer.from(JSON.stringify(scope)).toString("base64url");
  const signature = sign(null, Buffer.from(payload), {
    key: privateKeyDer,
    format: "der",
    type: "pkcs8",
  }).toString("base64url");
  return `${payload}.${signature}`;
}

async function connectConsumer(relay: RunningRelay, scope: RelayScope): Promise<{
  socket: WebSocket;
  paired: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  bytes: Promise<Buffer>;
}> {
  const socket = new WebSocket(`${relay.url}/relay/${scope.sessionId}`, { perMessageDeflate: false });
  relay.sockets.push(socket);
  await once(socket, "open");
  let resolvePaired: (() => void) | undefined;
  let rejectPaired: ((error: Error) => void) | undefined;
  const paired = new Promise<void>((resolve, reject) => {
    resolvePaired = resolve;
    rejectPaired = reject;
  });
  const chunks: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      } else if (data.toString() === '{"type":"paired"}') {
        resolvePaired?.();
      } else {
        rejectPaired?.(new Error("relay did not pair the consumer"));
      }
    });
    socket.once("close", () => resolve(Buffer.concat(chunks)));
  });
  const closed = once(socket, "close").then(([code, reason]) => ({
    code: code as number,
    reason: Buffer.isBuffer(reason) ? reason.toString() : String(reason),
  }));
  socket.send(JSON.stringify({ type: "authenticate", ticket: mint(scope) }));
  return { socket, paired, closed, bytes };
}

afterEach(async () => {
  for (const relay of relays.splice(0)) {
    for (const socket of relay.sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    await relay.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("node relay transport", () => {
  it("streams an exact encrypted object through the real relay server as opaque bytes", async () => {
    const relay = await startRelay();
    const root = await mkdtemp(path.join(tmpdir(), "benzene-node-relay-"));
    roots.push(root);
    const store = new ObjectStore({ rootDir: root, allocatedBytes: 1024 * 1024 });
    await store.load();
    const bytes = Buffer.from([0, 255, 0x81, 32, 7, 0, 0xfe]);
    const storageHash = createHash("sha256").update(bytes).digest("hex");
    await store.put(Readable.from([bytes]), {
      expectedHash: storageHash,
      expectedSize: bytes.length,
      encryption: ENCRYPTION,
    });
    const now = Math.floor(Date.now() / 1000);
    const nodeScope: RelayScope = {
      v: 1,
      sessionId: randomUUID(),
      ticketId: randomUUID(),
      storageHash,
      deviceId: randomUUID(),
      op: "get",
      role: "node",
      exp: now + 60,
      maxBytes: bytes.length,
    };
    const clientScope: RelayScope = { ...nodeScope, ticketId: randomUUID(), role: "client" };
    const consumer = await connectConsumer(relay, clientScope);
    const send = sendStoredRelayObject({
      relayUrl: relay.url,
      ticket: mint(nodeScope),
      controlPlanePublicKey,
      store,
      deviceId: nodeScope.deviceId,
      storageHash,
      sizeBytes: bytes.length,
      allowInsecureLocalhost: true,
    });

    await Promise.all([consumer.paired, send]);
    const close = await consumer.closed;
    expect(close).toEqual({ code: 1000, reason: "transfer_complete" });
    await expect(consumer.bytes).resolves.toEqual(bytes);
  });

  it("rejects wrong role, scope, legacy plaintext, expired tickets, and corrupt stored bytes", async () => {
    const relay = await startRelay();
    const root = await mkdtemp(path.join(tmpdir(), "benzene-node-relay-"));
    roots.push(root);
    const store = new ObjectStore({ rootDir: root, allocatedBytes: 1024 * 1024 });
    await store.load();
    const bytes = Buffer.from("not ciphertext");
    const storageHash = createHash("sha256").update(bytes).digest("hex");
    await store.put(Readable.from([bytes]), { expectedHash: storageHash, expectedSize: bytes.length });
    const baseScope: RelayScope = {
      v: 1,
      sessionId: randomUUID(),
      ticketId: randomUUID(),
      storageHash,
      deviceId: randomUUID(),
      op: "get",
      role: "node",
      exp: Math.floor(Date.now() / 1000) + 60,
      maxBytes: bytes.length,
    };
    const input = {
      relayUrl: relay.url,
      controlPlanePublicKey,
      store,
      deviceId: baseScope.deviceId,
      storageHash,
      sizeBytes: bytes.length,
      allowInsecureLocalhost: true,
    };
    await expect(sendStoredRelayObject({ ...input, ticket: mint({ ...baseScope, role: "client" }) }))
      .rejects.toThrow("node/get");
    await expect(sendStoredRelayObject({ ...input, storageHash: "a".repeat(64), ticket: mint(baseScope) }))
      .rejects.toThrow("scope");
    await expect(sendStoredRelayObject({ ...input, ticket: mint(baseScope) }))
      .rejects.toThrow("encrypted object");
    await expect(sendStoredRelayObject({
      ...input,
      ticket: mint({ ...baseScope, exp: Math.floor(Date.now() / 1000) - 1 }),
    })).rejects.toThrow("expired");

    const encryptedBytes = Buffer.from("opaque ciphertext test fixture");
    const encryptedHash = createHash("sha256").update(encryptedBytes).digest("hex");
    await store.put(Readable.from([encryptedBytes]), {
      expectedHash: encryptedHash,
      expectedSize: encryptedBytes.length,
      encryption: ENCRYPTION,
    });
    const corruptScope: RelayScope = {
      ...baseScope,
      sessionId: randomUUID(),
      ticketId: randomUUID(),
      storageHash: encryptedHash,
      maxBytes: encryptedBytes.length,
    };
    await writeFile(path.join(root, "objects", encryptedHash.slice(0, 2), encryptedHash), "corrupted");
    await expect(sendStoredRelayObject({
      ...input,
      ticket: mint(corruptScope),
      storageHash: encryptedHash,
      sizeBytes: encryptedBytes.length,
    })).rejects.toThrow("content hash");
  });
});
