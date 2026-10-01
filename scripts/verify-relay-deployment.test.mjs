import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRelayPublicUrl, verifyRelayDeployment } from './verify-relay-deployment.mjs';

const SESSION_ID = '2d6ce64c-83e5-4419-a58f-b1f11c7930da';

class ProbeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = new Map();
    ProbeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', {});
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(payload) {
    this.payload = payload;
    queueMicrotask(() => {
      this.readyState = 3;
      this.dispatch('close', { code: ProbeWebSocket.closeCode ?? 1008 });
    });
  }

  close() { this.readyState = 3; }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
ProbeWebSocket.closeCode = 1008;

function readinessResponse(body = { status: 'ready', service: 'benzene-relay' }, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

test('requires an origin-only public WSS URL', () => {
  assert.equal(validateRelayPublicUrl('wss://relay.benzene.com').hostname, 'relay.benzene.com');
  for (const value of [
    'https://relay.benzene.com',
    'wss://relay.benzene.com:8443',
    'wss://relay.benzene.com/relay',
    'wss://user:secret@relay.benzene.com',
    'wss://relay.example.com',
    'wss://relay.localhost',
    'wss://192.168.1.10',
  ]) assert.throws(() => validateRelayPublicUrl(value));
});

test('rejects DNS answers that route the public relay name to a private address', async () => {
  await assert.rejects(verifyRelayDeployment('wss://relay.benzene.com', {
    lookup: async () => [{ address: '10.0.0.12', family: 4 }],
  }), /private or reserved address/);
});

test('requires database-backed relay readiness before probing WSS', async () => {
  await assert.rejects(verifyRelayDeployment('wss://relay.benzene.com', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => readinessResponse({ status: 'not_ready' }),
    WebSocketImpl: ProbeWebSocket,
  }), /did not report a ready Benzene relay/);
  await assert.rejects(verifyRelayDeployment('wss://relay.benzene.com', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => readinessResponse(undefined, { 'cache-control': 'public, max-age=60' }),
    WebSocketImpl: ProbeWebSocket,
  }), /no-store safeguard/);
});

test('proves public HTTPS readiness and WSS ingress rejects an invalid ticket', async () => {
  ProbeWebSocket.instances = [];
  ProbeWebSocket.closeCode = 1008;
  const fetches = [];
  const results = await verifyRelayDeployment('wss://relay.benzene.com', {
    lookup: async (hostname) => {
      assert.equal(hostname, 'relay.benzene.com');
      return [{ address: '8.8.8.8', family: 4 }];
    },
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return readinessResponse();
    },
    WebSocketImpl: ProbeWebSocket,
    sessionId: SESSION_ID,
  });

  assert.deepEqual(results, ['public DNS', 'HTTPS readiness', 'WSS upgrade and invalid-ticket rejection']);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, 'https://relay.benzene.com/ready');
  assert.equal(fetches[0].options.redirect, 'manual');
  assert.equal(ProbeWebSocket.instances[0].url, `wss://relay.benzene.com/relay/${SESSION_ID}`);
  assert.deepEqual(JSON.parse(ProbeWebSocket.instances[0].payload), {
    type: 'authenticate', ticket: 'invalid-deployment-probe',
  });
});

test('fails when the WSS endpoint accepts or inconsistently rejects the invalid ticket', async () => {
  ProbeWebSocket.closeCode = 1000;
  await assert.rejects(verifyRelayDeployment('wss://relay.benzene.com', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => readinessResponse(),
    WebSocketImpl: ProbeWebSocket,
    sessionId: SESSION_ID,
  }), /unexpected close code 1000/);
  ProbeWebSocket.closeCode = 1008;
});
