import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, decodeBase64Url } from '../crypto/bytes';
import { MAX_ENCRYPTED_FILE_BYTES } from './limits';

export const RELAY_RECEIVE_TIMEOUT_MS = 60_000;
const MAX_RELAY_RECEIVE_TIMEOUT_MS = 120_000;
const MAX_RELAY_TICKET_CHARS = 8_192;
const MAX_RELAY_FRAME_BYTES = 32 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Small normalized boundary for a future control-plane response; not its JSON schema. */
export type RelayFallbackResponse = {
  kind: 'relay_fallback';
  relayUrl: string;
  sessionId: string;
  ticket: string;
  storageHash: string;
  ciphertextBytes: number;
  expiresAt: string;
};

export type RelayFallbackRequest = { nodeId: string; storageHash: string; ciphertextBytes: number };

export type RelaySocketLike = {
  readonly readyState: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RelayWebSocketFactory = (url: string) => RelaySocketLike;

export type RelayReceiveInput = {
  fallback: unknown;
  expectedStorageHash: string;
  expectedCiphertextBytes: number;
  timeoutMs?: number;
};

function isRelayFallback(value: unknown): value is RelayFallbackResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fallback = value as Record<string, unknown>;
  const keys = Object.keys(fallback).sort();
  const expectedKeys = ['ciphertextBytes', 'expiresAt', 'kind', 'relayUrl', 'sessionId', 'storageHash', 'ticket'].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
    && fallback.kind === 'relay_fallback'
    && typeof fallback.relayUrl === 'string'
    && typeof fallback.sessionId === 'string' && UUID_PATTERN.test(fallback.sessionId)
    && typeof fallback.ticket === 'string' && fallback.ticket.length > 0 && fallback.ticket.length <= MAX_RELAY_TICKET_CHARS
    && typeof fallback.storageHash === 'string' && /^[a-f0-9]{64}$/.test(fallback.storageHash)
    && typeof fallback.ciphertextBytes === 'number' && Number.isSafeInteger(fallback.ciphertextBytes)
    && typeof fallback.expiresAt === 'string' && Number.isFinite(Date.parse(fallback.expiresAt))
    && new Date(fallback.expiresAt).toISOString() === fallback.expiresAt;
}

function relayUrl(base: string, sessionId: string): string {
  let parsed: URL;
  try { parsed = new URL(base); } catch { throw new Error('Benzene returned an invalid relay address.'); }
  if (parsed.protocol !== 'wss:' || parsed.pathname !== '/' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Relay fallback requires a secure relay address.');
  }
  parsed.pathname = `/relay/${sessionId}`;
  return parsed.toString();
}

function matchingTicketExpiryMs(fallback: RelayFallbackResponse, nowSeconds = Math.floor(Date.now() / 1000)): number | null {
  const parts = fallback.ticket.split('.');
  if (parts.length !== 2 || !parts[1]) return null;
  try {
    const encodedScope = decodeBase64Url(parts[0] ?? '', 'relay ticket scope');
    const signature = decodeBase64Url(parts[1], 'relay ticket signature');
    if (signature.byteLength !== 64) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(encodedScope));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const scope = parsed as Record<string, unknown>;
    const keys = Object.keys(scope).sort();
    const expectedKeys = ['deviceId', 'exp', 'maxBytes', 'op', 'role', 'sessionId', 'storageHash', 'ticketId', 'v'].sort();
    const matches = keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
      && scope.v === 1
      && scope.sessionId === fallback.sessionId
      && typeof scope.ticketId === 'string' && UUID_PATTERN.test(scope.ticketId)
      && typeof scope.deviceId === 'string' && UUID_PATTERN.test(scope.deviceId)
      && scope.storageHash === fallback.storageHash
      && scope.op === 'get' && scope.role === 'client'
      && Number.isSafeInteger(scope.exp) && (scope.exp as number) > nowSeconds && (scope.exp as number) <= nowSeconds + 300
      && Date.parse(fallback.expiresAt) === (scope.exp as number) * 1000
      && scope.maxBytes === fallback.ciphertextBytes;
    return matches ? (scope.exp as number) * 1000 : null;
  } catch {
    return null;
  }
}

function platformWebSocketFactory(url: string): RelaySocketLike {
  if (typeof WebSocket === 'undefined') throw new Error('This device cannot open a relay connection.');
  return new WebSocket(url) as unknown as RelaySocketLike;
}

function binaryBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return null;
}

/** Receives one explicitly authorized relay/get stream into one cap-bounded ciphertext buffer. */
export function receiveRelayCiphertext(
  input: RelayReceiveInput,
  socketFactory: RelayWebSocketFactory = platformWebSocketFactory,
): Promise<Uint8Array> {
  if (!isRelayFallback(input.fallback)) return Promise.reject(new Error('A relay transfer requires an explicit relay fallback response.'));
  const fallback = input.fallback;
  if (!/^[a-f0-9]{64}$/.test(input.expectedStorageHash)
    || fallback.storageHash !== input.expectedStorageHash
    || fallback.ciphertextBytes !== input.expectedCiphertextBytes
    || !Number.isSafeInteger(input.expectedCiphertextBytes)
    || input.expectedCiphertextBytes < 16
    || input.expectedCiphertextBytes > MAX_ENCRYPTED_FILE_BYTES + 16) {
    return Promise.reject(new Error('Relay fallback does not match the expected encrypted object.'));
  }
  const timeoutMs = input.timeoutMs ?? RELAY_RECEIVE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RELAY_RECEIVE_TIMEOUT_MS) {
    return Promise.reject(new Error('Relay receive timeout is outside its allowed bound.'));
  }
  const ticketExpiry = matchingTicketExpiryMs(fallback);
  if (ticketExpiry === null || ticketExpiry <= Date.now()) return Promise.reject(new Error('Relay fallback ticket does not authorize this encrypted object.'));
  const boundedTimeoutMs = Math.min(timeoutMs, ticketExpiry - Date.now());

  let url: string;
  try { url = relayUrl(fallback.relayUrl, fallback.sessionId); }
  catch (error) { return Promise.reject(error); }

  return new Promise((resolve, reject) => {
    let socket: RelaySocketLike;
    try { socket = socketFactory(url); }
    catch { reject(new Error('Relay WebSocket connection could not be created.')); return; }

    const ciphertext = new Uint8Array(input.expectedCiphertextBytes);
    let receivedBytes = 0;
    let paired = false;
    let settled = false;
    const timer = setTimeout(() => fail('Relay transfer timed out.'), boundedTimeoutMs);

    const detach = (): void => {
      clearTimeout(timer);
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
        try { socket.close(); } catch { /* The receive is already rejected. */ }
      }
      reject(new Error(message));
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      detach();
      resolve(ciphertext);
    };

    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ type: 'authenticate', ticket: fallback.ticket })); }
      catch { fail('Relay authentication could not be sent.'); }
    };
    socket.onmessage = (event) => {
      if (!paired) {
        if (typeof event.data !== 'string') { fail('Relay sent binary data before pairing.'); return; }
        let control: unknown;
        try { control = JSON.parse(event.data) as unknown; }
        catch { fail('Relay sent an invalid pairing response.'); return; }
        if (typeof control !== 'object' || control === null || Array.isArray(control)
          || Object.keys(control).length !== 1 || (control as { type?: unknown }).type !== 'paired') {
          fail('Relay did not authorize the client stream.');
          return;
        }
        paired = true;
        return;
      }
      const frame = binaryBytes(event.data);
      if (!frame || frame.byteLength === 0) { fail('Relay sent a non-binary or empty data frame.'); return; }
      if (frame.byteLength > MAX_RELAY_FRAME_BYTES) { fail('Relay sent a frame larger than the supported bound.'); return; }
      if (receivedBytes + frame.byteLength > ciphertext.byteLength) { fail('Relay sent more ciphertext than expected.'); return; }
      ciphertext.set(frame, receivedBytes);
      receivedBytes += frame.byteLength;
    };
    socket.onerror = () => fail('Relay WebSocket failed during the transfer.');
    socket.onclose = (event) => {
      if (!paired) { fail('Relay closed before authorizing the client stream.'); return; }
      if (event.code !== 1000 || event.reason !== 'transfer_complete') {
        fail('Relay closed before completing the signed ciphertext transfer.');
        return;
      }
      if (receivedBytes !== ciphertext.byteLength) { fail('Relay closed before the exact ciphertext length arrived.'); return; }
      if (bytesToHex(sha256(ciphertext)) !== input.expectedStorageHash) { fail('Relayed ciphertext does not match the expected storageHash.'); return; }
      succeed();
    };
  });
}
