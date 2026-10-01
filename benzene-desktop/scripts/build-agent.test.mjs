import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const desktopModules = path.join(desktopRoot, "node_modules");
const desktopRequire = createRequire(new URL("../package.json", import.meta.url));

test("pins every node-agent runtime dependency in the desktop development toolchain", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const expected = {
    dotenv: "17.4.2",
    express: "5.2.1",
    helmet: "8.3.0",
    ws: "8.22.0",
    zod: "4.6.0",
  };

  for (const [name, version] of Object.entries(expected)) {
    assert.equal(manifest.devDependencies[name], version);
    assert.equal(lock.packages[""].devDependencies[name], version);
    const resolvedFromDesktop = path.relative(desktopModules, desktopRequire.resolve(name)).replaceAll("\\", "/");
    assert.notEqual(resolvedFromDesktop, "..");
    assert.ok(!resolvedFromDesktop.startsWith("../"), `${name} resolves from the desktop install`);
    assert.ok(!path.isAbsolute(resolvedFromDesktop), `${name} resolves under the desktop install`);
  }
});

test("esbuild searches the desktop package install when bundling the sibling agent source", () => {
  const script = readFileSync(new URL("./build-agent.mjs", import.meta.url), "utf8");
  assert.match(script, /nodePaths:\s*\[path\.resolve\("node_modules"\)\]/);
  assert.doesNotMatch(script, /benzene-node-agent\/node_modules/);
});
