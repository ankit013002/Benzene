#!/usr/bin/env node

// Public, read-only relay ingress probe. It checks DNS, HTTPS readiness, and
// WSS upgrade/auth rejection without needing a real ticket or sending data.
// Usage: BENZENE_RELAY_PUBLIC_URL=wss://relay.yourdomain.com node scripts/verify-relay-deployment.mjs

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REQUEST_TIMEOUT_MS = 10_000;
const PLACEHOLDER_HOSTS = new Set(['example.com', 'example.org', 'example.net', 'example.edu', 'example']);

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const values = address.split('.').map(Number);
    const [a, b] = values;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224;
  }
  if (version === 6) {
    const host = address.toLowerCase();
    return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') ||
      /^fe[89ab]/.test(host) || host.startsWith('ff') || host.startsWith('2001:db8:') ||
      host.startsWith('::ffff:') || host.startsWith('64:ff9b:1:');
  }
  return true;
}

export function validateRelayPublicUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('BENZENE_RELAY_PUBLIC_URL is required.');
  let url;
  try { url = new URL(value); } catch { throw new Error('BENZENE_RELAY_PUBLIC_URL is malformed.'); }
  const host = url.hostname.toLowerCase();
  const ipVersion = isIP(host.replace(/^\[|\]$/g, ''));
  if (url.protocol !== 'wss:' || (url.port !== '' && url.port !== '443') || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BENZENE_RELAY_PUBLIC_URL must be a WSS origin on port 443 without credentials, path, query, or fragment.');
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.test') || host === 'invalid' || host.endsWith('.invalid') ||
      PLACEHOLDER_HOSTS.has(host) || [...PLACEHOLDER_HOSTS].some((placeholder) => host.endsWith(`.${placeholder}`)) ||
      (ipVersion !== 0 && isPrivateAddress(host.replace(/^\[|\]$/g, '')))) {
    throw new Error('BENZENE_RELAY_PUBLIC_URL must use a public, non-placeholder hostname.');
  }
  return url;
}

async function assertPublicDns(hostname, lookup) {
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return;
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('The relay hostname could not be resolved publicly.'); }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('The relay hostname resolves to a private or reserved address.');
  }
}

async function checkReadiness(origin, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL('/ready', `https://${origin.host}`), {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('The relay HTTPS readiness endpoint could not be reached.');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`The relay readiness endpoint returned HTTP ${response.status}.`);
  }
  if ((response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel();
    throw new Error('The relay readiness endpoint did not return JSON.');
  }
  if (!/(?:^|,)\s*no-store(?:\s*(?:,|$)|\s*=)/i.test(response.headers.get('cache-control') ?? '')) {
    await response.body?.cancel();
    throw new Error('The relay readiness response is missing its no-store safeguard.');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 4096) {
    await response.body?.cancel();
    throw new Error('The relay readiness response exceeded the size limit.');
  }
  let text;
  try {
    if (!response.body) throw new Error('missing body');
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > 4096) {
        await reader.cancel();
        throw new Error('too large');
      }
      chunks.push(value);
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new Error('The relay readiness endpoint returned a malformed or oversized body.');
  }
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error('The relay readiness endpoint returned malformed JSON.'); }
  if (body?.status !== 'ready' || body?.service !== 'benzene-relay') {
    throw new Error('The relay readiness endpoint did not report a ready Benzene relay.');
  }
}

function probeWebSocket(url, WebSocketImpl) {
  if (typeof WebSocketImpl !== 'function') throw new Error('This Node.js runtime does not provide the WebSocket client required by the relay probe.');
  const socket = new WebSocketImpl(url);
  return new Promise((resolve, reject) => {
    let opened = false;
    let finished = false;
    const timer = setTimeout(() => finish(new Error('The public WSS relay probe timed out.')), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.addEventListener('open', () => {
      opened = true;
      // A deliberately invalid bearer is sufficient to prove the ingress
      // upgrades WSS and the service enforces authentication; it grants no scope.
      socket.send(JSON.stringify({ type: 'authenticate', ticket: 'invalid-deployment-probe' }));
    }, { once: true });
    socket.addEventListener('close', (event) => {
      if (opened && event.code === 1008) finish();
      else finish(new Error(opened
        ? `The WSS relay rejected the probe with unexpected close code ${event.code}.`
        : 'The public WSS endpoint closed before completing its upgrade.'));
    }, { once: true });
    socket.addEventListener('error', () => finish(new Error('The public WSS relay handshake or TLS validation failed.')), { once: true });
  });
}

export async function verifyRelayDeployment(value, {
  fetchImpl = globalThis.fetch,
  lookup = dnsLookup,
  WebSocketImpl = globalThis.WebSocket,
  sessionId = randomUUID(),
} = {}) {
  const relayUrl = validateRelayPublicUrl(value);
  await assertPublicDns(relayUrl.hostname, lookup);
  await checkReadiness(relayUrl, fetchImpl);
  const probeUrl = new URL(`/relay/${sessionId}`, relayUrl);
  await probeWebSocket(probeUrl, WebSocketImpl);
  return ['public DNS', 'HTTPS readiness', 'WSS upgrade and invalid-ticket rejection'];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const results = await verifyRelayDeployment(process.env.BENZENE_RELAY_PUBLIC_URL);
    console.log(`Relay public deployment verification passed: ${results.join(', ')}.`);
  } catch (error) {
    console.error(`Relay public deployment verification failed: ${error instanceof Error ? error.message : 'unexpected error'}`);
    process.exitCode = 1;
  }
}
