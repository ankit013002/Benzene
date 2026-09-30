#!/usr/bin/env node

// Usage: set BENZENE_STORE_ORIGIN, BENZENE_PASSWORD_RESET_URL,
// APPLE_APP_LINK_TEAM_ID, APPLE_APP_LINK_BUNDLE_ID,
// ANDROID_APP_LINK_APPLICATION_ID, and
// ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS, then run:
//   node scripts/verify-mobile-store-deployment.mjs

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROUTES = [
  ['/privacy', 'Privacy page'],
  ['/terms', 'Terms page'],
  ['/support', 'Support page'],
  ['/account-deletion', 'Account-deletion page'],
];
const AASA_PATH = '/.well-known/apple-app-site-association';
const ASSETLINKS_PATH = '/.well-known/assetlinks.json';
const RESET_PATH = '/reset-password';
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const IOS_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const ANDROID_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const FINGERPRINT_PATTERN = /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;
const PLACEHOLDER_PARTS = new Set(['example', 'placeholder', 'changeme', 'yourcompany', 'test']);
const REQUEST_TIMEOUT_MS = 10_000;

function isPrivateIpv4(host) {
  const values = host.split('.').map(Number);
  if (values.length !== 4 || values.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== host.split('.')[index])) return false;
  const [a, b] = values;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224;
}

function isPrivateIpv6(host) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
    /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:') ||
    value.startsWith('::ffff:') || value.startsWith('64:ff9b:1:');
}

function isPlaceholderHost(host) {
  return host === 'example.com' || host.endsWith('.example.com') || host === 'example.org' ||
    host.endsWith('.example.org') || host === 'example.net' || host.endsWith('.example.net') ||
    host === 'example.edu' || host.endsWith('.example.edu') || host === 'example' ||
    host.endsWith('.example') || host === 'invalid' || host.endsWith('.invalid') || host.endsWith('.test');
}

export function validatePublicHttpsUrl(value, { originOnly = false, requiredPath } = {}) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('A required public HTTPS URL is missing.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('A configured URL is malformed.'); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (parsed.port !== '' && parsed.port !== '443') || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Configured URLs must use HTTPS on its default port and omit credentials, query strings, and fragments.');
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPlaceholderHost(host)) {
    throw new Error('Configured URLs must use a public, non-placeholder hostname.');
  }
  const ipVersion = isIP(host.replace(/^\[|\]$/g, ''));
  if ((ipVersion === 4 && isPrivateIpv4(host)) || (ipVersion === 6 && isPrivateIpv6(host))) {
    throw new Error('Configured URLs must not use a private or reserved IP address.');
  }
  if (originOnly && parsed.pathname !== '/') throw new Error('The store origin must not include a path.');
  if (requiredPath && parsed.pathname !== requiredPath) throw new Error(`The password-reset URL must use ${requiredPath}.`);
  return parsed;
}

function validatePublisherConfig(config) {
  const origin = validatePublicHttpsUrl(config.origin, { originOnly: true });
  const resetUrl = validatePublicHttpsUrl(config.passwordResetUrl, { requiredPath: RESET_PATH });
  if (resetUrl.origin !== origin.origin) throw new Error('The password-reset URL must use the configured store origin.');
  const teamId = String(config.iosTeamId ?? '').trim();
  const bundleId = String(config.iosBundleId ?? '').trim();
  const packageName = String(config.androidPackageName ?? '').trim();
  const fingerprints = String(config.androidSha256Fingerprints ?? '').split(',').map((value) => value.trim().toUpperCase());
  if (!TEAM_ID_PATTERN.test(teamId) || !IOS_ID_PATTERN.test(bundleId) || bundleId.split('.').some((part) => PLACEHOLDER_PARTS.has(part.toLowerCase()))) {
    throw new Error('Expected a valid Apple Team ID and publisher-owned iOS bundle ID.');
  }
  if (!ANDROID_ID_PATTERN.test(packageName) || packageName.split('.').some((part) => PLACEHOLDER_PARTS.has(part.toLowerCase()))) {
    throw new Error('Expected a valid publisher-owned Android package name.');
  }
  if (fingerprints.length === 0 || fingerprints.some((fingerprint) => !FINGERPRINT_PATTERN.test(fingerprint)) || new Set(fingerprints).size !== fingerprints.length) {
    throw new Error('Expected one or more unique Android SHA-256 signing fingerprints.');
  }
  return { origin, resetUrl, teamId, bundleId, packageName, fingerprints };
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

async function assertPublicDns(hostname, lookup) {
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return;
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('A configured public hostname could not be resolved.'); }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('A configured hostname resolves to a private or reserved address.');
  }
}

async function getPublicResponse(url, { fetchImpl, lookup, origin }) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    validatePublicHttpsUrl(current.href);
    if (current.origin !== origin) throw new Error('A public endpoint redirected to a different origin.');
    await assertPublicDns(current.hostname, lookup);
    let response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html, application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('A public endpoint could not be reached.');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('A public endpoint returned a redirect without a destination.');
      if (redirects === 3) throw new Error('A public endpoint exceeded the redirect limit.');
      await response.body?.cancel();
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error('A public endpoint exceeded the redirect limit.');
}

function requireContentType(response, expected, label) {
  const actual = response.headers.get('content-type') ?? '';
  if (actual.split(';', 1)[0].trim().toLowerCase() !== expected) throw new Error(`${label} returned an unexpected content type.`);
}

function requireNoStore(response, label) {
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (!/(?:^|,)\s*no-store(?:\s*(?:,|$)|\s*=)/i.test(cacheControl)) throw new Error(`${label} is missing its no-store cache safeguard.`);
  if ((response.headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') throw new Error(`${label} is missing its nosniff safeguard.`);
}

async function readJson(response, label) {
  const maxBytes = 256 * 1024;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`${label} response exceeded the size limit.`);
  if (!response.body) throw new Error(`${label} returned malformed JSON.`);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} response exceeded the size limit.`);
      }
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('response exceeded the size limit.')) throw error;
    throw new Error(`${label} returned malformed JSON.`);
  }
}

function exactAppleAssociation(body, expectedAppId) {
  const details = body?.applinks?.details;
  return Array.isArray(details) && details.length === 1 && body.applinks.apps?.length === 0 &&
    details[0]?.appID === expectedAppId && Array.isArray(details[0]?.paths) &&
    details[0].paths.length === 1 && details[0].paths[0] === RESET_PATH &&
    Object.keys(body).length === 1 && Object.keys(body.applinks).length === 2 && Object.keys(details[0]).length === 2;
}

function exactAndroidAssociations(body, expectedPackage, expectedFingerprints) {
  // Android's assetlinks statement binds a host to an app; the path boundary
  // lives in the signed app's intent filter, not in assetlinks.json itself.
  // This check therefore requires one exact host/app/certificate claim and
  // the verifier separately requires the configured reset URL to use the
  // exact /reset-password path. It cannot inspect the signed manifest here.
  if (!Array.isArray(body) || body.length !== 1) return false;
  const item = body[0];
  const target = item?.target;
  const actualFingerprints = target?.sha256_cert_fingerprints;
  return Array.isArray(item?.relation) && item.relation.length === 1 && item.relation[0] === 'delegate_permission/common.handle_all_urls' &&
    target?.namespace === 'android_app' && target.package_name === expectedPackage &&
    Array.isArray(actualFingerprints) && actualFingerprints.length === expectedFingerprints.length &&
    actualFingerprints.map((value) => String(value).toUpperCase()).sort().join(',') === [...expectedFingerprints].sort().join(',') &&
    Object.keys(item).length === 2 && Object.keys(target).length === 3;
}

export async function verifyMobileStoreDeployment(config, { fetchImpl = globalThis.fetch, lookup = dnsLookup } = {}) {
  const publisher = validatePublisherConfig(config);
  const results = [];
  for (const [route, label] of ROUTES) {
    const response = await getPublicResponse(new URL(route, publisher.origin), { fetchImpl, lookup, origin: publisher.origin.origin });
    if (response.status !== 200) throw new Error(`${label} is not publicly reachable (HTTP ${response.status}).`);
    requireContentType(response, 'text/html', label);
    await response.body?.cancel();
    results.push(label);
  }
  const apple = await getPublicResponse(new URL(AASA_PATH, publisher.origin), { fetchImpl, lookup, origin: publisher.origin.origin });
  if (apple.status !== 200) throw new Error(`Apple app association is unavailable (HTTP ${apple.status}).`);
  requireContentType(apple, 'application/json', 'Apple app association');
  requireNoStore(apple, 'Apple app association');
  if (!exactAppleAssociation(await readJson(apple, 'Apple app association'), `${publisher.teamId}.${publisher.bundleId}`)) {
    throw new Error('Apple app association does not exactly match the expected app and reset-only route.');
  }
  results.push('Apple app association');

  const android = await getPublicResponse(new URL(ASSETLINKS_PATH, publisher.origin), { fetchImpl, lookup, origin: publisher.origin.origin });
  if (android.status !== 200) throw new Error(`Android asset links are unavailable (HTTP ${android.status}).`);
  requireContentType(android, 'application/json', 'Android asset links');
  requireNoStore(android, 'Android asset links');
  if (!exactAndroidAssociations(await readJson(android, 'Android asset links'), publisher.packageName, publisher.fingerprints)) {
    throw new Error('Android asset links do not exactly match the expected package and signing fingerprints.');
  }
  results.push('Android asset links');
  return results;
}

function readConfig(environment = process.env) {
  return {
    origin: environment.BENZENE_STORE_ORIGIN,
    passwordResetUrl: environment.BENZENE_PASSWORD_RESET_URL,
    iosTeamId: environment.APPLE_APP_LINK_TEAM_ID,
    iosBundleId: environment.APPLE_APP_LINK_BUNDLE_ID,
    androidPackageName: environment.ANDROID_APP_LINK_APPLICATION_ID,
    androidSha256Fingerprints: environment.ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const results = await verifyMobileStoreDeployment(readConfig());
    console.log(`Mobile store deployment verification passed: ${results.join(', ')}.`);
  } catch (error) {
    console.error(`Mobile store deployment verification failed: ${error instanceof Error ? error.message : 'unexpected error'}`);
    process.exitCode = 1;
  }
}
