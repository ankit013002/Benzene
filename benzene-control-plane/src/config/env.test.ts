import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, resetConfigCache } from "./env.js";

describe("device lifecycle thresholds", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/benzene");
    vi.stubEnv("MONGOOSE_URI", "mongodb://localhost/benzene");
    vi.stubEnv("STORAGE_DRIVER", "local");
    vi.stubEnv("DEVICE_OFFLINE_AFTER_SECONDS", "120");
    vi.stubEnv("DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS", "86400");
    vi.stubEnv("DEVICE_SUSPECTED_LOST_AFTER_SECONDS", "");
    resetConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  it("keeps presumed-loss classification disabled by default", () => {
    const config = loadConfig();

    expect(config.deviceOfflineAfterSeconds).toBe(120);
    expect(config.deviceExtendedOfflineAfterSeconds).toBe(86400);
    expect(config.deviceSuspectedLostAfterSeconds).toBeUndefined();
    expect(config.deviceOutageSweepIntervalSeconds).toBe(60);
    expect(config.rebalanceIntervalSeconds).toBe(300);
    expect(config.rebalanceMinUsageDeltaPercent).toBe(10);
  });

  it("requires extended offline to be longer than ordinary offline", () => {
    vi.stubEnv("DEVICE_EXTENDED_OFFLINE_AFTER_SECONDS", "120");

    expect(() => loadConfig()).toThrow(/OFFLINE_AFTER_SECONDS must be less/);
  });

  it("requires presumed loss to be longer than extended offline", () => {
    vi.stubEnv("DEVICE_SUSPECTED_LOST_AFTER_SECONDS", "86400");

    expect(() => loadConfig()).toThrow(/EXTENDED_OFFLINE_AFTER_SECONDS must be less/);
  });

  it("accepts an explicitly ordered presumed-loss threshold", () => {
    vi.stubEnv("DEVICE_SUSPECTED_LOST_AFTER_SECONDS", "172800");

    expect(loadConfig().deviceSuspectedLostAfterSeconds).toBe(172800);
  });

  it("accepts a positive outage sweep interval", () => {
    vi.stubEnv("DEVICE_OUTAGE_SWEEP_INTERVAL_SECONDS", "15");

    expect(loadConfig().deviceOutageSweepIntervalSeconds).toBe(15);
  });

  it("rejects a disabled outage sweep", () => {
    vi.stubEnv("DEVICE_OUTAGE_SWEEP_INTERVAL_SECONDS", "0");

    expect(() => loadConfig()).toThrow(/OUTAGE_SWEEP_INTERVAL_SECONDS.*positive/);
  });

  it("requires a positive vault rebalance interval", () => {
    vi.stubEnv("REBALANCE_INTERVAL_SECONDS", "0");

    expect(() => loadConfig()).toThrow(/REBALANCE_INTERVAL_SECONDS.*positive/);
  });
});
