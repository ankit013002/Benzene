import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Pool } from "pg";
import { verifyRelayScope, type RelayScope, type RelayRole } from "./scope.js";
import { PostgresRelaySessionStore, type RelaySessionStore } from "./sessionStore.js";

const AUTH_FRAME_MAX_BYTES = 8192;
const MAX_AUTHENTICATING_SOCKETS = 1000;
const MAX_PENDING_FRAME_BYTES = 128 * 1024;
const MAX_BUFFERED_SEND_BYTES = 256 * 1024;
const LOW_BUFFERED_SEND_BYTES = 128 * 1024;
const SESSION_PATH = /^\/relay\/([0-9a-f-]{36})$/i;

export interface RelayServerOptions {
  host: string;
  port: number;
  publicKey: string;
  instanceId: string;
  maxSessions: number;
  maxFrameBytes: number;
  idleTimeoutMs: number;
  authTimeoutMs: number;
  pool?: Pool;
  /** Injectable for deterministic transport tests; production must use PostgreSQL. */
  store?: RelaySessionStore;
}

interface SocketState {
  readonly id: string;
  readonly socket: WebSocket;
  readonly pathSessionId: string;
  scope?: RelayScope;
  peer?: SocketState;
  phase: "authenticating" | "joining" | "waiting" | "paired" | "closed";
  authTimer: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  queuedBytes: number;
  queuedFrames: number;
  work: Promise<void>;
  countedAuthenticating: boolean;
  removed: boolean;
}

interface Pair {
  readonly first: SocketState;
  readonly second: SocketState;
  closing: boolean;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function parseAuthFrame(data: Buffer, isBinary: boolean): string | undefined {
  if (isBinary || data.length > AUTH_FRAME_MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const message = parsed as Record<string, unknown>;
  if (Object.keys(message).length !== 2 || message.type !== "authenticate"
    || typeof message.ticket !== "string") return undefined;
  return message.ticket;
}

function closeSocket(state: SocketState, code: number, reason: string): void {
  if (state.phase === "closed") return;
  state.phase = "closed";
  clearTimeout(state.authTimer);
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  if (state.idleTimer) clearTimeout(state.idleTimer);
  if (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING) {
    // A paused receiver must read the close handshake or both peers can hang
    // while waiting for the reciprocal WebSocket close frame.
    state.socket.resume();
    state.socket.close(code, reason.slice(0, 120));
  }
}

export function createRelayServer(options: RelayServerOptions): {
  server: Server;
  listen: () => Promise<void>;
  close: () => Promise<void>;
} {
  const store: RelaySessionStore = options.store ?? (options.pool
    ? new PostgresRelaySessionStore(options.pool, options.instanceId, options.maxSessions)
    : (() => { throw new Error("a shared Postgres pool is required"); })());
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"status":"ok","service":"benzene-relay"}');
      return;
    }
    response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"not_found"}');
  });
  httpServer.requestTimeout = 10_000;
  httpServer.headersTimeout = 10_000;
  httpServer.keepAliveTimeout = 5_000;

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(AUTH_FRAME_MAX_BYTES, options.maxFrameBytes),
    perMessageDeflate: false,
    skipUTF8Validation: false,
  });
  const sockets = new Set<SocketState>();
  const waiting = new Map<string, Map<RelayRole, SocketState>>();
  const pairs = new Map<string, Pair>();
  let authenticatingSockets = 0;

  const terminateSession = async (sessionId: string, code: number, reason: string): Promise<void> => {
    const pair = pairs.get(sessionId);
    if (pair) {
      pair.closing = true;
      closeSocket(pair.first, code, reason);
      closeSocket(pair.second, code, reason);
      pairs.delete(sessionId);
    }
    const waitingRoles = waiting.get(sessionId);
    if (waitingRoles) {
      for (const state of waitingRoles.values()) closeSocket(state, code, reason);
      waiting.delete(sessionId);
    }
    try {
      await store.closeSession(sessionId);
    } catch {
      // A DB outage must not keep either peer connected or able to send more.
    }
  };

  const touchPair = (pair: Pair): void => {
    for (const state of [pair.first, pair.second]) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        void terminateSession(state.scope?.sessionId ?? "", 1001, "idle_timeout");
      }, options.idleTimeoutMs);
      state.idleTimer.unref();
    }
  };

  const joinPair = (state: SocketState): void => {
    const scope = state.scope;
    if (!scope) {
      closeSocket(state, 1008, "invalid_scope");
      return;
    }
    let roles = waiting.get(scope.sessionId);
    if (!roles) {
      roles = new Map();
      waiting.set(scope.sessionId, roles);
    }
    const counterpartRole: RelayRole = scope.role === "node" ? "client" : "node";
    const counterpart = roles.get(counterpartRole);
    if (counterpart) {
      roles.delete(counterpartRole);
      if (roles.size === 0) waiting.delete(scope.sessionId);
      if (counterpart.phase !== "waiting" || !counterpart.scope || counterpart.scope.role === scope.role) {
        void terminateSession(scope.sessionId, 1008, "pairing_failed");
        return;
      }
      state.phase = "paired";
      counterpart.phase = "paired";
      state.peer = counterpart;
      counterpart.peer = state;
      const pair: Pair = { first: state, second: counterpart, closing: false };
      pairs.set(scope.sessionId, pair);
      touchPair(pair);
      void Promise.all([sendControl(state.socket, "paired"), sendControl(counterpart.socket, "paired")])
        .catch(() => { void terminateSession(scope.sessionId, 1011, "relay_stream_failed"); });
      state.socket.on("message", (data, isBinary) => receiveData(state, data, isBinary));
      counterpart.socket.on("message", (data, isBinary) => receiveData(counterpart, data, isBinary));
      return;
    }
    if (roles.has(scope.role)) {
      void terminateSession(scope.sessionId, 1008, "pairing_failed");
      return;
    }
    state.phase = "waiting";
    roles.set(scope.role, state);
  };

  const waitUntilWritable = async (destination: WebSocket, sessionId: string): Promise<void> => {
    while (destination.readyState === WebSocket.OPEN
      && destination.bufferedAmount > LOW_BUFFERED_SEND_BYTES) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref();
      });
    }
    if (destination.readyState !== WebSocket.OPEN || destination.bufferedAmount > MAX_BUFFERED_SEND_BYTES) {
      throw new Error(`relay destination unavailable for session ${sessionId}`);
    }
  };

  const sendFrame = (destination: WebSocket, data: Buffer): Promise<void> => new Promise((resolve, reject) => {
    destination.send(data, { binary: true, compress: false }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const sendControl = (destination: WebSocket, type: string): Promise<void> => new Promise((resolve, reject) => {
    destination.send(JSON.stringify({ type }), { binary: false, compress: false }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  function receiveData(state: SocketState, raw: RawData, isBinary: boolean): void {
    const pair = state.scope ? pairs.get(state.scope.sessionId) : undefined;
    const data = rawDataBuffer(raw);
    if (state.phase !== "paired" || !pair || pair.closing || !state.peer || !isBinary
      || data.length < 1 || data.length > options.maxFrameBytes) {
      void terminateSession(state.scope?.sessionId ?? "", 1008, "invalid_data_frame");
      return;
    }
    const scope = state.scope;
    if (!scope) {
      void terminateSession("", 1008, "invalid_data_frame");
      return;
    }
    state.queuedFrames += 1;
    state.queuedBytes += data.length;
    state.socket.pause();
    if (state.queuedFrames > 2 || state.queuedBytes > MAX_PENDING_FRAME_BYTES) {
      void terminateSession(scope.sessionId, 1009, "backpressure_limit");
      return;
    }
    state.work = state.work.then(async () => {
      if (state.phase !== "paired" || !state.peer || state.peer.socket.readyState !== WebSocket.OPEN) {
        throw new Error("relay peer closed");
      }
      const result = await store.accountBytes({
        sessionId: scope.sessionId,
        sender: scope.role,
        byteCount: data.length,
      });
      if (!result.ok) {
        await terminateSession(scope.sessionId, 1008, result.reason);
        return;
      }
      await waitUntilWritable(state.peer.socket, scope.sessionId);
      await sendFrame(state.peer.socket, data);
      touchPair(pair);
      if (result.complete) {
        await terminateSession(scope.sessionId, 1000, "transfer_complete");
      }
    }).catch(() => {
      void terminateSession(scope.sessionId, 1011, "relay_stream_failed");
    }).finally(() => {
      state.queuedFrames = Math.max(0, state.queuedFrames - 1);
      state.queuedBytes = Math.max(0, state.queuedBytes - data.length);
      if (state.phase === "paired" && state.queuedFrames === 0 && state.socket.readyState === WebSocket.OPEN) {
        state.socket.resume();
      }
    });
  }

  const handleSocket = (socket: WebSocket, request: IncomingMessage, pathSessionId: string): void => {
    const state: SocketState = {
      id: randomUUID(),
      socket,
      pathSessionId,
      phase: "authenticating",
      authTimer: setTimeout(() => closeSocket(state, 1008, "authentication_timeout"), options.authTimeoutMs),
      queuedBytes: 0,
      queuedFrames: 0,
      work: Promise.resolve(),
      countedAuthenticating: true,
      removed: false,
    };
    state.authTimer.unref();
    sockets.add(state);
    authenticatingSockets += 1;

    const removeState = (): void => {
      if (state.removed) return;
      state.removed = true;
      state.phase = "closed";
      clearTimeout(state.authTimer);
      if (state.expiryTimer) clearTimeout(state.expiryTimer);
      if (state.idleTimer) clearTimeout(state.idleTimer);
      sockets.delete(state);
      if (state.countedAuthenticating) {
        state.countedAuthenticating = false;
        authenticatingSockets = Math.max(0, authenticatingSockets - 1);
      }
      const scope = state.scope;
      if (!scope) return;
      const sessionId = scope.sessionId;
      const waitingRoles = waiting.get(sessionId);
      if (waitingRoles?.get(scope.role) === state) waitingRoles.delete(scope.role);
      const pair = pairs.get(sessionId);
      if (pair && !pair.closing) void terminateSession(sessionId, 1001, "peer_disconnected");
      else if (waitingRoles?.size === 0) waiting.delete(sessionId);
    };

    const reject = (code: number, reason: string): void => {
      closeSocket(state, code, reason);
      removeState();
    };

    let authStarted = false;
    let authenticated = false;
    socket.on("message", (raw, isBinary) => {
      if (authenticated) return;
      if (authStarted) {
        reject(1008, "authenticate_first");
        return;
      }
      authStarted = true;
      state.phase = "joining";
      const ticket = parseAuthFrame(rawDataBuffer(raw), isBinary);
      if (!ticket) {
        reject(1008, "invalid_auth_frame");
        return;
      }
      const verified = verifyRelayScope({ token: ticket, controlPlanePublicKey: options.publicKey });
      if (!verified.ok || verified.scope.sessionId !== pathSessionId) {
        reject(1008, "invalid_ticket");
        return;
      }
      state.scope = verified.scope;
      void store.claim(verified.scope).then((claim) => {
        if (state.phase === "closed") return;
        if (!claim.ok) {
          reject(1008, claim.reason);
          return;
        }
        authenticated = true;
        clearTimeout(state.authTimer);
        state.countedAuthenticating = false;
        authenticatingSockets = Math.max(0, authenticatingSockets - 1);
        state.expiryTimer = setTimeout(() => {
          void terminateSession(verified.scope.sessionId, 1001, "ticket_expired");
        }, Math.max(1, verified.scope.exp * 1000 - Date.now()));
        state.expiryTimer.unref();
        joinPair(state);
        if (state.phase === "waiting") {
          // Waiting consumes a session slot and remains bounded by the signed expiry.
          state.socket.once("close", removeState);
        }
      }).catch(() => reject(1011, "relay_unavailable"));
    });
    socket.on("close", removeState);
    socket.on("error", removeState);
  };

  httpServer.on("upgrade", (request, socket, head) => {
    if (authenticatingSockets >= MAX_AUTHENTICATING_SOCKETS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const parsedUrl = new URL(request.url ?? "/", "http://relay.invalid");
    const pathname = parsedUrl.pathname;
    const match = SESSION_PATH.exec(pathname);
    if (!match || parsedUrl.search) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      handleSocket(websocket, request, match[1] ?? "");
    });
  });

  return {
    server: httpServer,
    listen: () => new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(options.port, options.host, () => {
        httpServer.off("error", onError);
        resolve();
      });
    }),
    close: () => new Promise((resolve, reject) => {
      const activeSessionIds = new Set<string>();
      for (const state of sockets) {
        if (state.scope) activeSessionIds.add(state.scope.sessionId);
        state.phase = "closed";
        clearTimeout(state.authTimer);
        if (state.expiryTimer) clearTimeout(state.expiryTimer);
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.socket.terminate();
      }
      void Promise.all([...activeSessionIds].map((sessionId) => store.closeSession(sessionId)))
        .catch(() => undefined)
        .then(() => {
          websocketServer.close(() => {
            httpServer.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
        });
    }),
  };
}
