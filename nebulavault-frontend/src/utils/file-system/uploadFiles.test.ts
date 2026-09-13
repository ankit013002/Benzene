import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { FlatFile } from "@/types/FileFolderBuffer";
import { uploadFiles } from "./uploadFiles";

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

const originalFetch = globalThis.fetch;

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobals(): void {
  setGlobal("fetch", originalFetch);
}

function createFetchMock(responses: Array<Response | Error>) {
  const calls: FetchCall[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push([input, init]);
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call");
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, fetchMock };
}

const reservation = (placement: object) =>
  new Response(
    JSON.stringify({
      data: {
        nodeId: "legacy-node",
        versionId: "version-1",
        objectHash: "hash-1",
        placement,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const target = (deviceId: string, deviceName: string, grant: string) => ({
  deviceId,
  deviceName,
  url: `http://${deviceId}.lan:7070/objects/hash-1`,
  grant,
  expiresAt: "2099-01-01T00:00:00.000Z",
});

function fileEntry(contents: string, name = "notes.txt"): FlatFile {
  return { file: new File([contents], name, { type: "text/plain" }), path: name };
}

afterEach(restoreGlobals);

describe("uploadFiles device orchestration", () => {
  test("hashes the file before reserving it and roots the reservation path", async () => {
    const { calls, fetchMock } = createFetchMock([
      reservation({
        alreadyHeldBy: ["device-existing"],
        desiredReplicas: 1,
        targets: [],
        shortfall: false,
        singleCopy: true,
      }),
      new Response(JSON.stringify({ data: { committed: true } }), { status: 200 }),
    ]);
    setGlobal("fetch", fetchMock);

    const result = await uploadFiles("My Drive", [fileEntry("hello")], []);

    assert.deepEqual(result, { uploaded: 1, bytes: 5, issues: [] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], "/api/files/uploads/device");
    const request = calls[0]?.[1];
    assert.equal(request?.method, "POST");
    assert.deepEqual(JSON.parse(String(request?.body)), {
      name: "notes.txt",
      path: "My Drive/notes.txt",
      size: 5,
      contentType: "text/plain",
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });

  test("PUTs exact bytes to every Protected target with its scoped grant", async () => {
    const { calls, fetchMock } = createFetchMock([
      reservation({
        alreadyHeldBy: [],
        desiredReplicas: 2,
        targets: [target("device-a", "Desk", "grant-a"), target("device-b", "Laptop", "grant-b")],
        shortfall: false,
        singleCopy: false,
      }),
      new Response(null, { status: 201 }),
      new Response(null, { status: 201 }),
      new Response(JSON.stringify({ data: { committed: true } }), { status: 200 }),
    ]);
    setGlobal("fetch", fetchMock);

    const file = fileEntry("protected bytes");
    const result = await uploadFiles("Vault", [file], []);

    assert.deepEqual(result, { uploaded: 1, bytes: file.file.size, issues: [] });
    assert.equal(calls.length, 4);
    for (const [index, expected] of [
      [1, target("device-a", "Desk", "grant-a")],
      [2, target("device-b", "Laptop", "grant-b")],
    ] as const) {
      const [url, init] = calls[index] ?? [];
      assert.equal(url, expected.url);
      assert.equal(init?.method, "PUT");
      assert.deepEqual(init?.headers, {
        "X-Transfer-Grant": expected.grant,
        "Content-Type": "text/plain",
      });
      assert.equal(await new Response(init?.body).text(), "protected bytes");
    }
    assert.equal(calls[3]?.[0], "/api/files/uploads/device/complete");
  });

  test("does not complete when no device confirms possession and explains pending bytes", async () => {
    const { calls, fetchMock } = createFetchMock([
      reservation({
        alreadyHeldBy: [],
        desiredReplicas: 1,
        targets: [target("device-a", "Desk", "grant-a")],
        shortfall: false,
        reason: "none_online",
        singleCopy: true,
      }),
      new Response(JSON.stringify({ code: "POSSESSION_UNCONFIRMED" }), { status: 503 }),
    ]);
    setGlobal("fetch", fetchMock);

    const result = await uploadFiles("Vault", [fileEntry("pending")], []);

    assert.equal(result.uploaded, 0);
    assert.equal(result.bytes, 0);
    assert.ok(result.issues.includes("Desk: The device stored the file, but protection confirmation is pending. Retry this upload safely."));
    assert.ok(result.issues.includes("notes.txt is not confirmed on any device yet; retry this upload safely"));
    assert.equal(calls.length, 2);
    assert.equal(calls.some(([url]) => url === "/api/files/uploads/device/complete"), false);
  });

  test("reports reduced protection after completing with a placement shortfall", async () => {
    const { calls, fetchMock } = createFetchMock([
      reservation({
        alreadyHeldBy: [],
        desiredReplicas: 2,
        targets: [target("device-a", "Desk", "grant-a")],
        shortfall: true,
        singleCopy: false,
      }),
      new Response(null, { status: 201 }),
      new Response(null, { status: 200 }),
    ]);
    setGlobal("fetch", fetchMock);

    const result = await uploadFiles("Vault", [fileEntry("one copy")], []);

    assert.equal(result.uploaded, 1);
    assert.deepEqual(result.issues, ["notes.txt has reduced protection: stored on 1 of 2 devices"]);
    assert.equal(calls[2]?.[0], "/api/files/uploads/device/complete");
  });
});
