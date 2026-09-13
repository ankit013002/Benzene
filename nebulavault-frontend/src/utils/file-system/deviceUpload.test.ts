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
  const scheduled = new Map<number, () => void>();
  let nextTimerId = 0;
  const windowMock = {
    setTimeout: (callback: () => void, _delay: number): number => {
      const timerId = ++nextTimerId;
      scheduled.set(timerId, callback);
      return timerId;
    },
    clearTimeout: (timerId: number): void => {
      scheduled.delete(timerId);
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
    runScheduled: () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      callbacks.forEach((callback) => callback());
    },
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
    assert.equal(calls[1]?.[0], "http://sleeping.lan:7070/objects/object-hash");
    assert.deepEqual(calls[1]?.[1]?.headers, { "X-Transfer-Grant": "grant-1" });
    assert.ok(calls[1]?.[1]?.signal instanceof AbortSignal);
    assert.equal(calls[2]?.[0], "http://healthy.lan:7070/objects/object-hash");
    assert.deepEqual(calls[2]?.[1]?.headers, { "X-Transfer-Grant": "grant-2" });
    assert.ok(calls[2]?.[1]?.signal instanceof AbortSignal);
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

  test("aborts a hanging holder and falls back without waiting for the timeout", async () => {
    const calls: FetchCall[] = [];
    let firstHolderStarted: () => void = () => undefined;
    const firstHolderReady = new Promise<void>((resolve) => {
      firstHolderStarted = resolve;
    });
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({ data: { targets: [target("sleeping", "grant-1"), target("healthy", "grant-2")] } }),
          { status: 200 }
        );
      }
      if (input === "http://sleeping.lan:7070/objects/object-hash") {
        firstHolderStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return new Response(new Blob(["downloaded after fallback"]), { status: 200 });
    };
    setGlobal("fetch", fetchMock);
    const { anchor, state, runScheduled } = installDownloadDom();

    const download = downloadFromDevices("object-hash", "report.txt");
    await firstHolderReady;
    runScheduled();
    await download;

    assert.equal(calls.length, 3);
    assert.equal(calls[1]?.[1]?.signal?.aborted, true);
    assert.equal(calls[2]?.[0], "http://healthy.lan:7070/objects/object-hash");
    assert.equal(anchor.download, "report.txt");
    assert.equal(state.clicks, 1);
    assert.equal(state.removals, 1);
  });
});
