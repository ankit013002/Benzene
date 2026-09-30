import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateStorePreflight } from '../scripts/store-preflight.mjs';

const environment = {
  IOS_BUNDLE_IDENTIFIER: 'com.publisher.benzene.ios',
  ANDROID_APPLICATION_ID: 'com.publisher.benzene.android',
  EAS_PROJECT_ID: '123e4567-e89b-42d3-a456-426614174000',
  EXPO_PUBLIC_GATEWAY_ORIGIN: 'https://gateway.benzene-release-check.com',
  EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://benzene-release-check.com/privacy',
  EXPO_PUBLIC_TERMS_OF_SERVICE_URL: 'https://benzene-release-check.com/terms',
  EXPO_PUBLIC_SUPPORT_URL: 'https://benzene-release-check.com/support',
  EXPO_PUBLIC_ACCOUNT_DELETION_URL: 'https://benzene-release-check.com/account-deletion',
};

function buildConfig() {
  return { build: { production: { autoIncrement: true } }, submit: { production: {} } };
}

test('store build preflight accepts publisher IDs, EAS link and public HTTPS endpoints', () => {
  assert.deepEqual(validateStorePreflight({ mode: 'build', environment, eas: buildConfig() }), []);
});

test('store build preflight follows the separate iOS and Android identifier rules', () => {
  assert.deepEqual(validateStorePreflight({
    mode: 'build',
    environment: { ...environment, IOS_BUNDLE_IDENTIFIER: 'com.publisher.benzene-beta', ANDROID_APPLICATION_ID: 'com.publisher.benzene_beta' },
    eas: buildConfig(),
  }), []);
  const errors = validateStorePreflight({
    mode: 'build',
    environment: { ...environment, ANDROID_APPLICATION_ID: 'com.publisher.Benzene-beta' },
    eas: buildConfig(),
  });
  assert.equal(errors.some((error) => error.includes('ANDROID_APPLICATION_ID')), true);
});

test('store build preflight lists missing or placeholder publisher-owned values', () => {
  const errors = validateStorePreflight({
    mode: 'build',
    environment: { ...environment, IOS_BUNDLE_IDENTIFIER: 'com.example.benzene', EAS_PROJECT_ID: '', EXPO_PUBLIC_GATEWAY_ORIGIN: 'http://localhost:8080' },
    eas: buildConfig(),
  });
  assert.equal(errors.some((error) => error.includes('IOS_BUNDLE_IDENTIFIER')), true);
  assert.equal(errors.some((error) => error.includes('EAS_PROJECT_ID')), true);
  assert.equal(errors.some((error) => error.includes('EXPO_PUBLIC_GATEWAY_ORIGIN')), true);
});

test('store build preflight rejects private network URLs and invalid EAS owner slugs', () => {
  const errors = validateStorePreflight({
    mode: 'build',
    environment: { ...environment, EXPO_PUBLIC_GATEWAY_ORIGIN: 'https://192.168.1.50', EAS_OWNER: '@benzene team' },
    eas: buildConfig(),
  });
  assert.equal(errors.some((error) => error.includes('EXPO_PUBLIC_GATEWAY_ORIGIN')), true);
  assert.equal(errors.some((error) => error.includes('EAS_OWNER')), true);
});

test('store build preflight rejects documentation placeholder domains', () => {
  const errors = validateStorePreflight({
    mode: 'build',
    environment: { ...environment, EXPO_PUBLIC_SUPPORT_URL: 'https://support.example.com' },
    eas: buildConfig(),
  });
  assert.equal(errors.some((error) => error.includes('EXPO_PUBLIC_SUPPORT_URL')), true);
});

test('store build preflight requires a public HTTPS account-deletion page', () => {
  const missing = validateStorePreflight({
    mode: 'build',
    environment: { ...environment, EXPO_PUBLIC_ACCOUNT_DELETION_URL: '' },
    eas: buildConfig(),
  });
  assert.equal(missing.some((error) => error.includes('EXPO_PUBLIC_ACCOUNT_DELETION_URL')), true);

  const local = validateStorePreflight({
    mode: 'build',
    environment: { ...environment, EXPO_PUBLIC_ACCOUNT_DELETION_URL: 'http://localhost:3000/account-deletion' },
    eas: buildConfig(),
  });
  assert.equal(local.some((error) => error.includes('EXPO_PUBLIC_ACCOUNT_DELETION_URL')), true);
});

test('store submission preflight validates non-secret ASC and Play config and local key paths', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'benzene-store-preflight-'));
  try {
    writeFileSync(path.join(root, 'AuthKey.p8'), 'fixture');
    writeFileSync(path.join(root, 'play-service-account.json'), '{}');
    const eas = {
      ...buildConfig(),
      submit: { production: {
        ios: { ascAppId: '1234567890', ascApiKeyId: 'ABCDEF1234', ascApiKeyIssuerId: '123e4567-e89b-42d3-a456-426614174000', ascApiKeyPath: 'AuthKey.p8', bundleIdentifier: environment.IOS_BUNDLE_IDENTIFIER },
        android: { track: 'internal', serviceAccountKeyPath: 'play-service-account.json', applicationId: environment.ANDROID_APPLICATION_ID },
      } },
    };
    assert.deepEqual(validateStorePreflight({ mode: 'submit', environment, eas, root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store submission preflight fails clearly when publisher store records or credentials are absent', () => {
  const eas = { ...buildConfig(), submit: { production: { ios: {}, android: {} } } };
  const errors = validateStorePreflight({ mode: 'submit', environment, eas });
  assert.equal(errors.some((error) => error.includes('ascAppId')), true);
  assert.equal(errors.some((error) => error.includes('serviceAccountKeyPath')), true);
});

test('store submission preflight requires credentials only for the selected platform', () => {
  const eas = { ...buildConfig(), submit: { production: {
    ios: {},
    android: {},
  } } };
  const iosErrors = validateStorePreflight({ mode: 'submit', environment, eas, platforms: ['ios'] });
  const androidErrors = validateStorePreflight({ mode: 'submit', environment, eas, platforms: ['android'] });
  assert.equal(iosErrors.some((error) => error.includes('serviceAccountKeyPath')), false);
  assert.equal(androidErrors.some((error) => error.includes('ascAppId')), false);
});

test('store preflight rejects unsupported or empty platform selections', () => {
  assert.deepEqual(validateStorePreflight({ mode: 'build', environment, eas: buildConfig(), platforms: ['web'] }), ['Platform must be ios, android, or all.']);
  assert.deepEqual(validateStorePreflight({ mode: 'submit', environment, eas: buildConfig(), platforms: [] }), ['Platform must be ios, android, or all.']);
});
