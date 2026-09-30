import assert from 'node:assert/strict';
import test from 'node:test';
import { GET as getAppleAssociation } from './apple-app-site-association/route';
import { GET as getAndroidAssetLinks } from './assetlinks.json/route';

const envNames = [
  'APPLE_APP_LINK_TEAM_ID',
  'APPLE_APP_LINK_BUNDLE_ID',
  'ANDROID_APP_LINK_APPLICATION_ID',
  'ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS',
] as const;

function withEnvironment<T>(values: Partial<Record<(typeof envNames)[number], string>>, action: () => T): T {
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return action();
  } finally {
    for (const name of envNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('app-link association routes fail closed without publisher configuration', async () => {
  const [apple, android] = withEnvironment({}, () => [getAppleAssociation(), getAndroidAssetLinks()]);
  assert.equal(apple.status, 404);
  assert.equal(android.status, 404);
  for (const response of [apple, android]) {
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('Apple association is limited to the password-reset route', async () => {
  const response = withEnvironment({
    APPLE_APP_LINK_TEAM_ID: 'A1B2C3D4E5',
    APPLE_APP_LINK_BUNDLE_ID: 'com.publisher.benzene',
  }, () => getAppleAssociation());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const body = await response.json();
  assert.deepEqual(body, { applinks: { apps: [], details: [{ appID: 'A1B2C3D4E5.com.publisher.benzene', paths: ['/reset-password'] }] } });
});

test('Android asset links validate publisher package and signing fingerprints', async () => {
  const fingerprint = 'AA:'.repeat(31) + 'AA';
  const response = withEnvironment({
    ANDROID_APP_LINK_APPLICATION_ID: 'com.publisher.benzene',
    ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS: `${fingerprint},${'BB:'.repeat(31)}BB`,
  }, () => getAndroidAssetLinks());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const responseBody = await response.json();
  assert.deepEqual(responseBody, [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.publisher.benzene',
      sha256_cert_fingerprints: ['AA:'.repeat(31) + 'AA', 'BB:'.repeat(31) + 'BB'],
    },
  }]);
});

test('invalid publisher values keep app-link endpoints unavailable', async () => {
  await new Promise<void>((resolve, reject) => withEnvironment({
    APPLE_APP_LINK_TEAM_ID: 'invented-team',
    APPLE_APP_LINK_BUNDLE_ID: 'com.publisher.benzene',
    ANDROID_APP_LINK_APPLICATION_ID: 'Com.publisher.benzene',
    ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS: 'not-a-fingerprint',
  }, () => {
    Promise.all([getAppleAssociation(), getAndroidAssetLinks()]).then(([apple, android]) => {
      try {
        assert.equal(apple.status, 404);
        assert.equal(android.status, 404);
        resolve();
      } catch (error) {
        reject(error);
      }
    }, reject);
  }));
});
