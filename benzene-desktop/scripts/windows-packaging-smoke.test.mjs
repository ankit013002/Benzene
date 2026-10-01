import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/ci-pr.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function windowsPackagingJob(source = workflow) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf("  desktop-windows-packaging-smoke:");
  assert.notEqual(start, -1, "Windows packaging smoke job must exist in ordinary CI");
  const nextJobMatch = /\n  [a-z0-9-]+:\n/g;
  nextJobMatch.lastIndex = start + 3;
  const nextJob = nextJobMatch.exec(normalized)?.index ?? -1;
  return normalized.slice(start, nextJob === -1 ? undefined : nextJob);
}

test("Windows packaging smoke is path-gated, unsigned, and has no release side effects", () => {
  const job = windowsPackagingJob();
  assert.match(job, /needs: detect-changes/);
  assert.match(job, /if: needs\.detect-changes\.outputs\.desktop == 'true'/);
  assert.match(job, /runs-on: windows-2022/);
  assert.match(job, /node-version: 22\.13\.1/);
  assert.match(job, /run: npm ci/);
  assert.match(job, /run: npm run typecheck/);
  assert.match(job, /run: npm test/);
  assert.match(job, /run: npm run smoke:dist:win/);
  assert.match(job, /CSC_IDENTITY_AUTO_DISCOVERY: false/);
  assert.doesNotMatch(job, /environment:|secrets\.|vars\.|upload-artifact|gh release|create-release/i);
  assert.match(packageJson.scripts["smoke:dist:win"], /electron-builder --win nsis --publish never/);

  const filterStart = workflow.indexOf("            desktop:\n");
  assert.notEqual(filterStart, -1, "desktop path filter must remain explicit");
  const filterEnd = workflow.indexOf("\n  store-deployment-probe:", filterStart);
  const detectChanges = workflow.slice(0, filterEnd === -1 ? undefined : filterEnd);
  const desktopFilter = detectChanges.slice(filterStart);
  assert.match(desktopFilter, /- 'benzene-desktop\/\*\*'/);
  assert.match(desktopFilter, /- '\.github\/workflows\/ci-pr\.yml'/);
  assert.doesNotMatch(desktopFilter, /- '\.github\/workflows\/\*\*'/);
});

test("Windows workflow assertions extract the job correctly with CRLF line endings", () => {
  const crlfWorkflow = workflow.replace(/\n/g, "\r\n");
  assert.equal(windowsPackagingJob(crlfWorkflow), windowsPackagingJob(workflow));
});

test("Windows packaging smoke installs only to runner temp and checks the packaged app and agent", () => {
  const job = windowsPackagingJob();
  const installStart = job.indexOf("Install into isolated temporary directory and inspect package");
  assert.notEqual(installStart, -1);
  const install = job.slice(installStart);
  assert.match(install, /Join-Path \$env:RUNNER_TEMP/);
  assert.match(install, /Start-Process[\s\S]*?"\/S"[\s\S]*?"\/D=\$installDir"/);
  assert.match(install, /Benzene\.exe/);
  assert.match(install, /resources\/node-agent\.cjs/);
  assert.match(install, /This is not release-ready evidence/);
  assert.doesNotMatch(install, /Remove-Item|Uninstall|upload-artifact/i);
});
