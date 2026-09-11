import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config/env.js";
import { S3StorageDriver, contentDisposition } from "./s3.driver.js";

function makeConfig(): AppConfig {
  return {
    port: 5000,
    mongooseUri: "mongodb://localhost/test",
    storageDriver: "s3",
    maxUploadBytes: 5 * 1024 * 1024 * 1024,
    presignTtlSeconds: 900,
    enrollmentCodeTtlSeconds: 600,
    enrollmentRateLimitMax: 10,
    enrollmentRateLimitWindowSeconds: 60,
    s3: {
      bucket: "benzene-test-bucket",
      region: "us-east-1",
      endpoint: undefined,
      forcePathStyle: false,
    },
    local: { rootDir: "uploads", publicBaseUrl: "http://localhost:5000/local-objects" },
  };
}

/** Static credentials keep presigning fully offline — no STS call is made. */
function makeClient(sendImpl?: (command: unknown) => Promise<unknown>): S3Client {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
  });
  if (sendImpl) {
    vi.spyOn(client, "send").mockImplementation(sendImpl as never);
  }
  return client;
}

describe("S3StorageDriver", () => {
  it("presigns an upload against the configured bucket and key", async () => {
    const driver = new S3StorageDriver(makeConfig(), makeClient());

    const target = await driver.createUploadTarget({
      key: "users/u1/nodes/n1/v1",
      contentType: "image/png",
      contentLength: 2048,
    });

    const url = new URL(target.url);
    expect(url.hostname).toContain("benzene-test-bucket");
    expect(url.pathname).toBe("/users/u1/nodes/n1/v1");
    expect(target.method).toBe("PUT");
    expect(target.headers).toEqual({
      "Content-Type": "image/png",
      "Content-Length": "2048",
    });
  });

  it("signs content-type and content-length so they cannot be swapped in transit", async () => {
    const driver = new S3StorageDriver(makeConfig(), makeClient());

    const target = await driver.createUploadTarget({
      key: "k",
      contentType: "image/png",
      contentLength: 10,
    });

    const signedHeaders = new URL(target.url).searchParams.get("X-Amz-SignedHeaders");
    expect(signedHeaders).toContain("content-type");
    expect(signedHeaders).toContain("content-length");
  });

  it("expires the upload target in step with the configured TTL", async () => {
    const driver = new S3StorageDriver(makeConfig(), makeClient());
    const before = Date.now();

    const target = await driver.createUploadTarget({
      key: "k",
      contentType: "text/plain",
      contentLength: 1,
    });

    const expiresAt = new Date(target.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 900_000);
    expect(new URL(target.url).searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("asks S3 to send the original filename back on download", async () => {
    const driver = new S3StorageDriver(makeConfig(), makeClient());

    const url = await driver.createDownloadUrl({ key: "k", filename: "report final.pdf" });

    const disposition = new URL(url).searchParams.get("response-content-disposition");
    expect(disposition).toBe(contentDisposition("report final.pdf"));
  });

  it("maps a HeadObject response onto the storage shape and strips ETag quotes", async () => {
    const driver = new S3StorageDriver(
      makeConfig(),
      makeClient(async () => ({
        ContentLength: 42,
        ContentType: "text/plain",
        ETag: '"abc123"',
      }))
    );

    await expect(driver.headObject("k")).resolves.toEqual({
      bytes: 42,
      contentType: "text/plain",
      etag: "abc123",
    });
  });

  it.each([
    ["NotFound", { name: "NotFound" }],
    ["NoSuchKey", { name: "NoSuchKey" }],
    ["a 404 status", { name: "Whatever", $metadata: { httpStatusCode: 404 } }],
  ])("returns null when HeadObject fails with %s", async (_label, error) => {
    const driver = new S3StorageDriver(
      makeConfig(),
      makeClient(async () => {
        throw Object.assign(new Error("missing"), error);
      })
    );

    await expect(driver.headObject("k")).resolves.toBeNull();
  });

  it("propagates non-404 HeadObject failures instead of reporting absence", async () => {
    const driver = new S3StorageDriver(
      makeConfig(),
      makeClient(async () => {
        throw Object.assign(new Error("denied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        });
      })
    );

    await expect(driver.headObject("k")).rejects.toThrow(/denied/);
  });

  it("issues one DeleteObjects call per 1000 keys", async () => {
    const sent: unknown[] = [];
    const driver = new S3StorageDriver(
      makeConfig(),
      makeClient(async (command) => {
        sent.push(command);
        return {};
      })
    );

    await driver.deleteObjects(Array.from({ length: 2500 }, (_, i) => `k${i}`));

    expect(sent).toHaveLength(3);
  });

  it("does not call S3 when there is nothing to delete", async () => {
    const sent: unknown[] = [];
    const driver = new S3StorageDriver(
      makeConfig(),
      makeClient(async (command) => {
        sent.push(command);
        return {};
      })
    );

    await driver.deleteObjects([]);

    expect(sent).toHaveLength(0);
  });

  it("targets the configured bucket when heading an object", async () => {
    const sent: HeadObjectCommand[] = [];
    const driver = new S3StorageDriver(
      makeConfig(),
      makeClient(async (command) => {
        sent.push(command as HeadObjectCommand);
        return { ContentLength: 1 };
      })
    );

    await driver.headObject("some/key");

    expect(sent[0]?.input).toMatchObject({
      Bucket: "benzene-test-bucket",
      Key: "some/key",
    });
  });
});

describe("contentDisposition", () => {
  it("keeps a plain ASCII filename readable", () => {
    expect(contentDisposition("report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`
    );
  });

  it("supplies an ASCII fallback alongside the encoded original", () => {
    const header = contentDisposition("отчёт.pdf");

    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("отчёт.pdf")}`);
    expect(header).toMatch(/filename="_+\.pdf"/);
  });

  it("neutralises quotes and backslashes that would break the header", () => {
    const header = contentDisposition('a"b\\c.txt');

    // Exactly one quoted section: the injected quote must not open a second.
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header).toContain('filename="a_b_c.txt"');
  });
});
