import path from "node:path";

import { build } from "esbuild";

await build({
  entryPoints: [path.resolve("../benzene-node-agent/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.resolve("built/node-agent.cjs"),
  nodePaths: [path.resolve("node_modules")],
});
