import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePublicHttpsUrl, verifyMobileStoreDeployment } from './verify-mobile-store-deployment.mjs';

const fingerprint = 'AA:'.repeat(31) + 'AA';
const config = {
  origin: 'https://benzene-release-check.com',
  passwordResetUrl: 'https://benzene-release-check.com/reset-password',
  iosTeamId: 'A1B2C3D4E5',
  iosBundleId: 'com.publisher.benzene',
  androidPackageName: 'com.publisher.benzene',
  androidSha256Fingerprints: fingerprint,
};

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0', 'x-content-type-options': 'nosniff', ...headers },
  });
}

function associationBodies() {
  return {
    apple: { applinks: { apps: [], details: [{ appID: 'A1B2C3D4E5.com.publisher.benzene', paths: ['/reset-password'] }] } },
    android: [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.publisher.benzene', sha256_cert_fingerprints: [fingerprint] },
    }],
  };
}

function harness(overrides = {}) {
  const requested = [];
  const bodies = associationBodies();
  const fetchImpl = async (url, options) => {
    requested.push({ url: new URL(url), options });
    if (overrides.fetchImpl) return overrides.fetchImpl(url, options, bodies);
    const path = new URL(url).pathname;
    if (path.startsWith('/.well-known/apple')) return json(overrides.appleBody ?? bodies.apple, overrides.appleResponse);
    if (path.endsWith('/assetlinks.json')) return json(overrides.androidBody ?? bodies.android, overrides.androidResponse);
    return new Response('<!doctype html><title>Public information</title>', { status: overrides.pageStatus ?? 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  return { requested, fetchImpl, lookup };
}

test('verifies public legal pages and exact publisher associations over same-origin HTTPS', async () => {
  const { requested, fetchImpl, lookup } = harness();
  const result = await verifyMobileStoreDeployment(config, { fetchImpl, lookup });
  assert.equal(result.length, 6);
  assert.deepEqual(requested.map(({ url }) => url.pathname), [
    '/privacy', '/terms', '/support', '/account-deletion',
    '/.well-known/apple-app-site-association', '/.well-known/assetlinks.json',
  ]);
  for (const request of requested) {
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'manual');
    assert.equal(request.options.signal instanceof AbortSignal, true);
    assert.equal(request.options.headers.authorization, undefined);
    assert.equal(request.options.headers.cookie, undefined);
  }
});

test('fails closed on missing, local, private, placeholder, non-HTTPS, or wrong-path URLs', async () => {
  for (const value of [
    'http://benzene-release-check.com', 'https://localhost', 'https://192.168.1.3',
    'https://service.example.com', 'https://benzene.invalid',
  ]) assert.throws(() => validatePublicHttpsUrl(value));
  assert.throws(() => validatePublicHttpsUrl('https://benzene-release-check.com/store', { originOnly: true }));
  assert.throws(() => validatePublicHttpsUrl('https://benzene-release-check.com:8443', { originOnly: true }));
  assert.throws(() => validatePublicHttpsUrl('https://benzene-release-check.com/reset-password?token=do-not-print', { requiredPath: '/reset-password' }));
  await assert.rejects(verifyMobileStoreDeployment({ ...config, passwordResetUrl: 'https://benzene-release-check.com/not-reset' }, harness()), /must use \/reset-password/);
});

test('rejects hostnames whose DNS answers include a private address', async () => {
  const { fetchImpl } = harness();
  await assert.rejects(verifyMobileStoreDeployment(config, {
    fetchImpl,
    lookup: async () => [{ address: '10.0.0.4', family: 4 }],
  }), /private or reserved address/);
});

test('rejects public information pages that require authentication or have wrong content type', async () => {
  await assert.rejects(verifyMobileStoreDeployment(config, { ...harness(), fetchImpl: async () => new Response('Sign in', { status: 401, headers: { 'content-type': 'text/html' } }) }), /not publicly reachable/);
  await assert.rejects(verifyMobileStoreDeployment(config, { ...harness(), fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }), /unexpected content type/);
});

test('rejects redirects to another origin without following them', async () => {
  let followed = false;
  const { lookup } = harness();
  await assert.rejects(verifyMobileStoreDeployment(config, {
    lookup,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://other-domain.com/privacy' } }),
  }), /different origin/);
  assert.equal(followed, false);
});

test('rejects broad Apple association scopes and unexpected publisher IDs', async () => {
  const broad = { applinks: { apps: [], details: [{ appID: 'A1B2C3D4E5.com.publisher.benzene', paths: ['*'] }] } };
  await assert.rejects(verifyMobileStoreDeployment(config, { ...harness(), fetchImpl: async (url) => {
    if (new URL(url).pathname === '/.well-known/apple-app-site-association') return json(broad);
    return harness().fetchImpl(url, { method: 'GET' });
  } }), /reset-only route/);
});

test('requires association JSON to be valid, no-store, and protected by nosniff', async () => {
  const malformed = harness({ appleResponse: { headers: { 'content-type': 'application/json' } } });
  malformed.fetchImpl = async (url) => new URL(url).pathname === '/.well-known/apple-app-site-association'
    ? json('{malformed', { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    : harness().fetchImpl(url, { method: 'GET' });
  await assert.rejects(verifyMobileStoreDeployment(config, malformed), /malformed JSON/);

  const noStore = harness({ appleResponse: { headers: { 'cache-control': 'public, max-age=600' } } });
  await assert.rejects(verifyMobileStoreDeployment(config, noStore), /no-store/);

  const noSniff = harness({ appleResponse: { headers: { 'x-content-type-options': 'sameorigin' } } });
  await assert.rejects(verifyMobileStoreDeployment(config, noSniff), /nosniff/);
});

test('rejects Android association mismatches and extra app claims', async () => {
  const wrong = [{ ...associationBodies().android[0], target: { ...associationBodies().android[0].target, package_name: 'com.other.app' } }];
  const first = harness({ androidBody: wrong });
  await assert.rejects(verifyMobileStoreDeployment(config, first), /Android asset links do not exactly match/);

  const extra = [...associationBodies().android, ...associationBodies().android];
  await assert.rejects(verifyMobileStoreDeployment(config, harness({ androidBody: extra })), /Android asset links do not exactly match/);
});

test('rejects a password-reset URL on a different origin and invalid fingerprints', async () => {
  await assert.rejects(verifyMobileStoreDeployment({ ...config, passwordResetUrl: 'https://other-domain.com/reset-password' }, harness()), /configured store origin/);
  await assert.rejects(verifyMobileStoreDeployment({ ...config, androidSha256Fingerprints: 'not-a-fingerprint' }, harness()), /signing fingerprints/);
});
