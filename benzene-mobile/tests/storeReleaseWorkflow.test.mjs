import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync(path.resolve('..', '.github/workflows/mobile-store-release.yml'), 'utf8');
const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));

test('native store release can only be started manually from master', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /default: false\n\s+type: boolean/);
});

test('native release preflights precede any EAS build or submit', () => {
  const config = workflow.indexOf('npm run check:store-config');
  const buildPreflight = workflow.indexOf('npm run check:store-build');
  const submitPreflight = workflow.indexOf('npm run check:store-submit');
  const deploymentPreflight = workflow.indexOf('npm run verify:store-deployment');
  const build = workflow.indexOf('eas-cli@');
  const submit = workflow.indexOf('eas-cli@', build + 1);
  assert.ok(config >= 0 && config < buildPreflight);
  assert.ok(buildPreflight < build);
  assert.ok(submitPreflight > buildPreflight && submitPreflight < build);
  assert.ok(deploymentPreflight > submitPreflight && deploymentPreflight < build);
  assert.match(workflow, /Verify public store deployment and app links\n\s+if: inputs\.submit/);
  assert.match(workflow, /APPLE_APP_LINK_TEAM_ID: \$\{\{ vars\.APPLE_APP_LINK_TEAM_ID \}\}/);
  assert.match(workflow, /ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS: \$\{\{ vars\.ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS \}\}/);
  assert.ok(submit > build);
  assert.match(workflow, /record:store-builds/);
  assert.match(workflow, /--wait --json --non-interactive/);
  assert.match(workflow, /submit --platform ios .*--id "\$IOS_BUILD_ID"/);
  assert.match(workflow, /submit --platform android .*--id "\$ANDROID_BUILD_ID"/);
  assert.doesNotMatch(workflow, /submit[^\n]*--latest/);
});

test('native release uses immutable action SHAs and a pinned EAS CLI version', () => {
  const actionRefs = [...workflow.matchAll(/^\s+uses:\s+\S+@([0-9a-f]{40})\b/gm)];
  assert.equal(actionRefs.length, 2);
  assert.equal(eas.cli.version, '24.3.0');
  assert.match(workflow, /eas-cli@24\.3\.0/);
});

test('native release uses the scoped production environment and never logs credential variables', () => {
  assert.match(workflow, /environment: mobile-production/);
  for (const name of ['EXPO_TOKEN', 'ASC_API_PRIVATE_KEY_P8', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON']) {
    assert.match(workflow, new RegExp(`\\b${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
    assert.doesNotMatch(workflow, new RegExp(`echo[^\\n]*${name}`));
  }
  assert.match(workflow, /Remove temporary store credentials/);
});
