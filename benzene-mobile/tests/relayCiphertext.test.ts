import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, decodeBase64Url, encodeBase64Url, hexToBytes } from '../src/crypto/bytes';
import { decryptObject, type EncryptedObjectMetadata } from '../src/crypto/encryptedObjectCore';
import { downloadEncryptedCurrentFile, MAX_ENCRYPTED_FILE_BYTES } from '../src/files/encryptedTransfers';
import { receiveRelayCiphertext, type RelayFallbackResponse, type RelaySocketLike, type RelayWebSocketFactory } from '../src/files/relayCiphertext';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TICKET_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const testCiphertext = Uint8Array.from({ length: 16 }, (_value, index) => index + 1);

class FakeSocket implements RelaySocketLike {
  readyState = 0;
  binaryType = '';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  onPaired?: (socket: FakeSocket) => void;

  send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => {
      this.message(JSON.stringify({ type: 'paired' }));
      this.onPaired?.(this);
    });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(data: unknown): void { this.onmessage?.({ data }); }

  binary(bytes: Uint8Array): void {
    const frame = bytes.slice();
    this.message(frame.buffer);
  }

  serverClose(code = 1000, reason = 'transfer_complete'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

function signedScopeTicket(storageHash: string, maxBytes: number, sessionId = SESSION_ID, role = 'client', op = 'get'): string {
  const scope = {
    v: 1, sessionId, ticketId: TICKET_ID, storageHash, deviceId: DEVICE_ID,
    op, role, exp: Math.floor(Date.now() / 1000) + 240, maxBytes,
  };
  return `${encodeBase64Url(new TextEncoder().encode(JSON.stringify(scope)))}.${encodeBase64Url(new Uint8Array(64).fill(1))}`;
}

function fallbackFor(bytes: Uint8Array): RelayFallbackResponse {
  const storageHash = bytesToHex(sha256(bytes));
  const ticket = signedScopeTicket(storageHash, bytes.byteLength);
  const scopePart = ticket.split('.')[0] ?? '';
  const scope = JSON.parse(new TextDecoder().decode(decodeBase64Url(scopePart, 'scope'))) as { exp: number };
  return {
    kind: 'relay_fallback', relayUrl: 'wss://relay.example', sessionId: SESSION_ID,
    ticket, storageHash, ciphertextBytes: bytes.byteLength, expiresAt: new Date(scope.exp * 1000).toISOString(),
  };
}

function createFactory(flow?: (socket: FakeSocket) => void): { factory: RelayWebSocketFactory; socket: FakeSocket; urls: string[] } {
  const socket = new FakeSocket();
  if (flow) socket.onPaired = flow;
  const urls: string[] = [];
  return {
    socket,
    urls,
    factory: (url) => {
      urls.push(url);
      setTimeout(() => socket.open(), 0);
      return socket;
    },
  };
}

function receive(fallback: unknown, expected: Uint8Array, factory: RelayWebSocketFactory, timeoutMs = 100): Promise<Uint8Array> {
  return receiveRelayCiphertext({
    fallback,
    expectedStorageHash: bytesToHex(sha256(expected)),
    expectedCiphertextBytes: expected.byteLength,
    timeoutMs,
  }, factory);
}

test('relay receive authenticates its explicit ticket scope and assembles bounded binary frames', async () => {
  const bytes = testCiphertext.slice();
  const fallback = fallbackFor(bytes);
  const harness = createFactory((socket) => {
    socket.binary(bytes.slice(0, 7));
    socket.binary(bytes.slice(7));
    socket.serverClose();
  });
  const result = await receive(fallback, bytes, harness.factory);
  assert.deepEqual(result, bytes);
  assert.equal(harness.socket.binaryType, 'arraybuffer');
  assert.deepEqual(harness.socket.sent.map((message) => JSON.parse(message)), [{ type: 'authenticate', ticket: fallback.ticket }]);
  assert.deepEqual(harness.urls, [`wss://relay.example/relay/${SESSION_ID}`]);
});

test('relay receive refuses direct or unrecognized responses before opening a socket', async () => {
  let opened = false;
  const factory: RelayWebSocketFactory = () => { opened = true; return new FakeSocket(); };
  await assert.rejects(receive({ ...fallbackFor(testCiphertext), kind: 'direct' }, testCiphertext, factory), /explicit relay fallback/);
  assert.equal(opened, false);
});

test('relay receive rejects a fallback whose signed hash, size, role, operation, or session differs', async () => {
  const bytes = testCiphertext.slice();
  const fallback = fallbackFor(bytes);
  const mismatched = { ...fallback, storageHash: 'f'.repeat(64) };
  let opened = false;
  const factory: RelayWebSocketFactory = () => { opened = true; return new FakeSocket(); };
  await assert.rejects(receive(mismatched, bytes, factory), /does not match/);
  await assert.rejects(receive({ ...fallback, ciphertextBytes: bytes.byteLength + 1 }, bytes, factory), /does not match/);
  await assert.rejects(receive({ ...fallback, ticket: signedScopeTicket(fallback.storageHash, bytes.byteLength, '44444444-4444-4444-8444-444444444444') }, bytes, factory), /does not authorize/);
  await assert.rejects(receive({ ...fallback, ticket: signedScopeTicket(fallback.storageHash, bytes.byteLength, SESSION_ID, 'node') }, bytes, factory), /does not authorize/);
  await assert.rejects(receive({ ...fallback, ticket: signedScopeTicket(fallback.storageHash, bytes.byteLength, SESSION_ID, 'client', 'put') }, bytes, factory), /does not authorize/);
  assert.equal(opened, false);
});

test('relay receive rejects a valid-length stream whose ciphertext hash differs', async () => {
  const expected = testCiphertext.slice();
  const harness = createFactory((socket) => {
    const changed = expected.slice(); changed[15] = 99; socket.binary(changed);
    socket.serverClose();
  });
  await assert.rejects(receive(fallbackFor(expected), expected, harness.factory), /storageHash/);
});

test('relay receive accepts no text or empty data frames after pairing', async () => {
  const bytes = testCiphertext.slice();
  for (const invalidFrame of ['not binary', new Uint8Array(0)]) {
    const harness = createFactory((socket) => {
      socket.message(invalidFrame);
    });
    await assert.rejects(receive(fallbackFor(bytes), bytes, harness.factory), /non-binary or empty/);
    assert.equal(harness.socket.closed, true);
  }
});

test('relay receive rejects oversized frames and ciphertext beyond the exact byte ceiling', async () => {
  const bytes = testCiphertext.slice();
  const oversized = createFactory((socket) => {
    socket.binary(new Uint8Array(32 * 1024 + 1));
  });
  await assert.rejects(receive(fallbackFor(bytes), bytes, oversized.factory), /frame larger/);
  const overrun = createFactory((socket) => {
    socket.binary(new Uint8Array(bytes.byteLength + 1));
  });
  await assert.rejects(receive(fallbackFor(bytes), bytes, overrun.factory), /more ciphertext than expected/);
});

test('relay receive rejects ciphertext sizes above the existing mobile cap before allocating or connecting', async () => {
  const expectedCiphertextBytes = MAX_ENCRYPTED_FILE_BYTES + 17;
  const storageHash = 'a'.repeat(64);
  const fallback: RelayFallbackResponse = {
    kind: 'relay_fallback', relayUrl: 'wss://relay.example', sessionId: SESSION_ID,
    ticket: signedScopeTicket(storageHash, expectedCiphertextBytes), storageHash, ciphertextBytes: expectedCiphertextBytes,
    expiresAt: new Date((Math.floor(Date.now() / 1000) + 240) * 1000).toISOString(),
  };
  let opened = false;
  const factory: RelayWebSocketFactory = () => { opened = true; return new FakeSocket(); };
  await assert.rejects(receiveRelayCiphertext({ fallback, expectedStorageHash: storageHash, expectedCiphertextBytes }, factory), /does not match/);
  assert.equal(opened, false);
});

test('relay receive requires the complete byte count and the exact successful close reason', async () => {
  const bytes = testCiphertext.slice();
  const short = createFactory((socket) => {
    socket.binary(bytes.slice(0, 2));
    socket.serverClose();
  });
  await assert.rejects(receive(fallbackFor(bytes), bytes, short.factory), /exact ciphertext length/);
  const earlyClose = createFactory((socket) => socket.serverClose());
  await assert.rejects(receive(fallbackFor(bytes), bytes, earlyClose.factory), /exact ciphertext length/);
  const wrongReason = createFactory((socket) => {
    socket.binary(bytes);
    socket.serverClose(1000, 'peer_disconnected');
  });
  await assert.rejects(receive(fallbackFor(bytes), bytes, wrongReason.factory), /before completing/);
});

test('relay receive enforces a bounded timeout and closes the stalled socket', async () => {
  const bytes = testCiphertext.slice();
  const harness = createFactory();
  await assert.rejects(receive(fallbackFor(bytes), bytes, harness.factory, 5), /timed out/);
  assert.equal(harness.socket.closed, true);
});

test('relay ciphertext is authenticated with the existing encrypted-object format before export', async () => {
  type Fixture = { vaultId: string; vaultMasterKeyHex: string; plaintextBase64Url: string; ciphertextBase64Url: string; metadata: EncryptedObjectMetadata };
  const fixture = JSON.parse(readFileSync('../contracts/encrypted-object-v1/vectors.json', 'utf8')) as Fixture;
  const ciphertext = decodeBase64Url(fixture.ciphertextBase64Url, 'ciphertext');
  const expectedPlaintext = decodeBase64Url(fixture.plaintextBase64Url, 'plaintext');
  const vmk = hexToBytes(fixture.vaultMasterKeyHex, 'VMK');
  let exported: Uint8Array | undefined;
  const directCalls: string[] = [];
  const harness = createFactory((socket) => {
    for (let offset = 0; offset < ciphertext.byteLength; offset += 7) socket.binary(ciphertext.subarray(offset, offset + 7));
    socket.serverClose();
  });
  try {
    await downloadEncryptedCurrentFile({
      nodeId: '444444444444444444444444', filename: 'note.txt', contentType: 'text/plain', vaultId: fixture.vaultId, vmk,
      decrypt: decryptObject,
      exportPlaintext: async (_name, _contentType, plaintext) => { exported = plaintext.slice(); },
    }, {
      allowInsecureLanTransfers: false,
      request: async (path) => path.includes('/encrypted-object')
        ? { data: { encryptedObject: fixture.metadata } }
        : { data: { targets: [{
          deviceId: DEVICE_ID,
          deviceName: 'Home computer',
          url: `https://device.example/objects/${fixture.metadata.storageHash}`,
          grant: 'short-lived-device-grant',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }] } },
      directFetch: async (_url, init) => {
        directCalls.push(init?.method ?? 'GET');
        if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(ciphertext.byteLength) } });
        throw new Error('The direct device became unreachable');
      },
      relayFallback: async (request) => {
        assert.deepEqual(directCalls, ['HEAD', 'GET']);
        assert.deepEqual(request, { nodeId: '444444444444444444444444', storageHash: fixture.metadata.storageHash, ciphertextBytes: ciphertext.byteLength });
        return fallbackFor(ciphertext);
      },
      relayWebSocketFactory: harness.factory,
    });
    assert.deepEqual(directCalls, ['HEAD', 'GET']);
    assert.deepEqual(exported, expectedPlaintext);
  } finally {
    vmk.fill(0);
    ciphertext.fill(0);
    expectedPlaintext.fill(0);
  }
});
