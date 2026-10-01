import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectTestFiles } from "./run-tests.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("test runner selects only sorted top-level TypeScript and MJS tests", () => {
  const expected = Object.entries({ src: /\.test\.ts$/, scripts: /\.test\.mjs$/ })
    .flatMap(([directory, testFilePattern]) => {
      const absoluteDirectory = path.join(packageRoot, directory);
      return readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && testFilePattern.test(entry.name))
        .map((entry) => path.join(absoluteDirectory, entry.name));
    })
    .sort();

  const files = collectTestFiles();
  assert.deepEqual(files, expected);
  assert.ok(files.length > 0);
  assert.deepEqual(files, [...files].sort());
});

test("npm test uses the cross-platform Node test runner", async () => {
  const { readFileSync } = await import("node:fs");
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.test, "node scripts/run-tests.mjs");
});
