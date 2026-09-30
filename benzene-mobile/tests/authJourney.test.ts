import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidEmail, mapAuthJourneyError, passwordLengthError, requestPasswordReset, resetPassword, resendVerification, resetTokenFromInput, resetTokenFromIncomingLink, signUp } from '../src/api/authJourney';

const genericSuccess = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

test('account requests use native, normalized payloads and never retain their secrets in the session API', async () => {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = 'https://gateway.test';
  const observed: { url: string; kind: string | null; body: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    observed.push({ url: String(input), kind: new Headers(init?.headers).get('X-Benzene-Client-Kind'), body: JSON.parse(String(init?.body)) });
    return genericSuccess();
  };
  try {
    await signUp(' Ada@Example.com ', 'strong-password');
    await resendVerification(' Ada@Example.com ', 'strong-password');
    await requestPasswordReset(' Ada@Example.com ');
    await resetPassword('  one-time-token  ', 'new-password');
    assert.deepEqual(observed, [
      { url: 'https://gateway.test/auth/native/signup', kind: 'native-mobile', body: { email: 'ada@example.com', password: 'strong-password' } },
      { url: 'https://gateway.test/auth/native/resend-verification', kind: 'native-mobile', body: { email: 'ada@example.com', password: 'strong-password' } },
      { url: 'https://gateway.test/auth/forgot-password', kind: 'native-mobile', body: { email: 'ada@example.com' } },
      { url: 'https://gateway.test/auth/reset-password', kind: 'native-mobile', body: { token: 'one-time-token', newPassword: 'new-password' } },
    ]);
    assert.equal(JSON.stringify(observed).includes('one-time-token'), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
    else process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = originalOrigin;
  }
});

test('auth form helpers validate email and enforce the server password minimum', () => {
  assert.equal(isValidEmail('ada@example.com'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(passwordLengthError('1234567'), 'Use at least 8 characters for your password.');
  assert.equal(passwordLengthError('12345678'), null);
});

test('reset form accepts a pasted HTTPS reset URL without accepting other web destinations', () => {
  assert.equal(resetTokenFromInput('  one-time-token  '), 'one-time-token');
  assert.equal(resetTokenFromInput('https://vault.example/reset-password?token=one%2Ftime'), 'one/time');
  assert.equal(resetTokenFromInput('https://vault.example/login?token=one-time-token'), null);
  assert.equal(resetTokenFromInput('benzene://reset-password?token=one-time-token'), null);
});

test('incoming reset links require the configured HTTPS origin and matching Expo Router token', () => {
  const origin = 'https://vault.benzene.example';
  const url = 'https://vault.benzene.example/reset-password?token=one%2Ftime';
  assert.equal(resetTokenFromIncomingLink(url, 'one/time', origin), 'one/time');
  assert.equal(resetTokenFromIncomingLink('benzene://reset-password?token=one-time-token', 'one-time-token', origin), null);
  assert.equal(resetTokenFromIncomingLink(url, 'different-token', origin), null);
  assert.equal(resetTokenFromIncomingLink(url, ['one/time', 'second'], origin), null);
  assert.equal(resetTokenFromIncomingLink('https://evil.example/reset-password?token=one%2Ftime', 'one/time', origin), null);
  assert.equal(resetTokenFromIncomingLink('https://vault.benzene.example/other?token=one%2Ftime', 'one/time', origin), null);
  assert.equal(resetTokenFromIncomingLink('https://vault.benzene.example/reset-password?token=one&token=two', 'one', origin), null);
});

test('authentication error mapping stays useful without echoing server details', async () => {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
  process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = 'https://gateway.test';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Email already in use' }), { status: 409, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(signUp('ada@example.com', 'password123'), /An account already exists/);
    assert.equal(mapAuthJourneyError(429, 'fallback'), 'Too many attempts. Wait a while and try again.');
    assert.equal(mapAuthJourneyError(503, 'fallback'), 'fallback');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.EXPO_PUBLIC_GATEWAY_ORIGIN;
    else process.env.EXPO_PUBLIC_GATEWAY_ORIGIN = originalOrigin;
  }
});
