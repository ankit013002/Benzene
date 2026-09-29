import assert from 'node:assert/strict';
import test from 'node:test';
import { clearRefreshCache, NativeAuthContractError, parseNativeTokens, requestJson, signIn } from '../src/api/client';
import { formatBytes, isDeviceSummary, isVaultFile, isVaultSummary } from '../src/api/models';
import { requestAccountDeletion } from '../src/api/nativeSession';

test('native token responses require a complete rotating token pair and bounded expiry', () => {
  assert.deepEqual(parseNativeTokens({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer', expiresInSeconds: 900 }, 1000), {
    accessToken: 'access',
    refreshToken: 'refresh',
    accessTokenExpiresAt: 901000,
  });
  assert.throws(() => parseNativeTokens({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer' }), NativeAuthContractError);
  assert.throws(() => parseNativeTokens({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer', expiresInSeconds: 0 }), NativeAuthContractError);
});

test('native sign-in uses the native client contract', async () => {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = 'https://gateway.test';
  let loginHeader: string | null = null;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/auth/native/login')) {
      loginHeader = new Headers(init?.headers).get('X-Benzene-Client-Kind');
      return new Response(JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer', expiresInSeconds: 900, emailVerified: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('Unexpected request');
  };
  try {
    const result = await signIn('person@example.com', 'password');
    assert.equal(loginHeader, 'native-mobile');
    assert.equal(result.tokens.refreshToken, 'refresh');
    assert.equal(result.emailVerified, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
    else process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = originalOrigin;
  }
});

test('native sign-in explains the backend email-verification response', async () => {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = 'https://gateway.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Email verification required', emailVerified: false }), {
    status: 403, headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(signIn('person@example.com', 'password'), /Confirm your email/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
    else process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = originalOrigin;
  }
});

test('unverified native sign-in revokes its temporary refresh token', async () => {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = 'https://gateway.test';
  let logoutBody: unknown;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/auth/native/login')) {
      return new Response(JSON.stringify({ accessToken: 'access', refreshToken: 'temporary-refresh', tokenType: 'Bearer', expiresInSeconds: 900, emailVerified: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    assert.equal(String(input), 'https://gateway.test/auth/native/logout');
    logoutBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ message: 'Logged out successfully' }), { status: 200 });
  };
  try {
    await assert.rejects(signIn('person@example.com', 'password'), /Confirm your email/);
    assert.deepEqual(logoutBody, { refreshToken: 'temporary-refresh' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
    else process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = originalOrigin;
  }
});

test('Vault, device and file summaries reject incomplete API shapes', () => {
  assert.equal(isVaultSummary({ id: 'v', name: 'Home', rawCapacityBytes: 10, onlineCapacityBytes: 5, usedBytes: 2, deviceCount: 1, onlineDeviceCount: 1 }), true);
  assert.equal(isVaultSummary({ id: 'v', name: 'Home' }), false);
  assert.equal(isDeviceSummary({ id: 'd', name: 'Mac', platform: 'macOS', status: 'online', allocatedBytes: 10, usedBytes: 1, lastSeenAt: null, removalReady: false }), true);
  assert.equal(isDeviceSummary({ id: 'd', name: 'Mac' }), false);
  assert.equal(isVaultFile({ id: 'f', name: 'notes.txt', path: '', bytes: 4, hasContent: true, lastModified: null }), true);
  assert.equal(isVaultFile({ id: 'f', name: 'notes.txt', path: '', bytes: 4, hasContent: true, lastModified: null,
    protection: { availability: 'available', state: 'at_risk', healthyReplicas: 1, desiredReplicas: 2 } }), true);
  assert.equal(isVaultFile({ id: 'f', name: 'notes.txt', path: '', bytes: 4, hasContent: true, lastModified: null,
    protection: { availability: 'available', healthyReplicas: 'one' } }), false);
  assert.equal(isVaultFile({ id: 'f', name: 'notes.txt' }), false);
});

test('byte formatting remains readable for empty and large values', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
});

test('parallel unauthorized requests rotate a refresh token only once', async () => {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
  const previousTokens = { accessToken: 'old-access', refreshToken: 'one-use-refresh', accessTokenExpiresAt: Date.now() + 60_000 };
  const updated: string[] = [];
  let refreshRequests = 0;
  let protectedRequests = 0;
  clearRefreshCache();
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = 'https://gateway.test';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/native/refresh')) {
      refreshRequests += 1;
      assert.equal(new Headers(init?.headers).get('X-Benzene-Client-Kind'), 'native-mobile');
      return new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', tokenType: 'Bearer', expiresInSeconds: 900 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    protectedRequests += 1;
    const authorization = new Headers(init?.headers).get('authorization');
    if (authorization === 'Bearer old-access') return new Response('', { status: 401 });
    assert.equal(authorization, 'Bearer new-access');
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const refreshCallback = async (tokens: { accessToken: string }) => { updated.push(tokens.accessToken); };
    const [first, second] = await Promise.all([
      requestJson('/devices', previousTokens, refreshCallback),
      requestJson('/files', previousTokens, refreshCallback),
    ]);
    assert.deepEqual(first, { data: [] });
    assert.deepEqual(second, { data: [] });
    assert.equal(refreshRequests, 1);
    assert.equal(protectedRequests, 4);
    assert.deepEqual(updated, ['new-access', 'new-access']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
    else process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = originalOrigin;
    clearRefreshCache();
  }
});

test('account-deletion request sends credentials and stable idempotency key over HTTPS', async () => {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
  let requestBody: unknown;
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = 'https://gateway.test';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://gateway.test/auth/account-deletion');
    assert.equal(init?.method, 'POST');
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      requestId: 'deletion-1',
      status: 'cleanup_pending',
      currentPhase: 'awaiting_cleanup_operator',
      requestedAt: '2026-09-28T12:00:00.000Z',
      deletionComplete: false,
      downstreamCleanupStarted: false,
      message: 'Request recorded. Account data is not deleted.',
    }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await requestAccountDeletion('person@example.com', 'password', 'stable-idempotency-key');
    assert.equal(result.deletionComplete, false);
    assert.equal(result.downstreamCleanupStarted, false);
    assert.deepEqual(requestBody, {
      email: 'person@example.com', password: 'password', idempotencyKey: 'stable-idempotency-key',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
    else process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = originalOrigin;
  }
});
