import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required release configuration: ${name}.`);
  return value;
}

function privateFile(filePath, contents) {
  writeFileSync(filePath, contents, { mode: 0o600, flag: 'wx' });
  chmodSync(filePath, 0o600);
}

const platformsArg = process.argv[2] ?? 'all';
const platforms = platformsArg === 'all' ? ['ios', 'android'] : [platformsArg];
if (platforms.some((platform) => !['ios', 'android'].includes(platform))) {
  throw new Error('Platform must be ios, android, or all.');
}

const easPath = path.join(appDirectory, 'eas.json');
const eas = JSON.parse(readFileSync(easPath, 'utf8'));
const outputDirectory = path.join(required('RUNNER_TEMP'), `benzene-mobile-release-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`);
mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
chmodSync(outputDirectory, 0o700);

const submit = eas.submit?.production ?? {};
if (platforms.includes('ios')) {
  const apiKeyPath = path.join(outputDirectory, 'app-store-connect.p8');
  privateFile(apiKeyPath, required('ASC_API_PRIVATE_KEY_P8'));
  submit.ios = {
    ascAppId: required('ASC_APP_ID'),
    ascApiKeyId: required('ASC_API_KEY_ID'),
    ascApiKeyIssuerId: required('ASC_API_KEY_ISSUER_ID'),
    ascApiKeyPath: apiKeyPath,
    bundleIdentifier: required('IOS_BUNDLE_IDENTIFIER'),
  };
}

if (platforms.includes('android')) {
  const serviceAccountPath = path.join(outputDirectory, 'google-play-service-account.json');
  privateFile(serviceAccountPath, required('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'));
  submit.android = {
    applicationId: required('ANDROID_APPLICATION_ID'),
    serviceAccountKeyPath: serviceAccountPath,
    track: required('ANDROID_PLAY_TRACK'),
    releaseStatus: 'draft',
  };
}

eas.submit = { ...eas.submit, production: submit };
writeFileSync(easPath, `${JSON.stringify(eas, null, 2)}\n`, { mode: 0o600 });
console.log(`Prepared protected temporary credentials and production submission config for ${platformsArg}.`);
