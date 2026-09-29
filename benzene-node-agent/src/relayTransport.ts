import { createHash } from "node:crypto";
import WebSocket from "ws";
import type { ObjectStore } from "./store.js";
import { verifyRelayScope } from "./relayScope.js";

const RELAY_FRAME_BYTES = 32 * 1024;
const MAX_BUFFERED_BYTES = 128 * 1024;
const LOW_BUFFERED_BYTES = 64 * 1024;
const RELAY_ENCRYPTION = "benzene-encrypted-object-v1";

export interface SendStoredRelayObjectOptions {
  relayUrl: string;
  ticket: string;
  controlPlanePublicKey: string;
  store: ObjectStore;
  /** The enrolled identity is supplied by the agent, never inferred from a ticket. */
  deviceId: string;
  /** Expected encrypted-object hash and exact ciphertext length from the caller. */
  storageHash: string;
  sizeBytes: number;
  /** Only useful for local transport integration tests. Production requires WSS. */
  allowInsecureLocalhost?: boolean;
}

export interface RelayTransferResult {
  storageHash: string;
  sizeBytes: number;
}

function relaySocketUrl(baseUrl: string, sessionId: string, allowInsecureLocalhost: boolean): string {
  const url = new URL(baseUrl);
  const localInsecure = allowInsecureLocalhost
    && url.protocol === "ws:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "wss:" && !localInsecure) {
    throw new Error("Relay transport requires wss:// (ws:// is allowed only for localhost tests)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Relay URL must not contain credentials, query parameters, or a fragment");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/relay/${sessionId}`;
  return url.toString();
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

function openAndPair(socketUrl: string, ticket: string, expiryMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl, { perMessageDeflate: false, maxPayload: 8 * 1024 });
    let opened = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Relay ticket expired before pairing")), Math.max(1, expiryMs - Date.now()));
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (error) {
        closeSocket(socket);
        reject(error);
      } else {
        resolve(socket);
      }
    };
    socket.onopen = () => {
      opened = true;
      socket.send(JSON.stringify({ type: "authenticate", ticket }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        finish(new Error("Relay sent data before the node was authorised to produce"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(event.data) as unknown;
      } catch {
        finish(new Error("Relay sent an invalid control frame"));
        return;
      }
      if (typeof message === "object" && message !== null
        && (message as { type?: unknown }).type === "paired") {
        finish();
        return;
      }
      finish(new Error("Relay rejected or failed to pair the node ticket"));
    };
    socket.onerror = () => finish(new Error("Relay WebSocket connection failed"));
    socket.onclose = (event) => finish(new Error(
      opened ? `Relay closed before pairing (${event.code})` : `Relay connection closed (${event.code})`
    ));
  });
}

async function waitForWritable(socket: WebSocket, expiryMs: number): Promise<void> {
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > LOW_BUFFERED_BYTES) {
    if (Date.now() >= expiryMs) throw new Error("Relay ticket expired while waiting for backpressure");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    throw new Error("Relay socket is unavailable or over its bounded send buffer");
  }
}

function waitForTransferClose(socket: WebSocket, expiryMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const remainingMs = Math.max(1, expiryMs - Date.now());
    const timer = setTimeout(() => {
      closeSocket(socket);
      reject(new Error("Relay transfer deadline expired"));
    }, remainingMs);
    socket.onclose = (event) => {
      clearTimeout(timer);
      if (event.code === 1000 && event.reason === "transfer_complete") resolve();
      else reject(new Error(`Relay closed before the signed object completed (${event.code})`));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Relay WebSocket failed during transfer"));
    };
  });
}

/**
 * Sends one already encrypted object through the relay as opaque binary frames.
 * This is a producer-only node/get API; receiver-side persistence and client
 * relay selection remain separate work.
 */
export async function sendStoredRelayObject(
  options: SendStoredRelayObjectOptions
): Promise<RelayTransferResult> {
  const verified = verifyRelayScope({
    token: options.ticket,
    controlPlanePublicKey: options.controlPlanePublicKey,
  });
  if (!verified.ok) throw new Error(`Relay ticket rejected: ${verified.reason}`);
  const scope = verified.scope;
  if (scope.role !== "node" || scope.op !== "get") {
    throw new Error("Node relay producer requires a node/get ticket");
  }
  if (scope.deviceId !== options.deviceId || scope.storageHash !== options.storageHash
    || scope.maxBytes !== options.sizeBytes) {
    throw new Error("Relay ticket scope does not match the requested stored object");
  }
  if (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 1) {
    throw new Error("Relay object size must be a positive safe integer");
  }

  const metadata = await options.store.metadata(options.storageHash);
  if (!metadata || metadata.encryption !== RELAY_ENCRYPTION || metadata.size !== options.sizeBytes) {
    throw new Error("Relay transport accepts only the exact encrypted object format and size");
  }
  // Verify the disk copy before connecting, then hash the streamed bytes again
  // to detect mutation between preflight and send. Memory stays bounded to one
  // WebSocket frame; the relay and receiver still treat all bytes as opaque.
  if (!(await options.store.verify(options.storageHash))) {
    throw new Error("Stored relay object failed its content hash check");
  }

  const deadline = scope.exp * 1000;
  const socket = await openAndPair(
    relaySocketUrl(options.relayUrl, scope.sessionId, options.allowInsecureLocalhost ?? false),
    options.ticket,
    deadline
  );
  // A node/get producer never receives object frames. Treat any post-pair
  // server data as a protocol violation so a peer cannot make this agent buffer
  // an unrequested download.
  socket.onmessage = () => closeSocket(socket);
  socket.onerror = () => closeSocket(socket);
  // Register the completion receipt before sending. For a small final frame the
  // relay can validate the exact byte count and close normally before the
  // producer reaches its post-loop checks; missing that close would turn a
  // successful transfer into a retry.
  const transferClosed = waitForTransferClose(socket, deadline);
  const digest = createHash("sha256");
  let sentBytes = 0;
  try {
    for await (const rawChunk of options.store.read(options.storageHash)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      if (Date.now() >= deadline) throw new Error("Relay ticket expired during object transfer");
      sentBytes += chunk.length;
      if (sentBytes > scope.maxBytes) throw new Error("Stored object exceeded the signed relay byte ceiling");
      digest.update(chunk);
      for (let offset = 0; offset < chunk.length; offset += RELAY_FRAME_BYTES) {
        await waitForWritable(socket, deadline);
        const frame = chunk.subarray(offset, Math.min(offset + RELAY_FRAME_BYTES, chunk.length));
        socket.send(frame);
      }
    }
    const actualHash = digest.digest("hex");
    if (sentBytes !== scope.maxBytes || actualHash !== scope.storageHash) {
      throw new Error("Streamed relay object did not match the signed hash and exact size");
    }
    await transferClosed;
    return { storageHash: actualHash, sizeBytes: sentBytes };
  } catch (error) {
    closeSocket(socket);
    await transferClosed.catch(() => undefined);
    throw error;
  }
}
