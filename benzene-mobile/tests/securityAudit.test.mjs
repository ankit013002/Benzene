import assert from 'node:assert/strict';
import test from 'node:test';
import { isExpectedLocalMitigation, isOnlyExpectedFinding } from '../scripts/security-audit.mjs';

const allowedReport = {
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 4, critical: 0, total: 4 },
  },
  vulnerabilities: {
    '@expo/cli': {
      name: '@expo/cli',
      severity: 'high',
      range: '<=0.0.0-canary-20231123-1b19f96-4 || >=0.0.1-canary-20231125-d600e44',
      isDirect: false,
      nodes: ['node_modules/expo/node_modules/@expo/cli'],
      via: ['@expo/code-signing-certificates', 'node-forge'],
    },
    '@expo/code-signing-certificates': {
      name: '@expo/code-signing-certificates',
      severity: 'high',
      range: '*',
      isDirect: false,
      nodes: ['node_modules/@expo/code-signing-certificates'],
      via: ['node-forge'],
    },
    expo: {
      name: 'expo',
      severity: 'high',
      range: '>=45.0.0-beta.1',
      isDirect: true,
      nodes: ['node_modules/expo'],
      via: ['@expo/cli'],
    },
    'node-forge': {
      name: 'node-forge',
      severity: 'high',
      range: '*',
      isDirect: false,
      nodes: ['node_modules/node-forge'],
      via: [{
        source: 1240912,
        name: 'node-forge',
        severity: 'high',
        range: '<=1.4.0',
        url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv',
      }],
    },
  },
};

test('audit exception requires exactly the locked node-forge advisory', () => {
  assert.equal(isOnlyExpectedFinding(allowedReport), true);
});

test('audit exception fails closed if npm omits the exact advisory identifier', () => {
  const report = structuredClone(allowedReport);
  report.vulnerabilities['node-forge'].via[0].url = undefined;
  assert.equal(isOnlyExpectedFinding(report), false);
  assert.equal(isOnlyExpectedFinding({}), false);
});

test('audit exception rejects any additional finding or severity', () => {
  const report = structuredClone(allowedReport);
  report.metadata.vulnerabilities.moderate = 1;
  report.metadata.vulnerabilities.total = 5;
  report.vulnerabilities.other = {
    name: 'other', severity: 'moderate', range: '*', nodes: ['node_modules/other'], via: [],
  };
  assert.equal(isOnlyExpectedFinding(report), false);
});

test('audit exception rejects a different node-forge version range or install path', () => {
  const report = structuredClone(allowedReport);
  report.vulnerabilities['node-forge'].via[0].range = '< 1.4.1';
  assert.equal(isOnlyExpectedFinding(report), false);
  report.vulnerabilities['node-forge'].via[0].range = '<= 1.4.0';
  report.vulnerabilities['@expo/cli'].nodes = ['node_modules/@expo/cli'];
  assert.equal(isOnlyExpectedFinding(report), false);
});

test('audit exception requires the exact Expo metavulnerability chain', () => {
  const report = structuredClone(allowedReport);
  report.vulnerabilities['@expo/cli'].via = ['node-forge'];
  assert.equal(isOnlyExpectedFinding(report), false);
  report.vulnerabilities['@expo/cli'].via = ['@expo/code-signing-certificates', 'node-forge'];
  report.vulnerabilities.expo.via = ['node-forge'];
  assert.equal(isOnlyExpectedFinding(report), false);
});

test('audit exception rejects substituted advisory URLs and mutated finding metadata', () => {
  const wrongAdvisory = structuredClone(allowedReport);
  wrongAdvisory.vulnerabilities['node-forge'].via[0].url = 'https://github.com/advisories/GHSA-0000-0000-0000';
  assert.equal(isOnlyExpectedFinding(wrongAdvisory), false);

  const wrongRange = structuredClone(allowedReport);
  wrongRange.vulnerabilities['@expo/cli'].range = '*';
  assert.equal(isOnlyExpectedFinding(wrongRange), false);

  const wrongDirectness = structuredClone(allowedReport);
  wrongDirectness.vulnerabilities.expo.isDirect = false;
  assert.equal(isOnlyExpectedFinding(wrongDirectness), false);
});

test('audit exception rejects a mutated transitive via chain', () => {
  const report = structuredClone(allowedReport);
  report.vulnerabilities['@expo/code-signing-certificates'].via = ['node-forge', '@expo/cli'];
  assert.equal(isOnlyExpectedFinding(report), false);
});

test('local exception requires exact lock, installed version, patch, and patched source hashes', () => {
  const mitigation = {
    lockPackage: {
      version: '1.4.0',
      resolved: 'https://registry.npmjs.org/node-forge/-/node-forge-1.4.0.tgz',
      integrity: 'sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==',
    },
    installedVersion: '1.4.0',
    patchHash: '8bedb62744f95a7cdbc8b159a7bcdae3218308e1394c7995bc1f2c96a571e604',
    patchedRsaHash: 'acc22e5d36e27832c34e02dd3933aad7977d45b047eead5016520735efedc9c5',
  };
  assert.equal(isExpectedLocalMitigation(mitigation), true);
  const mismatches = [
    ['locked version', (value) => { value.lockPackage.version = '1.4.1'; }],
    ['locked tarball', (value) => { value.lockPackage.resolved = 'https://example.invalid/node-forge.tgz'; }],
    ['locked integrity', (value) => { value.lockPackage.integrity = 'sha512-other'; }],
    ['installed version', (value) => { value.installedVersion = '1.4.1'; }],
    ['patch checksum', (value) => { value.patchHash = 'unexpected'; }],
    ['patched source checksum', (value) => { value.patchedRsaHash = 'unexpected'; }],
  ];
  for (const [label, change] of mismatches) {
    const changed = structuredClone(mitigation);
    change(changed);
    assert.equal(isExpectedLocalMitigation(changed), false, `${label} must match the expected mitigation`);
  }
});
