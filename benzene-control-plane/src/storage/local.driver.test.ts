import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config/env.js";
import { LocalStorageDriver } from "./local.driver.js";

let root: string;

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 5000,
    mongooseUri: "mongodb://localhost/test",
    storageDriver: "local",
    maxUploadBytes: 1024 * 1024,
    presignTtlSeconds: 900,
    enrollmentCodeTtlSeconds: 600,
    enrollmentRateLimitMax: 10,
    enrollmentRateLimitWindowSeconds: 60,
    s3: { bucket: "", region: "", endpoint: undefined, forcePathStyle: false },
    local: { rootDir: root, publicBaseUrl: "http://localhost:5000/local-objects" },
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nv-local-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("LocalStorageDriver", () => {
  it("round-trips an object through put, head and read", async () => {
    const driver = new LocalStorageDriver(makeConfig());
    const body = Buffer.from("hello nebula");

    await driver.putObject("users/u1/nodes/n1/v1", body);

    const head = await driver.headObject("users/u1/nodes/n1/v1");
    expect(head).toEqual({ bytes: body.length, contentType: undefined, etag: undefined });

    const onDisk = await readFile(path.join(root, "users/u1/nodes/n1/v1"));
    expect(onDisk.toString()).toBe("hello nebula");
  });

  it("reports null for a missing object rather than throwing", async () => {
    const driver = new LocalStorageDriver(makeConfig());
    await expect(driver.headObject("nope")).resolves.toBeNull();
  });

  it("deletes objects and tolerates deleting a missing one", async () => {
    const driver = new LocalStorageDriver(makeConfig());
    await driver.putObject("a/b", Buffer.from("x"));

    await driver.deleteObject("a/b");
    expect(await driver.headObject("a/b")).toBeNull();

    await expect(driver.deleteObject("a/b")).resolves.toBeUndefined();
  });

  it("deletes many objects at once", async () => {
    const driver = new LocalStorageDriver(makeConfig());
    await driver.putObject("k1", Buffer.from("1"));
    await driver.putObject("k2", Buffer.from("2"));

    await driver.deleteObjects(["k1", "k2"]);

    expect(await driver.headObject("k1")).toBeNull();
    expect(await driver.headObject("k2")).toBeNull();
  });

  describe("signed URLs", () => {
    it("issues a URL that verifies with its own signature", async () => {
      const driver = new LocalStorageDriver(makeConfig());
      const target = await driver.createUploadTarget({
        key: "users/u1/nodes/n1/v1",
        contentType: "text/plain",
        contentLength: 12,
      });

      const url = new URL(target.url);
      const exp = Number(url.searchParams.get("exp"));
      const sig = url.searchParams.get("sig") ?? "";

      expect(target.method).toBe("PUT");
      expect(target.headers["Content-Type"]).toBe("text/plain");
      expect(driver.verify("users/u1/nodes/n1/v1", exp, sig)).toBe(true);
    });

    it("percent-encodes each key segment without escaping the separators", async () => {
      const driver = new LocalStorageDriver(makeConfig());
      const target = await driver.createUploadTarget({
        key: "users/u 1/nodes/n#1/v1",
        contentType: "text/plain",
        contentLength: 1,
      });

      expect(target.url).toContain("/users/u%201/nodes/n%231/v1?");
    });

    it("rejects a signature minted for a different key", () => {
      const driver = new LocalStorageDriver(makeConfig());
      const exp = Date.now() + 60_000;
      const sig = driver.sign("key-a", exp);

      expect(driver.verify("key-b", exp, sig)).toBe(false);
    });

    it("rejects a tampered expiry, since expiry is part of the signature", () => {
      const driver = new LocalStorageDriver(makeConfig());
      const exp = Date.now() + 60_000;
      const sig = driver.sign("key-a", exp);

      expect(driver.verify("key-a", exp + 60_000, sig)).toBe(false);
    });

    it("rejects an expired signature", () => {
      vi.useFakeTimers();
      const driver = new LocalStorageDriver(makeConfig());
      const exp = Date.now() + 1_000;
      const sig = driver.sign("key-a", exp);

      vi.advanceTimersByTime(2_000);

      expect(driver.verify("key-a", exp, sig)).toBe(false);
    });

    it.each([
      ["empty", ""],
      ["short", "abc"],
      ["non-hex", "z".repeat(64)],
    ])("rejects a %s signature", (_label, sig) => {
      const driver = new LocalStorageDriver(makeConfig());
      expect(driver.verify("key-a", Date.now() + 60_000, sig)).toBe(false);
    });

    it("does not honour signatures from a different driver instance", () => {
      const a = new LocalStorageDriver(makeConfig());
      const b = new LocalStorageDriver(makeConfig());
      const exp = Date.now() + 60_000;

      expect(b.verify("key-a", exp, a.sign("key-a", exp))).toBe(false);
    });
  });

  describe("path containment", () => {
    it.each([
      ["parent traversal", "../escaped"],
      ["deep traversal", "users/../../escaped"],
      ["absolute-looking key", "/etc/passwd/../../escaped"],
    ])("refuses to read outside the storage root via %s", async (_label, key) => {
      const driver = new LocalStorageDriver(makeConfig());
      await expect(driver.headObject(key)).rejects.toThrow(/outside storage root/);
    });

    it("refuses to write outside the storage root", async () => {
      const driver = new LocalStorageDriver(makeConfig());
      await expect(driver.putObject("../escaped", Buffer.from("x"))).rejects.toThrow(
        /outside storage root/
      );
    });
  });
});
