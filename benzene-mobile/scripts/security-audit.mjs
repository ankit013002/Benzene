import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADVISORY_ID = 'GHSA-86w9-cpqp-85rv';
const LOCKED_VERSION = '1.4.0';
const LOCKED_TARBALL = 'https://registry.npmjs.org/node-forge/-/node-forge-1.4.0.tgz';
const LOCKED_INTEGRITY = 'sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==';
const PATCH_SHA256 = '8bedb62744f95a7cdbc8b159a7bcdae3218308e1394c7995bc1f2c96a571e604';
const PATCHED_RSA_SHA256 = 'acc22e5d36e27832c34e02dd3933aad7977d45b047eead5016520735efedc9c5';
const PATCH_PATH = 'patches/node-forge+1.4.0.patch';
const RSA_PATH = 'node_modules/node-forge/lib/rsa.js';
const PACKAGE_PATH = 'node_modules/node-forge/package.json';
const REGRESSION_PATH = 'tests/nodeForgeSecurity.test.mjs';
const EXPECTED_FINDINGS = {
  '@expo/cli': {
    node: 'node_modules/expo/node_modules/@expo/cli',
    range: '<=0.0.0-canary-20231123-1b19f96-4 || >=0.0.1-canary-20231125-d600e44',
    isDirect: false,
    via: ['@expo/code-signing-certificates', 'node-forge'],
  },
  '@expo/code-signing-certificates': {
    node: 'node_modules/@expo/code-signing-certificates',
    range: '*',
    isDirect: false,
    via: ['node-forge'],
  },
  expo: {
    node: 'node_modules/expo',
    range: '>=45.0.0-beta.1',
    isDirect: true,
    via: ['@expo/cli'],
  },
  'node-forge': {
    node: 'node_modules/node-forge',
    range: '*',
    isDirect: false,
  },
};

export function isOnlyExpectedFinding(report) {
  const counts = report?.metadata?.vulnerabilities;
  const vulnerabilities = report?.vulnerabilities;
  if (!counts || !vulnerabilities || typeof vulnerabilities !== 'object') return false;
  if (counts.total !== 4 || counts.high !== 4 || counts.critical !== 0 ||
    counts.moderate !== 0 || counts.low !== 0 || counts.info !== 0) return false;
  const names = Object.keys(vulnerabilities).sort();
  if (names.length !== Object.keys(EXPECTED_FINDINGS).length ||
    names.some((name, index) => name !== Object.keys(EXPECTED_FINDINGS).sort()[index])) return false;

  for (const [name, expected] of Object.entries(EXPECTED_FINDINGS)) {
    const finding = vulnerabilities[name];
    if (finding?.name !== name || finding.severity !== 'high' ||
      finding.range !== expected.range || finding.isDirect !== expected.isDirect ||
      !Array.isArray(finding.nodes) || finding.nodes.length !== 1 ||
      finding.nodes[0] !== expected.node || !Array.isArray(finding.via)) return false;
    if (name === 'node-forge') {
      if (finding.via.length !== 1) return false;
      const advisory = finding.via[0];
      if (advisory === null || typeof advisory !== 'object' ||
        !Number.isSafeInteger(advisory.source) || advisory.source <= 0 ||
        advisory.name !== 'node-forge' || advisory.severity !== 'high' ||
        advisory.range !== '<=1.4.0' ||
        advisory.url !== 'https://github.com/advisories/GHSA-86w9-cpqp-85rv') return false;
    } else {
      const via = [...finding.via].sort();
      const expectedVia = [...expected.via].sort();
      if (via.length !== expectedVia.length || via.some((entry, index) => entry !== expectedVia[index])) return false;
    }
  }
  return true;
}

export function isExpectedLocalMitigation({ lockPackage, installedVersion, patchHash, patchedRsaHash }) {
  return lockPackage?.version === LOCKED_VERSION &&
    lockPackage.resolved === LOCKED_TARBALL &&
    lockPackage.integrity === LOCKED_INTEGRITY &&
    installedVersion === LOCKED_VERSION &&
    patchHash === PATCH_SHA256 &&
    patchedRsaHash === PATCHED_RSA_SHA256;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertLocalMitigation() {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const lockedPackage = lock.packages?.['node_modules/node-forge'];
  const expectedVersions = {
    'node_modules/@expo/code-signing-certificates': '0.0.6',
    'node_modules/expo': '57.0.26',
    'node_modules/expo/node_modules/@expo/cli': '57.0.27',
  };
  if (Object.entries(expectedVersions).some(([path, version]) => lock.packages?.[path]?.version !== version)) {
    throw new Error('The Expo transitive dependency chain differs from the audited lockfile.');
  }
  const installedPackage = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  if (!isExpectedLocalMitigation({
    lockPackage: lockedPackage,
    installedVersion: installedPackage.version,
    patchHash: sha256(PATCH_PATH),
    patchedRsaHash: sha256(RSA_PATH),
  })) {
    throw new Error('The node-forge lock entry, installed version, reviewed patch, or patched verifier differs from the expected mitigation.');
  }
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function runRegression() {
  const result = spawnSync(process.execPath, ['--test', REGRESSION_PATH], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  printResult(result);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('The node-forge security regression did not pass.');
}

function runAudit() {
  console.log('Running npm audit --json across the complete dependency tree.');
  const audit = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  printResult(audit);
  if (audit.error) throw audit.error;
  if (audit.signal) throw new Error(`npm audit terminated by signal ${audit.signal}.`);

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    throw new Error('npm audit did not return valid JSON; refusing to apply the temporary exception.');
  }
  if (!isOnlyExpectedFinding(report)) {
    throw new Error(`Audit output must contain exactly ${ADVISORY_ID} and no other findings.`);
  }

  assertLocalMitigation();
  runRegression();
  // npm audit exits 1 for four findings because npm reports the root advisory
  // plus its three verified Expo metavulnerability dependents.
  if (audit.status !== 1) {
    throw new Error(`Unexpected npm audit exit status ${audit.status}; expected 1 for the known advisory.`);
  }
  console.log(`Temporarily accepted only ${ADVISORY_ID}: locked node-forge@${LOCKED_VERSION} is patched locally, its patch checksum matches, and the exploit regression passed. Remove this exception after an official fixed release is available.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    runAudit();
  } catch (error) {
    console.error(`Security audit failed closed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
