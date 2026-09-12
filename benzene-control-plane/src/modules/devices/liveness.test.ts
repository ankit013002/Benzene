import { describe, expect, it } from "vitest";

import { deriveDeviceStatus } from "./liveness.js";

describe("device lifecycle classification", () => {
  const seenAt = 1_000_000;
  const offlineAfter = 120_000;
  const extendedAfter = 3_600_000;
  const lostAfter = 86_400_000;

  it.each([
    [offlineAfter, "online"],
    [offlineAfter + 1, "offline"],
    [extendedAfter, "offline"],
    [extendedAfter + 1, "extended_offline"],
    [lostAfter, "extended_offline"],
    [lostAfter + 1, "suspected_lost"],
  ])("classifies silence of %d ms as %s", (silenceMs, expected) => {
    expect(
      deriveDeviceStatus(
        "online",
        new Date(seenAt),
        offlineAfter,
        seenAt + silenceMs,
        extendedAfter,
        lostAfter
      )
    ).toBe(expected);
  });

  it("does not presume loss when that threshold is disabled", () => {
    expect(
      deriveDeviceStatus(
        "online",
        new Date(seenAt),
        offlineAfter,
        seenAt + lostAfter + 1,
        extendedAfter,
        Number.POSITIVE_INFINITY
      )
    ).toBe("extended_offline");
  });
});
