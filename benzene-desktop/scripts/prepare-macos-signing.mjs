import { createPrivateKey } from "node:crypto";
import { open, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isValidAppleApiKey(value) {
  if (!value?.includes("-----BEGIN PRIVATE KEY-----")) return false;
  try {
    const key = createPrivateKey(value);
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const privateKey = process.env.APPLE_API_KEY_P8;
  const runnerTemp = process.env.RUNNER_TEMP;
  const githubEnv = process.env.GITHUB_ENV;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;

  if (!isValidAppleApiKey(privateKey) || !runnerTemp || !githubEnv || !runId || !runAttempt) {
    console.error("Cannot prepare macOS notarization credentials: the private key or protected workflow values are missing or invalid.");
    process.exitCode = 1;
  } else {
    const directory = path.join(runnerTemp, `benzene-desktop-release-${runId}-${runAttempt}`);
    const keyPath = path.join(directory, "apple-api-key.p8");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rm(keyPath, { force: true });
    const keyFile = await open(keyPath, "wx", 0o600);
    try {
      await keyFile.writeFile(privateKey, "utf8");
    } finally {
      await keyFile.close();
    }
    const envFile = await open(githubEnv, "a", 0o600);
    try {
      await envFile.writeFile(`APPLE_API_KEY=${keyPath}\n`, "utf8");
    } finally {
      await envFile.close();
    }
  }
}
