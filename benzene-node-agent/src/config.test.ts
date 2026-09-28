import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgentConfig } from "./config.js";

beforeEach(() => {
  vi.stubEnv("BENZENE_AGENT_TLS_CERT_FILE", "");
  vi.stubEnv("BENZENE_AGENT_TLS_KEY_FILE", "");
  vi.stubEnv("BENZENE_ADVERTISED_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("transfer TLS configuration", () => {
  it("keeps HTTP as the default advertised transfer protocol", () => {
    const config = loadAgentConfig({ port: 0 });

    expect(config.tlsCertFile).toBeUndefined();
    expect(config.tlsKeyFile).toBeUndefined();
    expect(config.advertisedUrl).toMatch(/^http:\/\//);
    expect(config.advertisedUrl).toMatch(/:0$/);
  });

  it("advertises HTTPS when a certificate and key are configured", () => {
    const config = loadAgentConfig({
      port: 7443,
      tlsCertFile: "/tmp/device-cert.pem",
      tlsKeyFile: "/tmp/device-key.pem",
    });

    expect(config.advertisedUrl).toMatch(/^https:\/\//);
    expect(config.advertisedUrl).toMatch(/:7443$/);
  });

  it.each([
    { tlsCertFile: "/tmp/device-cert.pem" },
    { tlsKeyFile: "/tmp/device-key.pem" },
  ])("rejects a certificate and key that are not configured as a pair", (tls) => {
    expect(() => loadAgentConfig(tls)).toThrow(
      "BENZENE_AGENT_TLS_CERT_FILE and BENZENE_AGENT_TLS_KEY_FILE must be configured together"
    );
  });
});
