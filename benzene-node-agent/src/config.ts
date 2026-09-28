import { homedir, hostname, networkInterfaces } from "node:os";
import path from "node:path";

import dotenv from "dotenv";

dotenv.config();

export interface AgentConfig {
  /** Where the control plane lives, via the gateway. */
  controlPlaneUrl: string;
  /** Root of everything this agent owns on disk. */
  dataDir: string;
  storageDir: string;
  identityFile: string;
  /** Bytes this device offers the vault. */
  allocatedBytes: number;
  /** Port the transfer server listens on for LAN peers. */
  port: number;
  /** Optional TLS certificate chain for direct HTTPS transfers. */
  tlsCertFile?: string;
  /** Optional TLS private key paired with tlsCertFile. */
  tlsKeyFile?: string;
  /**
   * Absolute URL peers should use to reach this device. Defaults to the LAN
   * address and uses HTTPS when a TLS certificate pair is configured.
   */
  advertisedUrl: string;
  heartbeatIntervalMs: number;
  /** Minimum interval between bounded repair polls. */
  repairIntervalMs: number;
  /** Minimum interval between bounded rebalance polls. */
  rebalanceIntervalMs: number;
  deviceName: string;
  platform: "macos" | "windows" | "linux" | "other";
}

function detectPlatform(): AgentConfig["platform"] {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function loadAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const dataDir =
    overrides.dataDir ?? process.env["BENZENE_DATA_DIR"] ?? path.join(homedir(), ".benzene");
  const port = overrides.port ?? intFromEnv("BENZENE_AGENT_PORT", 7070);
  const tlsCertFile =
    overrides.tlsCertFile ?? process.env["BENZENE_AGENT_TLS_CERT_FILE"];
  const tlsKeyFile =
    overrides.tlsKeyFile ?? process.env["BENZENE_AGENT_TLS_KEY_FILE"];

  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error(
      "BENZENE_AGENT_TLS_CERT_FILE and BENZENE_AGENT_TLS_KEY_FILE must be configured together"
    );
  }

  return {
    controlPlaneUrl: (
      overrides.controlPlaneUrl ??
      process.env["BENZENE_CONTROL_PLANE_URL"] ??
      "http://localhost:8080"
    ).replace(/\/+$/, ""),
    dataDir,
    storageDir: overrides.storageDir ?? path.join(dataDir, "storage"),
    identityFile: overrides.identityFile ?? path.join(dataDir, "identity.json"),
    // Zero means "enrolled but contributing nothing yet"; the control plane is
    // the source of truth once the user has chosen an amount.
    allocatedBytes: overrides.allocatedBytes ?? intFromEnv("BENZENE_ALLOCATED_BYTES", 0),
    port,
    ...(tlsCertFile ? { tlsCertFile } : {}),
    ...(tlsKeyFile ? { tlsKeyFile } : {}),
    advertisedUrl:
      overrides.advertisedUrl ??
      (process.env["BENZENE_ADVERTISED_URL"] ||
        `${tlsCertFile ? "https" : "http"}://${lanAddress()}:${port}`),
    heartbeatIntervalMs:
      overrides.heartbeatIntervalMs ?? intFromEnv("BENZENE_HEARTBEAT_MS", 30_000),
    repairIntervalMs:
      overrides.repairIntervalMs ?? intFromEnv("BENZENE_REPAIR_MS", 60_000),
    rebalanceIntervalMs:
      overrides.rebalanceIntervalMs ?? intFromEnv("BENZENE_REBALANCE_MS", 60_000),
    deviceName:
      overrides.deviceName ?? process.env["BENZENE_DEVICE_NAME"] ?? defaultDeviceName(),
    platform: overrides.platform ?? detectPlatform(),
  };
}

/**
 * First non-internal IPv4 address. Good enough for a home LAN; a device behind
 * NAT that needs to be reachable remotely will need the relay path instead.
 */
function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function defaultDeviceName(): string {
  return hostname() || "Benzene Device";
}
