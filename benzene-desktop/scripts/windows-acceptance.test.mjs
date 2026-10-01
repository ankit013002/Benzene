import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./windows-clean-machine-acceptance.ps1", import.meta.url), "utf8");

test("Windows clean-machine acceptance pins installer identity before installing", () => {
  assert.match(script, /ExpectedSha256/);
  assert.match(script, /Get-FileHash[^\n]*SHA256/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /ExpectedSignerThumbprint/);
  assert.match(script, /Status -ne 'Valid'/);
  assert.match(script, /New-Item -ItemType Directory -Path \$installDir/);
  assert.match(script, /ArgumentList @\('\/S'/);
});

test("Windows acceptance checks packaged agent separation and lifecycle without deleting user data", () => {
  assert.match(script, /resourcesDir.*resources/);
  assert.match(script, /node-agent\.cjs/);
  assert.match(script, /separate operating-system process/);
  assert.match(script, /agent did not survive closing the desktop window/);
  assert.match(script, /did not reuse the existing node agent process/);
  assert.match(script, /acceptance-report\.json/);
  assert.doesNotMatch(script, /Remove-Item|Remove-ItemProperty|\brm\s+-Recurse/i);
});
