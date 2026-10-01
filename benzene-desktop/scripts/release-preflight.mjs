import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

export function validateReleaseEnvironment(environment, packageConfig) {
  const errors = [];
  const platform = environment.RELEASE_PLATFORM;

  if (platform !== "macos" && platform !== "windows") {
    errors.push("RELEASE_PLATFORM must be macos or windows.");
  }

  for (const [key, label] of [
    ["DESKTOP_APP_URL", "Vault app origin"],
    ["DESKTOP_GATEWAY_URL", "Gateway origin"],
  ]) {
    const error = validatePublicHttpsOrigin(environment[key], label);
    if (error) errors.push(error);
  }

  if (!environment.CSC_LINK?.trim()) errors.push("A platform signing certificate (CSC_LINK) is required.");
  if (!environment.CSC_KEY_PASSWORD?.trim()) errors.push("The platform signing certificate password (CSC_KEY_PASSWORD) is required.");

  if (platform === "macos") {
    for (const key of ["APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"]) {
      if (!environment[key]?.trim()) errors.push(`${key} is required for macOS notarization.`);
    }
  }

  const build = packageConfig?.build;
  if (packageConfig?.version === "0.0.0" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageConfig?.version ?? "")) {
    errors.push("Desktop package version must be a release version.");
  }
  if (build?.appId !== "com.benzene.desktop" || build?.productName !== "Benzene") {
    errors.push("Desktop product identity must match the approved Benzene package identity.");
  }
  if (platform === "macos" && !build?.mac?.target?.includes("dmg")) {
    errors.push("The macOS DMG target is not configured.");
  }
  if (platform === "windows" && !build?.win?.target?.includes("nsis")) {
    errors.push("The Windows NSIS target is not configured.");
  }

  return errors;
}

export function validatePublicHttpsOrigin(value, label) {
  if (!value?.trim()) return `${label} is required.`;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return `${label} must be a valid HTTPS origin.`;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const forbiddenSuffixes = [".example", ".example.com", ".example.net", ".example.org", ".invalid", ".test", ".localhost", ".local", ".internal", ".lan"];
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return `${label} must be an HTTPS origin without credentials, path, query, or fragment.`;
  }
  if (host === "localhost" || forbiddenSuffixes.some((suffix) => host.endsWith(suffix)) || isPrivateIpv4(host)) {
    return `${label} cannot use a local, private, or placeholder host.`;
  }
  if (host.includes(":") || isIpv4Literal(host) || !host.includes(".")) return `${label} must use a public DNS name.`;
  return undefined;
}

function isPrivateIpv4(host) {
  const pieces = host.split(".");
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece) || Number(piece) > 255)) return false;
  const [first, second] = pieces.map(Number);
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isIpv4Literal(host) {
  return host.split(".").length === 4 && host.split(".").every((piece) => /^\d{1,3}$/.test(piece) && Number(piece) <= 255);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const packageConfig = JSON.parse(readFileSync(packagePath, "utf8"));
  const errors = validateReleaseEnvironment(process.env, packageConfig);
  if (errors.length > 0) {
    console.error("Desktop release preflight failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Desktop ${process.env.RELEASE_PLATFORM} package preflight passed. Credentials were checked for presence; signing and notarization are not asserted until the produced artifacts are independently verified.`);
  }
}
