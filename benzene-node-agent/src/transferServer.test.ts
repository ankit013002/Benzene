import { createHash, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GRANT_TEST_PRIVATE_KEY, GRANT_TEST_PUBLIC_KEY } from "./grantVectors.js";
import { ObjectStore } from "./store.js";
import type { TransferOperation } from "./transferGrant.js";
import { createTransferServer } from "./transferServer.js";

const DEVICE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_DEVICE_ID = "22222222-2222-2222-2222-222222222222";
const FUTURE = 4_102_444_800; // 2100-01-01

let root: string;
let store: ObjectStore;
let app: Express;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function b64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints a grant exactly as the control plane would. */
function grantFor(
  objectHash: string,
  op: TransferOperation,
  overrides: { deviceId?: string; exp?: number } = {}
): string {
  const encoded = b64url(
    Buffer.from(
      JSON.stringify({
        v: 1,
        objectHash,
        deviceId: overrides.deviceId ?? DEVICE_ID,
        op,
        exp: overrides.exp ?? FUTURE,
      }),
      "utf8"
    )
  );
  const signature = sign(null, Buffer.from(encoded, "utf8"), {
    key: Buffer.from(GRANT_TEST_PRIVATE_KEY, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return `${encoded}.${b64url(signature)}`;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "benzene-transfer-"));
  store = new ObjectStore({ rootDir: root, allocatedBytes: 1024 });
  await store.load();
  app = createTransferServer({
    store,
    deviceId: DEVICE_ID,
    controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("authorisation", () => {
  // A node must not expose an unrestricted file server (§81).
  it.each([["GET"], ["PUT"], ["DELETE"]])("refuses %s with no grant", async (method) => {
    await request(app)
      [method.toLowerCase() as "get"](`/objects/${sha256("x")}`)
      .expect(401);
  });

  it("serves health without a grant, for local liveness checks", async () => {
    const res = await request(app).get("/health").expect(200);

    expect(res.body).toMatchObject({ status: "ok", service: "benzene-node-agent" });
  });

  it("allows the browser's narrowly scoped transfer preflight", async () => {
    const res = await request(app)
      .options(`/objects/${sha256("x")}`)
      .set("Origin", "https://app.example")
      .set("Access-Control-Request-Method", "PUT")
      .set("Access-Control-Request-Headers", "X-Transfer-Grant, Content-Type")
      .expect(204);

    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
    expect(res.headers["access-control-allow-headers"]).toContain("X-Transfer-Grant");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("reports possession after a successful upload", async () => {
    const reports: Array<{ objectHash: string; sizeBytes: number }> = [];
    app = createTransferServer({
      store,
      deviceId: DEVICE_ID,
      controlPlanePublicKey: GRANT_TEST_PUBLIC_KEY,
      reportPossession: async (report) => {
        reports.push(report);
      },
    });
    const body = "reported payload";
    const hash = sha256(body);

    await request(app)
      .put(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "put"))
      .set("Content-Type", "application/octet-stream")
      .send(body)
      .expect(201);

    expect(reports).toEqual([{ objectHash: hash, sizeBytes: body.length }]);
  });

  it("does not serve an object whose on-disk bytes have been corrupted", async () => {
    const body = "integrity payload";
    const hash = sha256(body);
    await store.put(Readable.from([Buffer.from(body)]));
    await writeFile(path.join(root, "objects", hash.slice(0, 2), hash), "corrupted");

    const res = await request(app)
      .get(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "get"))
      .expect(422);

    expect(res.body.code).toBe("INTEGRITY");
  });

  it("passes unexpected integrity-store errors to Express", async () => {
    const body = "store failure payload";
    const hash = sha256(body);
    await store.put(Readable.from([Buffer.from(body)]));
    const originalRead = store.read;
    store.read = () => {
      throw new Error("disk unavailable");
    };

    try {
      await request(app)
        .get(`/objects/${hash}`)
        .set("X-Transfer-Grant", grantFor(hash, "get"))
        .expect(500);
    } finally {
      store.read = originalRead;
    }
  });

  // The scoping a shared secret could not provide: this is why grants replaced
  // the per-process token.
  it("refuses a grant issued for a different object", async () => {
    const res = await request(app)
      .get(`/objects/${sha256("wanted")}`)
      .set("X-Transfer-Grant", grantFor(sha256("other"), "get"))
      .expect(401);

    expect(res.body.code).toBe("wrong_object");
  });

  it("refuses a grant issued for a different device", async () => {
    const hash = sha256("payload");
    const res = await request(app)
      .get(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "get", { deviceId: OTHER_DEVICE_ID }))
      .expect(401);

    expect(res.body.code).toBe("wrong_device");
  });

  // A read grant must not authorise a write.
  it("refuses a read grant used to upload", async () => {
    const hash = sha256("payload");
    const res = await request(app)
      .put(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "get"))
      .set("Content-Type", "application/octet-stream")
      .send("payload")
      .expect(401);

    expect(res.body.code).toBe("wrong_operation");
  });

  it("refuses an expired grant", async () => {
    const hash = sha256("payload");
    const res = await request(app)
      .get(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "get", { exp: 1 }))
      .expect(401);

    expect(res.body.code).toBe("expired");
  });

  it("refuses a forged grant", async () => {
    const hash = sha256("payload");
    await request(app)
      .get(`/objects/${hash}`)
      .set("X-Transfer-Grant", "bm90LWEtZ3JhbnQ.c2ln")
      .expect(401);
  });
});

describe("object transfer", () => {
  it("accepts an object and serves it back byte for byte", async () => {
    const body = "peer transferred payload";
    const hash = sha256(body);

    await request(app)
      .put(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "put"))
      .set("Content-Type", "application/octet-stream")
      .send(body)
      .expect(201);

    const res = await request(app)
      .get(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "get"))
      .expect(200);

    expect(res.body.toString()).toBe(body);
  });

  // The hash is in the URL, so a substituted transfer is caught on arrival.
  it("rejects bytes that do not match the hash in the URL", async () => {
    const hash = sha256("expected");

    await request(app)
      .put(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "put"))
      .set("Content-Type", "application/octet-stream")
      .send("something else entirely")
      .expect(422);

    expect(await store.list()).toEqual([]);
  });

  it("refuses an object that would exceed the allocation", async () => {
    const big = "x".repeat(2048);
    const hash = sha256(big);

    await request(app)
      .put(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "put"))
      .set("Content-Type", "application/octet-stream")
      .send(big)
      .expect(507);
  });

  it.each([
    ["not hex", "zzzz"],
    ["too short", "abc123"],
  ])("rejects an object path that is %s", async (_label, hash) => {
    await request(app)
      .get(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(sha256("x"), "get"))
      .expect(400);
  });

  it("reports an object it does not hold", async () => {
    const hash = sha256("absent");
    await request(app)
      .get(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "get"))
      .expect(404);
  });

  it("reports size and encryption mode without sending the body", async () => {
    await store.put(Readable.from([Buffer.from("metadata probe")]));
    const hash = sha256("metadata probe");

    const res = await request(app)
      .head(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "get"))
      .expect(200);

    expect(res.headers["content-length"]).toBe(String("metadata probe".length));
    expect(res.headers["x-object-encryption"]).toBe("none");
  });

  it("deletes an object on request", async () => {
    await store.put(Readable.from([Buffer.from("disposable")]));
    const hash = sha256("disposable");

    await request(app)
      .delete(`/objects/${hash}`)
      .set("X-Transfer-Grant", grantFor(hash, "delete"))
      .expect(204);

    expect(await store.has(hash)).toBe(false);
  });

  it("returns 404 for an unknown route", async () => {
    await request(app).get("/nope").expect(404);
  });
});
