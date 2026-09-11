import { describe, expect, it, vi } from "vitest";

import { canonicalRequest, generateDeviceKeyPair, signRequest, signedHeaders } from "./protocol.js";
import {
  PROTOCOL_TEST_PRIVATE_KEY,
  PROTOCOL_VECTORS,
} from "./protocolVectors.js";

/**
 * The control plane asserts against this same vector file. If either side
 * changes how the canonical string is built, exactly one of these suites goes
 * red — which is the point, since the two are separate deployables.
 */
describe("wire-format contract", () => {
  it.each(PROTOCOL_VECTORS)(
    "builds the agreed canonical string for $method $path",
    (vector) => {
      expect(
        canonicalRequest({
          method: vector.method,
          path: vector.path,
          timestamp: vector.timestamp,
          body: vector.body,
        })
      ).toBe(vector.canonical);
    }
  );

  it.each(PROTOCOL_VECTORS)(
    "reproduces the agreed signature for $method $path",
    (vector) => {
      expect(signRequest(PROTOCOL_TEST_PRIVATE_KEY, vector.canonical)).toBe(
        vector.signature
      );
    }
  );
});

describe("signedHeaders", () => {
  it("signs the path and body it is given", () => {
    const keys = generateDeviceKeyPair();
    const body = JSON.stringify({ usedBytes: 1 });

    const headers = signedHeaders({
      deviceId: "device-1",
      privateKey: keys.privateKey,
      method: "POST",
      path: "/agent/heartbeat",
      body,
      now: 1_757_000_000_000,
    });

    expect(headers["X-Device-Id"]).toBe("device-1");
    expect(headers["X-Device-Timestamp"]).toBe("1757000000");
    expect(headers["X-Device-Signature"]).toBe(
      signRequest(
        keys.privateKey,
        canonicalRequest({
          method: "POST",
          path: "/agent/heartbeat",
          timestamp: "1757000000",
          body,
        })
      )
    );
  });

  it("emits seconds, not milliseconds", () => {
    const keys = generateDeviceKeyPair();

    const headers = signedHeaders({
      deviceId: "d",
      privateKey: keys.privateKey,
      method: "POST",
      path: "/agent/heartbeat",
      body: "{}",
      now: 1_757_000_000_999,
    });

    expect(headers["X-Device-Timestamp"]).toBe("1757000000");
  });

  it("keeps automatic calls unique within one second", () => {
    const keys = generateDeviceKeyPair();
    const input = {
      deviceId: "automatic-retry-device",
      privateKey: keys.privateKey,
      method: "POST",
      path: "/agent/heartbeat",
      body: "{}",
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_757_000_000_000));
    try {
      const first = signedHeaders(input);
      vi.advanceTimersByTime(1);
      const second = signedHeaders(input);

      expect(second["X-Device-Timestamp"]).not.toBe(first["X-Device-Timestamp"]);
      expect(second["X-Device-Signature"]).not.toBe(first["X-Device-Signature"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
