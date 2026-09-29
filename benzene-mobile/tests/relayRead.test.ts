import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api/client';
import { requestRelayReadFallback } from '../src/api/relayRead';

const requestInput = {
  nodeId: '0123456789abcdef01234567',
  requestId: '11111111-1111-4111-8111-111111111111',
  storageHash: 'a'.repeat(64),
  ciphertextBytes: 32,
};

function fallbackResponse() {
  return {
    data: {
      kind: 'relay_fallback',
      relayUrl: 'wss://relay.example',
      sessionId: '22222222-2222-4222-8222-222222222222',
      ticket: 'client-ticket-not-logged',
      storageHash: requestInput.storageHash,
      ciphertextBytes: requestInput.ciphertextBytes,
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  };
}

test('relay fallback maps the control-plane contract and preserves its retry identity', async () => {
  const observed: { path?: string; method?: string; body?: string; contentType?: string | null } = {};
  let calls = 0;
  const response = await requestRelayReadFallback(async (path, init) => {
    calls += 1;
    observed.path = path;
    observed.method = init?.method;
    observed.body = typeof init?.body === 'string' ? init.body : undefined;
    observed.contentType = new Headers(init?.headers).get('content-type');
    return fallbackResponse();
  }, requestInput);

  assert.equal(calls, 1);
  assert.deepEqual(observed, {
    path: '/placement/relay-read',
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ nodeId: requestInput.nodeId, requestId: requestInput.requestId }),
  });
  assert.equal(response.kind, 'relay_fallback');
  assert.equal(response.ticket, 'client-ticket-not-logged');
  assert.equal(response.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.equal('nodeTicket' in response, false);
});

test('relay fallback rejects changed encrypted-object identity and malformed control-plane payloads', async () => {
  await assert.rejects(requestRelayReadFallback(async () => ({
    data: { ...fallbackResponse().data, storageHash: 'b'.repeat(64) },
  }), requestInput), /file changed/);
  await assert.rejects(requestRelayReadFallback(async () => ({ data: { ...fallbackResponse().data, nodeTicket: 'never expose this' } }), requestInput), /invalid secure relay response/);
  await assert.rejects(requestRelayReadFallback(async () => ({ data: { ...fallbackResponse().data, expiresAt: 'not-a-date' } }), requestInput), /invalid secure relay response/);
  await assert.rejects(requestRelayReadFallback(async () => ({ data: { kind: 'direct' } }), requestInput), /invalid secure relay response/);
});

test('relay fallback maps bounded service errors without returning upstream response text', async () => {
  await assert.rejects(requestRelayReadFallback(async () => { throw new ApiError('private upstream details', 409); }, requestInput), /No online encrypted copy/);
  await assert.rejects(requestRelayReadFallback(async () => { throw new ApiError('private upstream details', 429); }, requestInput), /Too many secure relay attempts/);
  await assert.rejects(requestRelayReadFallback(async () => { throw new ApiError('private upstream details', 503); }, requestInput), /temporarily unavailable/);
  await assert.rejects(requestRelayReadFallback(async () => { throw new Error('private upstream details'); }, requestInput), (error: unknown) => {
    assert.match(error instanceof Error ? error.message : '', /could not arrange a secure relay/);
    assert.doesNotMatch(error instanceof Error ? error.message : '', /private upstream details/);
    return true;
  });
});
