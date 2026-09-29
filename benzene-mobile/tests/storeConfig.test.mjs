import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expoCli = path.join(appDirectory, 'node_modules/expo/bin/cli');

function productionConfig(extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [expoCli, 'config', '--type', 'introspect', '--json'], {
    cwd: appDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      EAS_BUILD_PROFILE: 'production',
      IOS_BUNDLE_IDENTIFIER: 'com.benzene.releasecheck.ios',
      ANDROID_APPLICATION_ID: 'com.benzene.releasecheck.android',
      EXPO_PUBLIC_GATEWAY_ORIGIN: 'https://gateway.example.com',
      EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://example.com/privacy',
      EXPO_PUBLIC_TERMS_OF_SERVICE_URL: 'https://example.com/terms',
      EXPO_PUBLIC_SUPPORT_URL: 'https://example.com/support',
      ...extraEnvironment,
    },
  });
  return result;
}

test('production Expo config requires publisher-owned identifiers', () => {
  const result = productionConfig({ IOS_BUNDLE_IDENTIFIER: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IOS_BUNDLE_IDENTIFIER must be set/);
});

test('production native config keeps transport and permissions narrowly scoped', () => {
  const result = productionConfig();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);

  assert.equal(config.ios.bundleIdentifier, 'com.benzene.releasecheck.ios');
  assert.equal(config.android.package, 'com.benzene.releasecheck.android');
  assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
  assert.equal('NSFaceIDUsageDescription' in config.ios.infoPlist, false);

  const permissions = config.android.permissions ?? [];
  assert.equal(permissions.includes('android.permission.INTERNET'), true);
  for (const permission of [
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.VIBRATE',
  ]) {
    assert.equal(permissions.includes(permission), false, `${permission} should not ship`);
  }
});

test('EAS production profile uses monotonically incremented local store build numbers', () => {
  const eas = JSON.parse(readFileSync(path.join(appDirectory, 'eas.json'), 'utf8'));
  assert.equal(eas.cli.appVersionSource, 'local');
  assert.equal(eas.build.production.autoIncrement, true);
  assert.equal(eas.build.production.distribution, undefined);
});
