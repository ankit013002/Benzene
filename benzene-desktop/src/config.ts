export interface DesktopSettings {
  appUrl: string;
  gatewayUrl: string;
  allocationGb: number;
  deviceName: string;
}

export type NavigationAction = "internal" | "external" | "deny";

export function navigationAction(target: string, trustedOrigin: string): NavigationAction {
  let url: URL;
  let trusted: URL;
  try {
    url = new URL(target);
    trusted = new URL(trustedOrigin);
  } catch {
    return "deny";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "deny";
  if (trusted.protocol !== "http:" && trusted.protocol !== "https:") return "deny";
  return url.origin === trusted.origin ? "internal" : "external";
}

const MIN_ALLOCATION_GB = 1;
const MAX_SAFE_GB = Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 3);

export function validateOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS address.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${label} must use HTTP or HTTPS and cannot contain credentials.`);
  }
  if (url.protocol === "http:" && !isDevelopmentHost(url.hostname)) {
    throw new Error(`${label} must use HTTPS unless it points to this computer or a private LAN address.`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an origin without a path, query, or fragment.`);
  }
  return url.origin;
}

function isDevelopmentHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1") {
    return true;
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  }
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function validateSettings(input: DesktopSettings): DesktopSettings {
  const allocationGb = Number(input.allocationGb);
  if (!Number.isSafeInteger(allocationGb) || allocationGb < MIN_ALLOCATION_GB || allocationGb > MAX_SAFE_GB) {
    throw new Error(`Choose a whole number of gigabytes between ${MIN_ALLOCATION_GB} and ${MAX_SAFE_GB}.`);
  }
  const deviceName = input.deviceName.trim();
  if (!deviceName || deviceName.length > 100) {
    throw new Error("Computer name must be between 1 and 100 characters.");
  }
  return {
    appUrl: validateOrigin(input.appUrl, "Vault app address"),
    gatewayUrl: validateOrigin(input.gatewayUrl, "Gateway address"),
    allocationGb,
    deviceName,
  };
}

export function pairingCodeFromLog(log: string): string | undefined {
  const enrollment = log.lastIndexOf("[agent] enrolled as device ");
  const recentLog = log.slice(enrollment < 0 ? 0 : enrollment);
  const codes = [...recentLog.matchAll(/Approve it with the code:\s*([A-HJKM-NP-Z2-9]{4}-?[A-HJKM-NP-Z2-9]{4})/gi)];
  return codes.at(-1)?.[1]?.toUpperCase();
}
