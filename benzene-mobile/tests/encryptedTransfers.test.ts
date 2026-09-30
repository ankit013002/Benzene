import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeBase64Url, hexToBytes } from '../src/crypto/bytes';
import type { EncryptedObjectMetadata } from '../src/crypto/encryptedObjectCore';
import { downloadEncryptedCurrentFile, MAX_ENCRYPTED_FILE_BYTES, uploadEncryptedFile } from '../src/files/encryptedTransfers';

type Fixture = { vaultId: string; vaultMasterKeyHex: string; plaintextBase64Url: string; ciphertextBase64Url: string; metadata: EncryptedObjectMetadata };
const fixture = JSON.parse(readFileSync('../contracts/encrypted-object-v1/vectors.json', 'utf8')) as Fixture;
const plaintext = decodeBase64Url(fixture.plaintextBase64Url, 'plaintext');
const ciphertext = decodeBase64Url(fixture.ciphertextBase64Url, 'ciphertext');
const vmk = hexToBytes(fixture.vaultMasterKeyHex, 'VMK');

function target(deviceId: string, deviceName: string, grant: string, hash = fixture.metadata.storageHash) {
  return { deviceId, deviceName, url: `https://device-${deviceId}.example/objects/${hash}`, grant, expiresAt: '2026-09-28T19:00:00.000Z' };
}

test('encrypted upload sends only metadata through the bearer request and ciphertext to every granted target', async () => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const transfers: { url: string; init?: RequestInit }[] = [];
  const result = await uploadEncryptedFile({
    name: 'secret.txt', path: '', contentType: 'text/plain', plaintext, vaultId: fixture.vaultId,
    encrypt: async () => ({ metadata: fixture.metadata, ciphertext }),
  }, {
    allowInsecureLanTransfers: false,
    request: async (path, init) => {
      requests.push({ path, init });
      if (path.endsWith('/complete')) return { data: { completed: [{ nodeId: 'node-1', shortfall: true, protection: { desiredReplicas: 2, healthyReplicas: 1 } }] } };
      return { data: { versionId: 'version-1', storageHash: fixture.metadata.storageHash, placement: {
        alreadyHeldBy: [], shortfall: false, targets: [target('a', 'Desk', 'put-a'), target('b', 'Laptop', 'put-b')],
      } } };
    },
    directFetch: async (url, init) => {
      transfers.push({ url, init });
      return new Response('', { status: url.includes('device-a') ? 201 : 503 });
    },
  });
  assert.equal(requests[0]?.path, '/files/uploads/device/v1/encrypted');
  const reservationBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(reservationBody.name, 'secret.txt');
  assert.deepEqual(reservationBody.encryptedObject, fixture.metadata);
  assert.equal('ciphertext' in reservationBody, false);
  assert.equal('plaintext' in reservationBody, false);
  assert.equal(requests[1]?.path, '/files/uploads/device/v1/encrypted/complete');
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { versionIds: ['version-1'] });
  assert.equal(transfers.length, 2);
  assert.deepEqual(transfers.map(({ init }) => new Headers(init?.headers).get('x-transfer-grant')), ['put-a', 'put-b']);
  assert.deepEqual(new Uint8Array(transfers[0]?.init?.body as ArrayBuffer), ciphertext);
  assert.equal(new Headers(transfers[0]?.init?.headers).get('authorization'), null);
  assert.equal(result.shortfall, true);
  assert.equal(result.warnings.length, 2);
});

test('encrypted upload stops at the mobile size limit before encryption or network access', async () => {
  let encrypted = false;
  await assert.rejects(uploadEncryptedFile({
    name: 'large.bin', path: '', contentType: 'application/octet-stream',
    plaintext: new Uint8Array(MAX_ENCRYPTED_FILE_BYTES + 1), vaultId: fixture.vaultId,
    encrypt: async () => { encrypted = true; return { metadata: fixture.metadata, ciphertext }; },
  }, {
    request: async () => { throw new Error('Must not call the control plane'); },
    directFetch: async () => { throw new Error('Must not call a device'); },
    allowInsecureLanTransfers: false,
  }), /larger than 25 MB/);
  assert.equal(encrypted, false);
});

test('encrypted upload gives an explicit unreachable-device error without completing an unconfirmed version', async () => {
  const paths: string[] = [];
  await assert.rejects(uploadEncryptedFile({
    name: 'secret.txt', path: '', contentType: 'text/plain', plaintext, vaultId: fixture.vaultId,
    encrypt: async () => ({ metadata: fixture.metadata, ciphertext }),
  }, {
    request: async (path) => {
      paths.push(path);
      return { data: { versionId: 'version-1', storageHash: fixture.metadata.storageHash, placement: {
        alreadyHeldBy: [], shortfall: false, targets: [target('a', 'Desk', 'put-a')],
      } } };
    },
    directFetch: async () => { throw new Error('offline'); },
    allowInsecureLanTransfers: false,
  }), /No device confirmed this upload/);
  assert.deepEqual(paths, ['/files/uploads/device/v1/encrypted']);
});

test('encrypted download falls back to another holder and exports only authenticated plaintext', async () => {
  const requested: string[] = [];
  const direct: string[] = [];
  let relayRequested = false;
  let exported: Uint8Array | undefined;
  await downloadEncryptedCurrentFile({
    nodeId: 'file-node', filename: 'secret.txt', contentType: 'text/plain', availability: 'available',
    vaultId: fixture.vaultId, vmk,
    decrypt: (metadata, received, key) => {
      assert.deepEqual(metadata, fixture.metadata);
      assert.deepEqual(key, vmk);
      if (received[0] === 0) throw new Error('bad ciphertext');
      assert.deepEqual(received, ciphertext);
      return plaintext.slice();
    },
    exportPlaintext: async (_name, _type, bytes) => { exported = bytes.slice(); },
  }, {
    allowInsecureLanTransfers: false,
    request: async (path) => {
      requested.push(path);
      if (path.includes('/encrypted-object')) return { data: { encryptedObject: fixture.metadata } };
      return { data: { targets: [target('a', 'Desk', 'get-a'), target('b', 'Laptop', 'get-b')] } };
    },
    directFetch: async (url, init) => {
      direct.push(url);
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(ciphertext.byteLength) } });
      const body = url.includes('device-a') ? new Uint8Array(ciphertext.length).fill(0) : ciphertext;
      return new Response(body.slice().buffer, { status: 200 });
    },
    relayFallback: async () => { relayRequested = true; return null; },
  });
  assert.deepEqual(requested, ['/files/file-node/encrypted-object', `/placement/download-targets/${fixture.metadata.storageHash}`]);
  assert.equal(direct.length, 4);
  assert.equal(relayRequested, false, 'a valid direct copy must finish before encrypted relay fallback is considered');
  assert.deepEqual(exported, plaintext);
});

test('encrypted download distinguishes no-key, unavailable, and waiting-for-device states', async () => {
  const dependencies = { request: async () => { throw new Error('Should not request the control plane'); }, directFetch: async () => new Response(), allowInsecureLanTransfers: false };
  const base = { nodeId: 'file-node', filename: 'secret.txt', contentType: 'text/plain', vaultId: fixture.vaultId, vmk, decrypt: () => plaintext, exportPlaintext: async () => {} };
  await assert.rejects(downloadEncryptedCurrentFile({ ...base, vmk: new Uint8Array(0) }, dependencies), /No Vault key/);
  await assert.rejects(downloadEncryptedCurrentFile({ ...base, availability: 'unavailable' }, dependencies), /unavailable/);
  await assert.rejects(downloadEncryptedCurrentFile({ ...base, availability: 'waiting_for_device' }, dependencies), /waiting/);
});

test('encrypted download refuses an incomplete or empty read plan and never exports bytes', async () => {
  let exported = false;
  await assert.rejects(downloadEncryptedCurrentFile({
    nodeId: 'file-node', filename: 'secret.txt', contentType: 'text/plain', vaultId: fixture.vaultId, vmk,
    decrypt: () => plaintext,
    exportPlaintext: async () => { exported = true; },
  }, {
    allowInsecureLanTransfers: false,
    request: async (path) => path.includes('/encrypted-object') ? { data: { encryptedObject: fixture.metadata } } : { data: { targets: [] } },
    directFetch: async () => new Response(),
  }), /No online storage device/);
  assert.equal(exported, false);
});

test('transfer grants never go to insecure non-LAN URLs or hostname prefix lookalikes', async () => {
  const paths: string[] = [];
  await assert.rejects(uploadEncryptedFile({
    name: 'secret.txt', path: '', contentType: 'text/plain', plaintext, vaultId: fixture.vaultId,
    encrypt: async () => ({ metadata: fixture.metadata, ciphertext }),
  }, {
    request: async (path) => {
      paths.push(path);
      return { data: { versionId: 'version-1', storageHash: fixture.metadata.storageHash, placement: {
        alreadyHeldBy: [], shortfall: false, targets: [{ ...target('a', 'Desk', 'put-a'), url: target('a', 'Desk', 'put-a').url.replace('https:', 'http:').replace('device-a.example', 'public.example') }],
      } } };
    },
    directFetch: async () => { throw new Error('Must reject URL before sending grant'); },
    allowInsecureLanTransfers: true,
  }), /unsafe or invalid storage-device target/);
  assert.deepEqual(paths, ['/files/uploads/device/v1/encrypted']);

  await assert.rejects(uploadEncryptedFile({
    name: 'secret.txt', path: '', contentType: 'text/plain', plaintext, vaultId: fixture.vaultId,
    encrypt: async () => ({ metadata: fixture.metadata, ciphertext }),
  }, {
    request: async () => ({ data: { versionId: 'version-1', storageHash: fixture.metadata.storageHash, placement: {
      alreadyHeldBy: [], shortfall: false, targets: [{ ...target('a', 'Desk', 'put-a'), url: target('a', 'Desk', 'put-a').url.replace('https:', 'http:').replace('device-a.example', 'fcevil.example') }],
    } } }),
    directFetch: async () => { throw new Error('Must reject URL before sending grant'); },
    allowInsecureLanTransfers: true,
  }), /unsafe or invalid storage-device target/);
});

test('encrypted download rejects mismatched HEAD size without fetching the ciphertext body', async () => {
  let exported = false;
  const methods: string[] = [];
  await assert.rejects(downloadEncryptedCurrentFile({
    nodeId: 'file-node', filename: 'secret.txt', contentType: 'text/plain', vaultId: fixture.vaultId, vmk,
    decrypt: () => plaintext,
    exportPlaintext: async () => { exported = true; },
  }, {
    allowInsecureLanTransfers: false,
    request: async (path) => path.includes('/encrypted-object') ? { data: { encryptedObject: fixture.metadata } } : { data: { targets: [target('a', 'Desk', 'get-a')] } },
    directFetch: async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return new Response(null, { status: 200, headers: { 'content-length': String(ciphertext.byteLength + 1) } });
    },
  }), /valid, decryptable copy/);
  assert.deepEqual(methods, ['HEAD']);
  assert.equal(exported, false);
});

test('encrypted download keeps its timeout active through a stalled body and falls back', async () => {
  const calls: string[] = [];
  let exported = false;
  await downloadEncryptedCurrentFile({
    nodeId: 'file-node', filename: 'secret.txt', contentType: 'text/plain', vaultId: fixture.vaultId, vmk,
    decrypt: () => plaintext,
    exportPlaintext: async () => { exported = true; },
  }, {
    allowInsecureLanTransfers: false,
    timeoutMs: 8,
    request: async (path) => path.includes('/encrypted-object') ? { data: { encryptedObject: fixture.metadata } } : { data: { targets: [target('a', 'Desk', 'get-a'), target('b', 'Laptop', 'get-b')] } },
    directFetch: async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${url}:${method}`);
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(ciphertext.byteLength) } });
      if (url.includes('device-a')) {
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(ciphertext.byteLength) }),
          arrayBuffer: () => new Promise<ArrayBuffer>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        } as Response;
      }
      return new Response(ciphertext.slice().buffer, { status: 200, headers: { 'content-length': String(ciphertext.byteLength) } });
    },
  });
  assert.deepEqual(calls, [
    `${target('a', 'Desk', 'get-a').url}:HEAD`, `${target('a', 'Desk', 'get-a').url}:GET`,
    `${target('b', 'Laptop', 'get-b').url}:HEAD`, `${target('b', 'Laptop', 'get-b').url}:GET`,
  ]);
  assert.equal(exported, true);
});
