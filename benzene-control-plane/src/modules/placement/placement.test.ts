import { describe, expect, it } from "vitest";

import {
  isSingleCopyPolicy,
  availabilityState,
  planPlacement,
  protectionState,
  rankCandidates,
  type PlacementCandidate,
} from "./placement.js";

const GB = 1024 * 1024 * 1024;

function device(
  id: string,
  overrides: Partial<PlacementCandidate> = {}
): PlacementCandidate {
  return {
    deviceId: id,
    online: true,
    draining: false,
    allocatedBytes: 100 * GB,
    usedBytes: 0,
    replicaCount: 0,
    ...overrides,
  };
}

describe("ranking", () => {
  it("prefers the device with the largest proportion of free space", () => {
    const ranked = rankCandidates([
      device("full", { allocatedBytes: 100 * GB, usedBytes: 90 * GB }),
      device("empty", { allocatedBytes: 100 * GB, usedBytes: 10 * GB }),
    ]);

    expect(ranked.map((d) => d.deviceId)).toEqual(["empty", "full"]);
  });

  // Absolute free space would let one big disk absorb everything and quietly
  // become a single point of failure.
  it("ranks by proportion, not absolute free bytes", () => {
    const ranked = rankCandidates([
      // 500 GB free, but 90% full.
      device("big-but-full", { allocatedBytes: 5000 * GB, usedBytes: 4500 * GB }),
      // Only 90 GB free, but 90% empty.
      device("small-but-empty", { allocatedBytes: 100 * GB, usedBytes: 10 * GB }),
    ]);

    expect(ranked[0]?.deviceId).toBe("small-but-empty");
  });

  it("breaks ties on how many replicas a device already holds", () => {
    const ranked = rankCandidates([
      device("busy", { replicaCount: 50 }),
      device("idle", { replicaCount: 2 }),
    ]);

    expect(ranked.map((d) => d.deviceId)).toEqual(["idle", "busy"]);
  });

  it("is deterministic for otherwise identical devices", () => {
    const candidates = [device("b"), device("a"), device("c")];

    expect(rankCandidates(candidates).map((d) => d.deviceId)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const candidates = [device("z"), device("a")];
    rankCandidates(candidates);

    expect(candidates.map((d) => d.deviceId)).toEqual(["z", "a"]);
  });

  it("treats a device with no allocation as having no free space", () => {
    const ranked = rankCandidates([
      device("unallocated", { allocatedBytes: 0, usedBytes: 0 }),
      device("normal", { usedBytes: 99 * GB }),
    ]);

    expect(ranked[0]?.deviceId).toBe("normal");
  });
});

describe("choosing devices", () => {
  it("places one copy on the emptiest device", () => {
    const plan = planPlacement(
      [device("a", { usedBytes: 50 * GB }), device("b", { usedBytes: 10 * GB })],
      { sizeBytes: GB, desiredReplicas: 1 }
    );

    expect(plan.deviceIds).toEqual(["b"]);
    expect(plan.shortfall).toBe(false);
  });

  // Architecture §22: replicas must never share a failure domain.
  it("spreads replicas across distinct devices", () => {
    const plan = planPlacement([device("a"), device("b"), device("c")], {
      sizeBytes: GB,
      desiredReplicas: 3,
    });

    expect(new Set(plan.deviceIds).size).toBe(3);
  });

  it("never chooses a device that already holds the object", () => {
    const plan = planPlacement([device("a"), device("b")], {
      sizeBytes: GB,
      desiredReplicas: 2,
      existingDeviceIds: ["a"],
    });

    expect(plan.deviceIds).toEqual(["b"]);
    expect(plan.shortfall).toBe(false);
  });

  it("counts copies already held toward the policy", () => {
    const plan = planPlacement([device("c")], {
      sizeBytes: GB,
      desiredReplicas: 2,
      existingDeviceIds: ["a"],
    });

    // One existing plus one new satisfies a two-copy policy.
    expect(plan.deviceIds).toEqual(["c"]);
    expect(plan.shortfall).toBe(false);
  });

  it.each([
    ["offline", { online: false }],
    ["draining", { draining: true }],
  ])("skips a device that is %s", (_label, state) => {
    const plan = planPlacement([device("bad", state), device("good")], {
      sizeBytes: GB,
      desiredReplicas: 1,
    });

    expect(plan.deviceIds).toEqual(["good"]);
  });

  it("skips a device without room for the object", () => {
    const plan = planPlacement(
      [
        device("tight", { allocatedBytes: 10 * GB, usedBytes: 9.5 * GB }),
        device("roomy"),
      ],
      { sizeBytes: GB, desiredReplicas: 1 }
    );

    expect(plan.deviceIds).toEqual(["roomy"]);
  });

  it("accepts a device with exactly enough room", () => {
    const plan = planPlacement(
      [device("exact", { allocatedBytes: 10 * GB, usedBytes: 9 * GB })],
      { sizeBytes: GB, desiredReplicas: 1 }
    );

    expect(plan.deviceIds).toEqual(["exact"]);
  });
});

describe("shortfall", () => {
  // Placing one copy of a two-copy file beats refusing the upload; protection
  // then reports it degraded so repair can finish when capacity appears.
  it("places what it can rather than refusing outright", () => {
    const plan = planPlacement([device("only")], { sizeBytes: GB, desiredReplicas: 3 });

    expect(plan.deviceIds).toEqual(["only"]);
    expect(plan.shortfall).toBe(true);
    expect(plan.reason).toBe("insufficient_capacity");
  });

  it("reports when the vault has no devices at all", () => {
    const plan = planPlacement([], { sizeBytes: GB, desiredReplicas: 1 });

    expect(plan).toMatchObject({ deviceIds: [], shortfall: true, reason: "no_devices" });
  });

  it("distinguishes everything being offline from being full", () => {
    const plan = planPlacement([device("a", { online: false })], {
      sizeBytes: GB,
      desiredReplicas: 1,
    });

    expect(plan.reason).toBe("none_online");
  });

  it("reports insufficient capacity when devices are online but full", () => {
    const plan = planPlacement(
      [device("a", { allocatedBytes: GB, usedBytes: GB })],
      { sizeBytes: 10 * GB, desiredReplicas: 1 }
    );

    expect(plan.reason).toBe("insufficient_capacity");
  });

  it("treats a zero or negative replica request as one copy", () => {
    const plan = planPlacement([device("a")], { sizeBytes: GB, desiredReplicas: 0 });

    expect(plan.desiredReplicas).toBe(1);
    expect(plan.deviceIds).toEqual(["a"]);
  });
});

describe("protection status", () => {
  it.each([
    ["healthy when at target", 2, 2, "healthy"],
    ["healthy when above target", 2, 3, "healthy"],
    ["degraded when below target but redundant", 3, 2, "degraded"],
    ["at risk on the last copy", 2, 1, "at_risk"],
    ["unprotected with no copies", 2, 0, "unprotected"],
  ] as const)("is %s", (_label, desired, healthy, expected) => {
    expect(
      protectionState({ desiredReplicas: desired, healthyReplicas: healthy })
    ).toBe(expected);
  });

  // A single-copy policy is "healthy" by its own definition, but the next
  // failure still loses the data — which is why the UI needs the distinction.
  it("calls a satisfied single-copy policy healthy", () => {
    expect(protectionState({ desiredReplicas: 1, healthyReplicas: 1 })).toBe("healthy");
    expect(isSingleCopyPolicy(1)).toBe(true);
  });

  it("does not flag a two-copy policy as single copy", () => {
    expect(isSingleCopyPolicy(2)).toBe(false);
  });
});

describe("availability status", () => {
  it.each([
    ["available with one reachable copy", 2, 1, 1, 0, "available"],
    ["waiting when durable copies are all offline", 2, 2, 0, 0, "waiting_for_device"],
    ["restoring when a reachable copy and repair exist", 2, 1, 1, 1, "restoring_protection"],
    ["unavailable with no durable copies", 2, 0, 0, 1, "unavailable"],
  ] as const)(
    "is %s",
    (_label, desired, healthy, reachable, placing, expected) => {
      expect(
        availabilityState({
          desiredReplicas: desired,
          healthyReplicas: healthy,
          reachableHealthyReplicas: reachable,
          placingReplicas: placing,
        })
      ).toBe(expected);
    }
  );

  it("does not call an object available just because protection is satisfied", () => {
    expect(
      availabilityState({
        desiredReplicas: 2,
        healthyReplicas: 2,
        reachableHealthyReplicas: 0,
        placingReplicas: 0,
      })
    ).toBe("waiting_for_device");
  });
});
