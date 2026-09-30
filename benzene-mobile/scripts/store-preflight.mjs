import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iosIdentifierPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const androidApplicationIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlaceholderIdentifier(value) {
  return value.split('.').some((part) => ['example', 'placeholder', 'changeme', 'yourcompany'].includes(part.toLowerCase()));
}

function publicHttpsUrl(value, { originOnly = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const ipv4 = host.split('.').map(Number);
  const privateIpv4 = ipv4.length === 4 && ipv4.every((part, index) => Number.isInteger(part) && part >= 0 && part <= 255 && String(part) === host.split('.')[index]) && (
    ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 ||
    (ipv4[0] === 169 && ipv4[1] === 254) ||
    (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
    (ipv4[0] === 192 && ipv4[1] === 168) ||
    (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127)
  );
  const localHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]' ||
    (host.startsWith('[') && (/^\[(?:fc|fd|fe8|fe9|fea|feb)/i.test(host) || host === '[::]')) || privateIpv4;
  const placeholderHost = host.endsWith('.invalid') || host === 'invalid' || host === 'example.com' || host.endsWith('.example.com') || host.endsWith('.example') || host === 'example';
  return parsed.protocol === 'https:' && !localHost && !placeholderHost && !host.endsWith('.test') &&
    !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
    (!originOnly || parsed.pathname === '/' || parsed.pathname === '');
}

function validateBuild(environment, eas) {
  const errors = [];
  const iosId = environment.IOS_BUNDLE_IDENTIFIER?.trim() ?? '';
  if (!iosIdentifierPattern.test(iosId) || isPlaceholderIdentifier(iosId)) errors.push('IOS_BUNDLE_IDENTIFIER must be a publisher-owned reverse-DNS identifier, not an example value.');
  const androidId = environment.ANDROID_APPLICATION_ID?.trim() ?? '';
  if (!androidApplicationIdPattern.test(androidId) || isPlaceholderIdentifier(androidId)) errors.push('ANDROID_APPLICATION_ID must be a lowercase Android application ID with valid package segments, not an example value.');
  if (!projectIdPattern.test(environment.EAS_PROJECT_ID?.trim() ?? '')) {
    errors.push('EAS_PROJECT_ID must be the UUID of the publisher-owned EAS project.');
  }
  for (const [name, originOnly] of [
    ['EXPO_PUBLIC_GATEWAY_ORIGIN', true],
    ['EXPO_PUBLIC_PRIVACY_POLICY_URL', false],
    ['EXPO_PUBLIC_TERMS_OF_SERVICE_URL', false],
    ['EXPO_PUBLIC_SUPPORT_URL', false],
  ]) {
    if (!publicHttpsUrl(environment[name]?.trim(), { originOnly })) errors.push(`${name} must be a public HTTPS ${originOnly ? 'origin' : 'URL'} without placeholder, local, credential, query, or fragment values.`);
  }
  if (eas.build?.production?.autoIncrement !== true) errors.push('eas.json build.production.autoIncrement must be true.');
  if (eas.build?.production?.distribution === 'internal') errors.push('eas.json build.production must produce a store distribution, not an internal build.');
  if (environment.EAS_OWNER?.trim() && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(environment.EAS_OWNER.trim())) errors.push('EAS_OWNER must be a valid Expo account slug when provided.');
  return errors;
}

function resolveCredentialPath(root, value, extension, label, errors) {
  if (typeof value !== 'string' || value.trim() === '' || /example|placeholder|changeme/i.test(value)) {
    errors.push(`${label} must point to the publisher's local credential file or protected CI file.`);
    return;
  }
  try {
    const credential = statSync(path.resolve(root, value));
    if (!credential.isFile()) errors.push(`${label} must point to a file.`);
    if (path.extname(value).toLowerCase() !== extension) errors.push(`${label} must use a ${extension} file.`);
  } catch {
    errors.push(`${label} does not exist at the configured path.`);
  }
}

function validateSubmit(eas, environment, root = appDirectory) {
  const errors = [];
  const profile = eas.submit?.production;
  if (!profile || typeof profile !== 'object') return ['eas.json submit.production is required for non-interactive store submission.'];

  const ios = profile.ios;
  if (!ios || typeof ios !== 'object') {
    errors.push('eas.json submit.production.ios must configure App Store Connect submission.');
  } else {
    if (!/^\d{8,}$/.test(String(ios.ascAppId ?? ''))) errors.push('submit.production.ios.ascAppId must be the numeric App Store Connect Apple ID.');
    if (!/^[A-Z0-9]{10}$/.test(String(ios.ascApiKeyId ?? ''))) errors.push('submit.production.ios.ascApiKeyId must be the 10-character App Store Connect API key ID.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(ios.ascApiKeyIssuerId ?? ''))) errors.push('submit.production.ios.ascApiKeyIssuerId must be the App Store Connect API issuer UUID.');
    if (ios.bundleIdentifier && ios.bundleIdentifier !== environment.IOS_BUNDLE_IDENTIFIER) errors.push('submit.production.ios.bundleIdentifier must match IOS_BUNDLE_IDENTIFIER.');
    resolveCredentialPath(root, ios.ascApiKeyPath, '.p8', 'submit.production.ios.ascApiKeyPath', errors);
  }

  const android = profile.android;
  if (!android || typeof android !== 'object') {
    errors.push('eas.json submit.production.android must configure Google Play submission.');
  } else {
    if (android.applicationId && android.applicationId !== environment.ANDROID_APPLICATION_ID) errors.push('submit.production.android.applicationId must match ANDROID_APPLICATION_ID.');
    if (!['internal', 'alpha', 'beta', 'production'].includes(android.track)) errors.push('submit.production.android.track must explicitly select an EAS-supported Play track.');
    resolveCredentialPath(root, android.serviceAccountKeyPath, '.json', 'submit.production.android.serviceAccountKeyPath', errors);
  }
  return errors;
}

export function validateStorePreflight({ mode, environment = process.env, eas, root = appDirectory }) {
  if (mode !== 'build' && mode !== 'submit') return ['Usage: npm run check:store-build or npm run check:store-submit'];
  const errors = validateBuild(environment, eas);
  if (mode === 'submit') errors.push(...validateSubmit(eas, environment, root));
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  let eas;
  try {
    eas = JSON.parse(readFileSync(path.join(appDirectory, 'eas.json'), 'utf8'));
  } catch {
    console.error('Could not parse benzene-mobile/eas.json.');
    process.exitCode = 1;
  }
  if (eas) {
    const errors = validateStorePreflight({ mode, eas });
    if (errors.length > 0) {
      console.error(`Store ${mode} preflight failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`Store ${mode} preflight passed. EAS still verifies account access, signing, and store-side app records.`);
    }
  }
}
