import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePublicHttpsOrigin } from "./release-preflight.mjs";

export function releaseDefaultsFromEnvironment(environment) {
  const appUrl = environment.DESKTOP_APP_URL;
  const gatewayUrl = environment.DESKTOP_GATEWAY_URL;
  if (!appUrl && !gatewayUrl) {
    if (environment.RELEASE_PLATFORM) throw new Error("Release builds require both service origins.");
    return undefined;
  }
  const appError = validatePublicHttpsOrigin(appUrl, "Vault app origin");
  const gatewayError = validatePublicHttpsOrigin(gatewayUrl, "Gateway origin");
  if (appError || gatewayError) throw new Error([appError, gatewayError].filter(Boolean).join(" "));
  return { appUrl: new URL(appUrl.trim()).origin, gatewayUrl: new URL(gatewayUrl.trim()).origin };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const configPath = path.resolve("built/release-config.json");
  try {
    const defaults = releaseDefaultsFromEnvironment(process.env);
    if (!defaults) {
      await rm(configPath, { force: true });
    } else {
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o644 });
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "Could not configure packaged service defaults.");
    process.exitCode = 1;
  }
}
