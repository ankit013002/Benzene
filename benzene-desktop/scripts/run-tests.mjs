import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function collectTestFiles(root = packageRoot) {
  return Object.entries({ src: /\.test\.ts$/, scripts: /\.test\.mjs$/ })
    .flatMap(([directory, testFilePattern]) => {
      const absoluteDirectory = path.join(root, directory);
      return readdirSync(absoluteDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && testFilePattern.test(entry.name))
        .map((entry) => path.join(absoluteDirectory, entry.name));
    })
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...collectTestFiles()], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error("Could not start the desktop test process.", result.error);
    process.exitCode = 1;
  } else if (result.signal) {
    console.error(`Desktop tests were interrupted by ${result.signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
