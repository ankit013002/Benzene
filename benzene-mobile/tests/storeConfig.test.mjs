import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
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
      EAS_PROJECT_ID: '123e4567-e89b-42d3-a456-426614174000',
      IOS_BUNDLE_IDENTIFIER: 'com.benzene.releasecheck.ios',
      ANDROID_APPLICATION_ID: 'com.benzene.releasecheck.android',
      EXPO_PUBLIC_GATEWAY_ORIGIN: 'https://gateway.benzene-release-check.com',
      EXPO_PUBLIC_APP_LINK_ORIGIN: 'https://benzene-release-check.com',
      EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://benzene-release-check.com/privacy',
      EXPO_PUBLIC_TERMS_OF_SERVICE_URL: 'https://benzene-release-check.com/terms',
      EXPO_PUBLIC_SUPPORT_URL: 'https://benzene-release-check.com/support',
      EXPO_PUBLIC_ACCOUNT_DELETION_URL: 'https://benzene-release-check.com/account-deletion',
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

test('production Expo config requires a public account-deletion information URL', () => {
  const result = productionConfig({ EXPO_PUBLIC_ACCOUNT_DELETION_URL: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXPO_PUBLIC_ACCOUNT_DELETION_URL must be set for production builds/);
});

test('production Expo config requires a public HTTPS app-link origin', () => {
  const result = productionConfig({ EXPO_PUBLIC_APP_LINK_ORIGIN: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXPO_PUBLIC_APP_LINK_ORIGIN must be set for production builds/);
});

test('production Expo config rejects invalid Android IDs and non-public gateway hosts', () => {
  const badPackage = productionConfig({ ANDROID_APPLICATION_ID: 'com.publisher.Bad-App' });
  assert.notEqual(badPackage.status, 0);
  assert.match(badPackage.stderr, /ANDROID_APPLICATION_ID must be set/);

  const privateGateway = productionConfig({ EXPO_PUBLIC_GATEWAY_ORIGIN: 'https://192.168.1.50' });
  assert.notEqual(privateGateway.status, 0);
  assert.match(privateGateway.stderr, /EXPO_PUBLIC_GATEWAY_ORIGIN must be a public HTTPS URL/);
});

test('production native config keeps transport and permissions narrowly scoped', () => {
  const result = productionConfig();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);

  assert.equal(config.ios.bundleIdentifier, 'com.benzene.releasecheck.ios');
  assert.equal(config.android.package, 'com.benzene.releasecheck.android');
  assert.equal(config.scheme, 'benzene');
  assert.deepEqual(config.ios.associatedDomains, ['applinks:benzene-release-check.com']);
  assert.deepEqual(config.android.intentFilters, [{
    action: 'VIEW',
    autoVerify: true,
    data: [{ scheme: 'https', host: 'benzene-release-check.com', pathPrefix: '/reset-password' }],
    category: ['BROWSABLE', 'DEFAULT'],
  }]);
  assert.equal(config.extra.eas.projectId, '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
  assert.equal('NSFaceIDUsageDescription' in config.ios.infoPlist, false);

  assert.deepEqual(config.ios.privacyManifests.NSPrivacyAccessedAPITypes, [
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
      NSPrivacyAccessedAPITypeReasons: ['C617.1', '3B52.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
      NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
      NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
    },
  ]);

  const permissions = config.android.permissions ?? [];
  assert.deepEqual(permissions, ['android.permission.INTERNET']);
});

test('EAS production profile uses monotonically incremented local store build numbers', () => {
  const eas = JSON.parse(readFileSync(path.join(appDirectory, 'eas.json'), 'utf8'));
  assert.equal(eas.cli.appVersionSource, 'local');
  assert.equal(eas.build.production.autoIncrement, true);
  assert.equal(eas.build.production.distribution, undefined);
});

test('store icon assets have platform dimensions, opaque iOS background and Android safe-zone artwork', () => {
  const images = path.join(appDirectory, 'assets/images');
  const ios = PNG.sync.read(readFileSync(path.join(images, 'icon.png')));
  const foreground = PNG.sync.read(readFileSync(path.join(images, 'android-icon-foreground.png')));
  const monochrome = PNG.sync.read(readFileSync(path.join(images, 'android-icon-monochrome.png')));

  assert.equal(ios.width, 1024);
  assert.equal(ios.height, 1024);
  assert.equal(foreground.width, 432);
  assert.equal(foreground.height, 432);
  assert.equal(monochrome.width, 432);
  assert.equal(monochrome.height, 432);

  for (let index = 3; index < ios.data.length; index += 4) {
    assert.equal(ios.data[index], 255, 'iOS app icon must not contain transparent pixels');
  }

  for (const image of [foreground, monochrome]) {
    let minX = image.width;
    let maxX = -1;
    let minY = image.height;
    let maxY = -1;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const alpha = image.data[(y * image.width + x) * 4 + 3];
        if (alpha === 0) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    assert.ok(maxX >= minX && maxY >= minY, 'Android artwork must be visible');
    assert.ok(maxX - minX + 1 <= image.width * 0.66, 'Android artwork must stay in adaptive-icon horizontal safe area');
    assert.ok(maxY - minY + 1 <= image.height * 0.66, 'Android artwork must stay in adaptive-icon vertical safe area');
  }

  for (let index = 0; index < monochrome.data.length; index += 4) {
    assert.equal(monochrome.data[index], 0, 'monochrome artwork must use black RGB');
    assert.equal(monochrome.data[index + 1], 0, 'monochrome artwork must use black RGB');
    assert.equal(monochrome.data[index + 2], 0, 'monochrome artwork must use black RGB');
  }
});
