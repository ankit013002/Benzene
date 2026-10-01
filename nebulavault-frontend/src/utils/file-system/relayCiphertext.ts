import { ENCRYPTED_OBJECT_MAX_BYTES } from "./encryptedObject";

export const RELAY_RECEIVE_TIMEOUT_MS = 60_000;
const MAX_RECEIVE_TIMEOUT_MS = 120_000;
const MAX_RELAY_FRAME_BYTES = 32 * 1024;
const MAX_TICKET_CHARS = 8_192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export interface RelayFallbackResponse {
  kind: "relay_fallback";
  relayUrl: string;
  sessionId: string;
  ticket: string;
  storageHash: string;
  ciphertextBytes: number;
  expiresAt: string;
}

export interface RelaySocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RelayWebSocketFactory = (url: string) => RelaySocketLike;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFallback(value: unknown): RelayFallbackResponse {
  const expectedKeys = ["ciphertextBytes", "expiresAt", "kind", "relayUrl", "sessionId", "storageHash", "ticket"].sort();
  if (!isRecord(value)) throw new Error("Benzene returned an invalid secure relay response.");
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
    || value.kind !== "relay_fallback"
    || typeof value.relayUrl !== "string"
    || typeof value.sessionId !== "string" || !UUID_PATTERN.test(value.sessionId)
    || typeof value.ticket !== "string" || value.ticket.length === 0 || value.ticket.length > MAX_TICKET_CHARS
    || typeof value.storageHash !== "string" || !/^[a-f0-9]{64}$/.test(value.storageHash)
    || typeof value.ciphertextBytes !== "number" || !Number.isSafeInteger(value.ciphertextBytes)
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || new Date(value.expiresAt).toISOString() !== value.expiresAt) {
    throw new Error("Benzene returned an invalid secure relay response.");
  }
  return value as unknown as RelayFallbackResponse;
}

function failureMessage(response: Response): string {
  switch (response.status) {
    case 401: return "Your session has expired. Sign in again.";
    case 403: return "You are not authorized to read this file.";
    case 404: return "This file is no longer available in your Vault.";
    case 409: return "No online encrypted copy is available for secure relay right now.";
    case 429: return "Too many secure relay attempts. Wait a moment and try again.";
    case 503: return "Secure relay is temporarily unavailable. Try again later.";
    default: return "Benzene could not arrange a secure relay fallback.";
  }
}

/** Requests a short-lived client ticket only after every direct device read failed. */
export async function requestRelayReadFallback(input: {
  nodeId: string;
  storageHash: string;
  ciphertextBytes: number;
}): Promise<RelayFallbackResponse> {
  if (!OBJECT_ID_PATTERN.test(input.nodeId) || !/^[a-f0-9]{64}$/.test(input.storageHash)
    || !Number.isSafeInteger(input.ciphertextBytes) || input.ciphertextBytes < 16
    || input.ciphertextBytes > ENCRYPTED_OBJECT_MAX_BYTES + 16) {
    throw new Error("The encrypted file cannot use secure relay with invalid request metadata.");
  }
  if (!crypto.randomUUID) throw new Error("This browser cannot create a secure relay request. Update the browser and retry.");

  const response = await fetch("/api/placement/relay-read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: input.nodeId, requestId: crypto.randomUUID() }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(failureMessage(response));
  let payload: unknown;
  try { payload = await response.json() as unknown; }
  catch { throw new Error("Benzene returned an invalid secure relay response."); }
  if (!isRecord(payload) || !isRecord(payload.data)) throw new Error("Benzene returned an invalid secure relay response.");
  const fallback = parseFallback(payload.data);
  if (fallback.storageHash !== input.storageHash || fallback.ciphertextBytes !== input.ciphertextBytes) {
    throw new Error("The file changed before secure relay could start. Refresh the file list and try again.");
  }
  return fallback;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ticketExpiry(fallback: RelayFallbackResponse): number | null {
  const parts = fallback.ticket.split(".");
  if (parts.length !== 2 || !parts[1]) return null;
  try {
    const signature = decodeBase64Url(parts[1]);
    const scopeBytes = decodeBase64Url(parts[0] ?? "");
    const scope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(scopeBytes));
    if (signature.byteLength !== 64 || !isRecord(scope)) return null;
    const expectedKeys = ["deviceId", "exp", "maxBytes", "op", "role", "sessionId", "storageHash", "ticketId", "v"].sort();
    const keys = Object.keys(scope).sort();
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
      || scope.v !== 1 || scope.sessionId !== fallback.sessionId
      || typeof scope.ticketId !== "string" || !UUID_PATTERN.test(scope.ticketId)
      || typeof scope.deviceId !== "string" || !UUID_PATTERN.test(scope.deviceId)
      || scope.storageHash !== fallback.storageHash || scope.op !== "get" || scope.role !== "client"
      || typeof scope.exp !== "number" || !Number.isSafeInteger(scope.exp) || scope.exp <= nowSeconds || scope.exp > nowSeconds + 300
      || Date.parse(fallback.expiresAt) !== scope.exp * 1000 || scope.maxBytes !== fallback.ciphertextBytes) return null;
    return scope.exp * 1000;
  } catch {
    return null;
  }
}

function relaySocketUrl(fallback: RelayFallbackResponse): string {
  let url: URL;
  try { url = new URL(fallback.relayUrl); }
  catch { throw new Error("Benzene returned an invalid relay address."); }
  if (url.protocol !== "wss:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("Relay fallback requires a secure relay address.");
  }
  url.pathname = `/relay/${fallback.sessionId}`;
  return url.toString();
}

function platformSocketFactory(url: string): RelaySocketLike {
  if (typeof WebSocket === "undefined") throw new Error("This device cannot open a relay connection.");
  return new WebSocket(url) as unknown as RelaySocketLike;
}

function binaryFrame(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = Uint8Array.from(bytes).buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Receives exactly one scoped opaque ciphertext stream into a 25 MiB-bounded buffer. */
export function receiveRelayCiphertext(input: {
  fallback: unknown;
  expectedStorageHash: string;
  expectedCiphertextBytes: number;
  timeoutMs?: number;
}, socketFactory: RelayWebSocketFactory = platformSocketFactory): Promise<Uint8Array> {
  let fallback: RelayFallbackResponse;
  try { fallback = parseFallback(input.fallback); }
  catch (error) { return Promise.reject(error); }
  if (!/^[a-f0-9]{64}$/.test(input.expectedStorageHash) || fallback.storageHash !== input.expectedStorageHash
    || fallback.ciphertextBytes !== input.expectedCiphertextBytes
    || !Number.isSafeInteger(input.expectedCiphertextBytes) || input.expectedCiphertextBytes < 16
    || input.expectedCiphertextBytes > ENCRYPTED_OBJECT_MAX_BYTES + 16) {
    return Promise.reject(new Error("Relay fallback does not match the expected encrypted object."));
  }
  const timeoutMs = input.timeoutMs ?? RELAY_RECEIVE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RECEIVE_TIMEOUT_MS) {
    return Promise.reject(new Error("Relay receive timeout is outside its allowed bound."));
  }
  const expiry = ticketExpiry(fallback);
  if (expiry === null || expiry <= Date.now()) return Promise.reject(new Error("Relay fallback ticket does not authorize this encrypted object."));
  let url: string;
  try { url = relaySocketUrl(fallback); }
  catch (error) { return Promise.reject(error); }

  return new Promise((resolve, reject) => {
    let socket: RelaySocketLike;
    try { socket = socketFactory(url); }
    catch { reject(new Error("Relay WebSocket connection could not be created.")); return; }
    const ciphertext = new Uint8Array(input.expectedCiphertextBytes);
    let received = 0;
    let paired = false;
    let settled = false;
    const timeout = setTimeout(() => fail("Relay transfer timed out."), Math.min(timeoutMs, expiry - Date.now()));
    socket.binaryType = "arraybuffer";
    const detach = (): void => {
      clearTimeout(timeout);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      detach();
      ciphertext.fill(0);
      if (socket.readyState === 0 || socket.readyState === 1) {
        try { socket.close(); } catch { /* The transfer is already rejected. */ }
      }
      reject(new Error(message));
    };
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ type: "authenticate", ticket: fallback.ticket })); }
      catch { fail("Relay authentication could not be sent."); }
    };
    socket.onmessage = (event) => {
      if (!paired) {
        if (typeof event.data !== "string") { fail("Relay sent binary data before pairing."); return; }
        let control: unknown;
        try { control = JSON.parse(event.data) as unknown; }
        catch { fail("Relay sent an invalid pairing response."); return; }
        if (!isRecord(control) || Object.keys(control).length !== 1 || control.type !== "paired") {
          fail("Relay did not authorize the client stream.");
          return;
        }
        paired = true;
        return;
      }
      const frame = binaryFrame(event.data);
      if (!frame || frame.byteLength === 0) { fail("Relay sent a non-binary or empty data frame."); return; }
      if (frame.byteLength > MAX_RELAY_FRAME_BYTES) { fail("Relay sent a frame larger than the supported bound."); return; }
      if (received + frame.byteLength > ciphertext.byteLength) { fail("Relay sent more ciphertext than expected."); return; }
      ciphertext.set(frame, received);
      received += frame.byteLength;
    };
    socket.onerror = () => fail("Relay WebSocket failed during the transfer.");
    socket.onclose = (event) => {
      if (!paired) { fail("Relay closed before authorizing the client stream."); return; }
      if (event.code !== 1000 || event.reason !== "transfer_complete") {
        fail("Relay closed before completing the signed ciphertext transfer.");
        return;
      }
      if (received !== ciphertext.byteLength) { fail("Relay closed before the exact ciphertext length arrived."); return; }
      void sha256Hex(ciphertext).then((hash) => {
        if (hash !== input.expectedStorageHash) { fail("Relayed ciphertext does not match the expected storageHash."); return; }
        if (!settled) {
          settled = true;
          detach();
          resolve(ciphertext);
        }
      }).catch(() => fail("Could not verify relayed ciphertext integrity."));
    };
  });
}
