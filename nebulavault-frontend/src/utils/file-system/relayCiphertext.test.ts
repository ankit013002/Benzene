import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  receiveRelayCiphertext,
  requestRelayReadFallback,
  type RelayFallbackResponse,
  type RelaySocketLike,
} from "./relayCiphertext";

const HASH = "a".repeat(64);
const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const DEVICE = "123e4567-e89b-42d3-a456-426614174001";
const TICKET = "123e4567-e89b-42d3-a456-426614174002";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fallback(ciphertextBytes: number, storageHash = HASH): RelayFallbackResponse {
  const exp = Math.floor(Date.now() / 1000) + 120;
  const scope = {
    v: 1, sessionId: SESSION, storageHash, deviceId: DEVICE, op: "get", exp,
    maxBytes: ciphertextBytes, role: "client", ticketId: TICKET,
  };
  return {
    kind: "relay_fallback",
    relayUrl: "wss://relay.example.test",
    sessionId: SESSION,
    ticket: `${base64Url(new TextEncoder().encode(JSON.stringify(scope)))}.${base64Url(new Uint8Array(64).fill(1))}`,
    storageHash,
    ciphertextBytes,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

class FakeSocket implements RelaySocketLike {
  readyState = 1;
  binaryType = "";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.onopen?.({}); }
  message(data: unknown): void { this.onmessage?.({ data }); }
  closeWith(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

async function hashHex(bytes: Uint8Array): Promise<string> {
  const digestInput = Uint8Array.from(bytes).buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("web encrypted read relay fallback", () => {
  test("requests a scoped ticket only through the same-origin control-plane route", async () => {
    const originalFetch = globalThis.fetch;
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = [input, init];
      return Response.json({ data: fallback(19) }, { status: 201 });
    }) as typeof fetch;
    try {
      const result = await requestRelayReadFallback({ nodeId: "abcdef0123456789abcdef01", storageHash: HASH, ciphertextBytes: 19 });
      assert.equal(result.storageHash, HASH);
      assert.equal(request?.[0], "/api/placement/relay-read");
      assert.equal(request?.[1]?.method, "POST");
      const body = JSON.parse(String(request?.[1]?.body)) as { nodeId: string; requestId: string };
      assert.equal(body.nodeId, "abcdef0123456789abcdef01");
      assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails closed when control plane scope differs or relay is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ data: fallback(20) }, { status: 201 })) as typeof fetch;
    try {
      await assert.rejects(
        requestRelayReadFallback({ nodeId: "abcdef0123456789abcdef01", storageHash: HASH, ciphertextBytes: 19 }),
        /file changed/,
      );
      globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
      await assert.rejects(
        requestRelayReadFallback({ nodeId: "abcdef0123456789abcdef01", storageHash: HASH, ciphertextBytes: 19 }),
        /temporarily unavailable/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("authenticates exact opaque ciphertext and requires the signed completion close", async () => {
    const ciphertext = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const storageHash = await hashHex(ciphertext);
    const ticketed = fallback(ciphertext.byteLength, storageHash);
    const socket = new FakeSocket();
    const received = receiveRelayCiphertext({
      fallback: ticketed,
      expectedStorageHash: storageHash,
      expectedCiphertextBytes: ciphertext.byteLength,
    }, (url) => {
      assert.equal(url, `wss://relay.example.test/relay/${SESSION}`);
      return socket;
    });
    assert.equal(socket.binaryType, "arraybuffer");
    socket.open();
    assert.deepEqual(JSON.parse(socket.sent[0] ?? "{}"), { type: "authenticate", ticket: ticketed.ticket });
    socket.message(JSON.stringify({ type: "paired" }));
    socket.message(ciphertext.slice().buffer);
    socket.closeWith(1000, "transfer_complete");
    assert.deepEqual(await received, ciphertext);
  });

  test("rejects text data, oversized frames, excess bytes, invalid scopes and abnormal close", async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const valid = fallback(bytes.byteLength);
    for (const scenario of ["text", "oversize-frame", "excess", "abnormal-close", "wrong-hash"] as const) {
      const socket = new FakeSocket();
      const expectedHash = scenario === "wrong-hash" ? "b".repeat(64) : HASH;
      const received = receiveRelayCiphertext({ fallback: valid, expectedStorageHash: expectedHash, expectedCiphertextBytes: bytes.byteLength }, () => socket);
      socket.open();
      socket.message(JSON.stringify({ type: "paired" }));
      if (scenario === "text") socket.message("not binary");
      else if (scenario === "oversize-frame") socket.message(new Uint8Array(32 * 1024 + 1).buffer);
      else if (scenario === "excess") socket.message(new Uint8Array(bytes.byteLength + 1).buffer);
      else if (scenario === "abnormal-close") socket.closeWith(1006, "network_error");
      else {
        socket.message(bytes.slice().buffer);
        socket.closeWith(1000, "transfer_complete");
      }
      await assert.rejects(received);
    }
  });

  test("keeps the server route as a ticket-only POST proxy", () => {
    const source = readFileSync(new URL("../../app/api/placement/relay-read/route.ts", import.meta.url), "utf8");
    assert.match(source, /export async function POST/);
    assert.match(source, /proxyToGateway\("\/placement\/relay-read"/);
    assert.match(source, /body: await req\.text\(\)/);
    assert.doesNotMatch(source, /arrayBuffer|ReadableStream|response\.body/i);
  });
});
