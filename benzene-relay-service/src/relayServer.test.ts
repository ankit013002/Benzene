import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer } from "./relayServer.js";
import type { AccountResult, ClaimResult, RelaySessionStore } from "./sessionStore.js";
import type { RelayScope, RelayRole } from "./scope.js";

const NOW = Math.floor(Date.now() / 1000);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privateKeyDer = privateKey.export({ format: "der", type: "pkcs8" });

function makeScope(input: Partial<RelayScope> = {}): RelayScope {
  return {
    v: 1,
    sessionId: randomUUID(),
    ticketId: randomUUID(),
    storageHash: "c".repeat(64),
    deviceId: randomUUID(),
    op: "get",
    role: "node",
    exp: NOW + 60,
    maxBytes: 4,
    ...input,
  };
}

function mint(scope: unknown): string {
  const payload = Buffer.from(JSON.stringify(scope)).toString("base64url");
  const signature = sign(null, Buffer.from(payload), {
    key: privateKeyDer,
    format: "der",
    type: "pkcs8",
  }).toString("base64url");
  return `${payload}.${signature}`;
}

class MemorySessionStore implements RelaySessionStore {
  private readonly sessions = new Map<string, {
    binding: Omit<RelayScope, "role" | "ticketId">;
    roles: Set<RelayRole>;
    state: "waiting" | "paired" | "closed";
    bytes: number;
  }>();
  private readonly tickets = new Set<string>();
  readonly forwardedAttempts: Buffer[] = [];

  async claim(scope: RelayScope): Promise<ClaimResult> {
    if (this.tickets.has(scope.ticketId)) return { ok: false, reason: "replayed_ticket" };
    let session = this.sessions.get(scope.sessionId);
    const binding = {
      v: scope.v,
      sessionId: scope.sessionId,
      storageHash: scope.storageHash,
      deviceId: scope.deviceId,
      op: scope.op,
      exp: scope.exp,
      maxBytes: scope.maxBytes,
    };
    if (session && JSON.stringify(session.binding) !== JSON.stringify(binding)) {
      return { ok: false, reason: "scope_mismatch" };
    }
    if (session?.state === "closed") return { ok: false, reason: "closed" };
    if (session?.roles.has(scope.role)) return { ok: false, reason: "duplicate_role" };
    if (!session) {
      session = { binding, roles: new Set(), state: "waiting", bytes: 0 };
      this.sessions.set(scope.sessionId, session);
    }
    this.tickets.add(scope.ticketId);
    session.roles.add(scope.role);
    if (session.roles.size === 2) session.state = "paired";
    return { ok: true, state: session.state };
  }

  async accountBytes(input: { sessionId: string; sender: RelayRole; byteCount: number }): Promise<AccountResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.state === "closed") return { ok: false, reason: "closed" };
    if (session.state !== "paired") return { ok: false, reason: "not_paired" };
    if (input.sender !== (session.binding.op === "get" ? "node" : "client")) {
      return { ok: false, reason: "wrong_sender" };
    }
    if (session.bytes + input.byteCount > session.binding.maxBytes) {
      session.state = "closed";
      return { ok: false, reason: "size_exceeded" };
    }
    session.bytes += input.byteCount;
    this.forwardedAttempts.push(Buffer.alloc(input.byteCount));
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
  store: MemorySessionStore;
  close: () => Promise<void>;
  sockets: WebSocket[];
}

const running: RunningRelay[] = [];

async function startRelay(options: { maxFrameBytes?: number; idleTimeoutMs?: number } = {}): Promise<RunningRelay> {
  const store = new MemorySessionStore();
  const relay = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    publicKey: publicKeyBase64,
    instanceId: randomUUID(),
    maxSessions: 4,
    maxFrameBytes: options.maxFrameBytes ?? 64 * 1024,
    idleTimeoutMs: options.idleTimeoutMs ?? 1000,
    authTimeoutMs: 1000,
    store,
  });
  await relay.listen();
  const address = relay.server.address();
  if (!address || typeof address === "string") throw new Error("relay did not bind a TCP port");
  const result: RunningRelay = {
    url: `ws://127.0.0.1:${address.port}`,
    store,
    close: relay.close,
    sockets: [],
  };
  running.push(result);
  return result;
}

async function connect(relay: RunningRelay, scope: unknown): Promise<WebSocket> {
  const sessionId = (scope as { sessionId: string }).sessionId;
  const socket = new WebSocket(`${relay.url}/relay/${sessionId}`, { perMessageDeflate: false });
  relay.sockets.push(socket);
  trackMessages(socket);
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "authenticate", ticket: mint(scope) }));
  return socket;
}

interface MessageQueue {
  values: { data: Buffer; isBinary: boolean }[];
  waiters: ((message: { data: Buffer; isBinary: boolean }) => void)[];
}

const messageQueues = new WeakMap<WebSocket, MessageQueue>();

function trackMessages(socket: WebSocket): void {
  const queue: MessageQueue = { values: [], waiters: [] };
  messageQueues.set(socket, queue);
  socket.on("message", (raw, isBinary) => {
    const message = { data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), isBinary };
    const waiter = queue.waiters.shift();
    if (waiter) waiter(message);
    else queue.values.push(message);
  });
}

async function nextMessage(socket: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  const queue = messageQueues.get(socket);
  if (!queue) throw new Error("message queue was not initialized");
  const value = queue.values.shift();
  if (value) return value;
  return new Promise((resolve) => queue.waiters.push(resolve));
}

async function nextClose(socket: WebSocket): Promise<number> {
  const [code] = await once(socket, "close") as [number, Buffer];
  return code;
}

afterEach(async () => {
  for (const relay of running.splice(0)) {
    for (const socket of relay.sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    await relay.close();
  }
});

describe("relay WebSocket transport", () => {
  it("pairs exact opposite roles and forwards opaque bytes only in the get direction", async () => {
    const relay = await startRelay();
    const nodeScope = makeScope({ role: "node" });
    const clientScope = makeScope({ ...nodeScope, ticketId: randomUUID(), role: "client" });
    const node = await connect(relay, nodeScope);
    const client = await connect(relay, clientScope);
    expect(await nextMessage(node)).toMatchObject({ data: Buffer.from('{"type":"paired"}'), isBinary: false });
    expect(await nextMessage(client)).toMatchObject({ data: Buffer.from('{"type":"paired"}'), isBinary: false });

    const received = nextMessage(client);
    const opaqueBytes = Buffer.from([0x00, 0xff, 0x81, 0x20]);
    node.send(opaqueBytes, { binary: true });
    await expect(received).resolves.toMatchObject({ data: opaqueBytes, isBinary: true });
    expect(relay.store.forwardedAttempts).toHaveLength(1);
    expect(relay.store.forwardedAttempts[0]?.byteLength).toBe(4);
  });

  it("rejects plaintext metadata fields in a signed ticket before claim", async () => {
    const relay = await startRelay();
    const scope = { ...makeScope(), objectId: "a".repeat(64), fileName: "private.txt" };
    const socket = new WebSocket(`${relay.url}/relay/${scope.sessionId}`);
    relay.sockets.push(socket);
    await once(socket, "open");
    const closed = nextClose(socket);
    socket.send(JSON.stringify({ type: "authenticate", ticket: mint(scope) }));
    expect(await closed).toBe(1008);
    expect(relay.store.forwardedAttempts).toHaveLength(0);
  });

  it("rejects text frames and blocks a sender that does not match the operation", async () => {
    const relay = await startRelay();
    const nodeScope = makeScope({ role: "node" });
    const clientScope = makeScope({ ...nodeScope, ticketId: randomUUID(), role: "client" });
    const node = await connect(relay, nodeScope);
    const client = await connect(relay, clientScope);
    await nextMessage(node);
    await nextMessage(client);
    const clientClosed = nextClose(client);
    client.send(Buffer.from("must not be forwarded"), { binary: true });
    expect(await clientClosed).toBe(1008);
    expect(relay.store.forwardedAttempts).toHaveLength(0);
  });

  it("enforces the configured WebSocket frame ceiling", async () => {
    const relay = await startRelay({ maxFrameBytes: 8 });
    const nodeScope = makeScope({ maxBytes: 10 });
    const clientScope = makeScope({ ...nodeScope, ticketId: randomUUID(), role: "client" });
    const node = await connect(relay, nodeScope);
    const client = await connect(relay, clientScope);
    await nextMessage(node);
    await nextMessage(client);
    const close = nextClose(node);
    node.send(Buffer.alloc(9), { binary: true });
    expect(await close).toBe(1008);
    expect(relay.store.forwardedAttempts).toHaveLength(0);
  });
});
