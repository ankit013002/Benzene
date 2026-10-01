import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateReleaseEnvironment } from "./release-preflight.mjs";
import { isValidAppleApiKey } from "./prepare-macos-signing.mjs";
import { releaseDefaultsFromEnvironment } from "./write-release-config.mjs";

const packageConfig = {
  version: "0.1.0",
  build: {
    appId: "com.benzene.desktop",
    productName: "Benzene",
    mac: { target: ["dmg"] },
    win: { target: ["nsis"] },
  },
};

const baseEnvironment = {
  DESKTOP_APP_URL: "https://vault.benzene.test.com",
  DESKTOP_GATEWAY_URL: "https://gateway.benzene.test.com",
  CSC_LINK: "protected-certificate-payload",
  CSC_KEY_PASSWORD: "protected-password",
};

function macEnvironment() {
  return {
    ...baseEnvironment,
    RELEASE_PLATFORM: "macos",
    APPLE_API_KEY_ID: "ABC1234567",
    APPLE_API_ISSUER: "12345678-1234-1234-1234-123456789abc",
    APPLE_TEAM_ID: "ABCDE12345",
  };
}

test("accepts configured macOS signing and notarization identifiers", () => {
  assert.deepEqual(validateReleaseEnvironment(macEnvironment(), packageConfig), []);
});

test("accepts configured Windows signing inputs without requiring Apple credentials", () => {
  assert.deepEqual(validateReleaseEnvironment({ ...baseEnvironment, RELEASE_PLATFORM: "windows" }, packageConfig), []);
});

test("packages the validated HTTPS origins as first-launch service defaults", () => {
  assert.deepEqual(releaseDefaultsFromEnvironment({
    DESKTOP_APP_URL: "https://vault.benzene.test.com/",
    DESKTOP_GATEWAY_URL: "https://gateway.benzene.test.com/",
  }), {
    appUrl: "https://vault.benzene.test.com",
    gatewayUrl: "https://gateway.benzene.test.com",
  });
  assert.equal(releaseDefaultsFromEnvironment({}), undefined);
  assert.throws(() => releaseDefaultsFromEnvironment({ RELEASE_PLATFORM: "macos" }), /Release builds require both service origins/);
  assert.throws(() => releaseDefaultsFromEnvironment({ DESKTOP_APP_URL: "https://vault.benzene.test.com" }), /Gateway origin is required/);
});

test("fails closed for missing credentials, service origins, and unsupported platforms", () => {
  const errors = validateReleaseEnvironment({ RELEASE_PLATFORM: "linux" }, packageConfig);
  assert.match(errors.join("\n"), /must be macos or windows/);
  assert.match(errors.join("\n"), /Vault app origin is required/);
  assert.match(errors.join("\n"), /Gateway origin is required/);
  assert.match(errors.join("\n"), /CSC_LINK/);
  assert.match(errors.join("\n"), /CSC_KEY_PASSWORD/);
});

test("rejects local, placeholder, non-HTTPS, and path-bearing deployment origins", () => {
  for (const origin of ["http://vault.example.org", "https://localhost", "https://192.168.1.5", "https://vault.example", "https://vault.example.org/login"]) {
    const errors = validateReleaseEnvironment({
      ...baseEnvironment,
      RELEASE_PLATFORM: "windows",
      DESKTOP_APP_URL: origin,
    }, packageConfig);
    assert.ok(errors.some((error) => error.startsWith("Vault app origin")), origin);
  }
});

test("requires complete macOS notarization credentials and correct product targets", () => {
  const environment = macEnvironment();
  delete environment.APPLE_API_KEY_ID;
  const errors = validateReleaseEnvironment(environment, {
    ...packageConfig,
    build: { ...packageConfig.build, mac: { target: ["zip"] } },
  });
  assert.match(errors.join("\n"), /APPLE_API_KEY_ID/);
  assert.match(errors.join("\n"), /DMG target/);
});

test("accepts only a parseable Apple P-256 API key for temporary runner preparation", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const appleKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.equal(isValidAppleApiKey(appleKey), true);
  assert.equal(isValidAppleApiKey("-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----"), false);
  assert.equal(isValidAppleApiKey(undefined), false);
});

test("release workflow is manual, protected, preflight-first, and uses immutable action references", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|^\s+push:/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /environment: desktop-production/);
  assert.match(workflow, /run: npm run release:preflight/);
  assert.ok(workflow.indexOf("Run release preflight") < workflow.indexOf("Build macOS DMG"));
  assert.ok(workflow.indexOf("Run release preflight") < workflow.indexOf("Build Windows NSIS installer"));
  assert.ok(workflow.indexOf("Verify macOS code signature") < workflow.indexOf("Upload installer candidate"));
  assert.ok(workflow.indexOf("Verify Windows Authenticode signature") < workflow.indexOf("Upload installer candidate"));
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("    steps:")), /secrets\./);
  const privateKeyPreparation = workflow.slice(workflow.indexOf("Prepare temporary macOS"), workflow.indexOf("Build macOS DMG"));
  assert.match(privateKeyPreparation, /APPLE_API_KEY_P8/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("Prepare temporary macOS")), /APPLE_API_KEY_P8/);
  const installStep = workflow.slice(workflow.indexOf("Install locked dependencies"), workflow.indexOf("Run release preflight"));
  assert.doesNotMatch(installStep, /secrets\./);
  const testSteps = workflow.slice(workflow.indexOf("Typecheck and run deterministic tests"), workflow.indexOf("Prepare temporary macOS"));
  assert.doesNotMatch(testSteps, /secrets\./);
  assert.doesNotMatch(workflow, /create-release|softprops\/action-gh-release|gh release create/);
});

test("pull request CI does not receive desktop signing credentials", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci-pr.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /MACOS_CSC_LINK|WINDOWS_CSC_LINK|APPLE_API_KEY_P8|CSC_KEY_PASSWORD/);
});
