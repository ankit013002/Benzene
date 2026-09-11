import { describe, expect, it } from "vitest";
import { databaseSslConfig } from "./ssl";

describe("databaseSslConfig", () => {
  it("does not enable TLS for local development", () => {
    expect(databaseSslConfig("development")).toBe(false);
  });

  it("requires certificate validation in production", () => {
    expect(databaseSslConfig("production")).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("passes a configured private CA to the production client", () => {
    expect(databaseSslConfig("production", "  pem-ca  ")).toEqual({
      ca: "pem-ca",
      rejectUnauthorized: true,
    });
  });
});
