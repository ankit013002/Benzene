import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { downloadFromDevices } from "./deviceUpload";

type FetchCall = [RequestInfo | URL, RequestInit | undefined];

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalURL = globalThis.URL;
const originalWindow = globalThis.window;

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobals(): void {
  setGlobal("fetch", originalFetch);
  setGlobal("document", originalDocument);
  setGlobal("URL", originalURL);
  setGlobal("window", originalWindow);
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

const target = (deviceId: string, grant: string) => ({
  deviceId,
  deviceName: deviceId,
  url: `http://${deviceId}.lan:7070/objects/object-hash`,
  grant,
  expiresAt: "2099-01-01T00:00:00.000Z",
});

function installDownloadDom() {
  const state = { clicks: 0, removals: 0 };
  const anchor = {
    href: "",
    download: "",
    rel: "",
    click: () => {
      state.clicks += 1;
    },
    remove: () => {
      state.removals += 1;
    },
  };
  const documentMock = {
    createElement: (tagName: string) => {
      assert.equal(tagName, "a");
      return anchor;
    },
    body: { appendChild: (_element: unknown) => undefined },
  };
  const revoked: string[] = [];
  const created: string[] = [];
  const createObjectURL = (blob: Blob): string => {
    assert.ok(blob instanceof Blob);
    created.push("blob:download");
    return "blob:download";
  };
  const revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };
  const scheduled: Array<() => void> = [];
  const windowMock = {
    setTimeout: (callback: () => void, _delay: number): number => {
      scheduled.push(callback);
      return scheduled.length;
    },
  };
  setGlobal("document", documentMock);
  setGlobal("URL", { createObjectURL, revokeObjectURL });
  setGlobal("window", windowMock);
  return {
    anchor,
    created,
    revoked,
    state,
    runScheduled: () => scheduled.splice(0).forEach((callback) => callback()),
  };
}

afterEach(restoreGlobals);

describe("downloadFromDevices", () => {
  test("falls back from a failing holder to a healthy holder", async () => {
    const { calls, fetchMock } = createFetchMock([
      new Response(JSON.stringify({ data: { targets: [target("sleeping", "grant-1"), target("healthy", "grant-2")] } }), { status: 200 }),
      new TypeError("network unavailable"),
      new Response(new Blob(["downloaded bytes"]), { status: 200 }),
    ]);
    setGlobal("fetch", fetchMock);
    const { anchor, state } = installDownloadDom();

    await downloadFromDevices("object/hash", "report.txt");

    assert.equal(calls[0]?.[0], "/api/placement/download-targets/object%2Fhash");
    assert.deepEqual(calls[1], [
      "http://sleeping.lan:7070/objects/object-hash",
      { headers: { "X-Transfer-Grant": "grant-1" } },
    ]);
    assert.deepEqual(calls[2], [
      "http://healthy.lan:7070/objects/object-hash",
      { headers: { "X-Transfer-Grant": "grant-2" } },
    ]);
    assert.equal(anchor.download, "report.txt");
    assert.equal(state.clicks, 1);
    assert.equal(state.removals, 1);
  });

  test("uses DOM properties for an untrusted filename and releases the object URL later", async () => {
    const { fetchMock } = createFetchMock([
      new Response(JSON.stringify({ data: { targets: [target("healthy", "grant")] } }), { status: 200 }),
      new Response(new Blob(["safe bytes"]), { status: 200 }),
    ]);
    setGlobal("fetch", fetchMock);
    const { anchor, created, revoked, state, runScheduled } = installDownloadDom();
    const filename = '"><img src=x onerror="alert(1)">.txt';

    await downloadFromDevices("object-hash", filename);

    assert.equal(anchor.download, filename);
    assert.equal(anchor.href, "blob:download");
    assert.equal(state.clicks, 1);
    assert.equal(state.removals, 1);
    assert.equal(created.length, 1);
    assert.deepEqual(revoked, []);
    runScheduled();
    assert.deepEqual(revoked, ["blob:download"]);
  });
});
