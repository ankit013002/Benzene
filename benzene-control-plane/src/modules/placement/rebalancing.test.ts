import { describe, expect, it } from "vitest";

import { planRebalance, type RebalanceDevice } from "./rebalancing.js";

const GB = 1024 ** 3;

function device(
  deviceId: string,
  occupiedGb: number,
  overrides: Partial<RebalanceDevice> = {}
): RebalanceDevice {
  return {
    deviceId,
    allocatedBytes: 100 * GB,
    occupiedBytes: occupiedGb * GB,
    online: true,
    reachable: true,
    draining: false,
    ...overrides,
  };
}

describe("whole-file rebalance planning", () => {
  it("selects the move that most reduces proportional utilization skew", () => {
    const plan = planRebalance(
      [device("full", 90), device("empty", 10)],
      [
        { objectHash: "small", sizeBytes: 5 * GB, healthyDeviceIds: ["full"] },
        { objectHash: "best", sizeBytes: 40 * GB, healthyDeviceIds: ["full"] },
      ],
      0.1
    );

    expect(plan).toMatchObject({
      objectHash: "best",
      sourceDeviceId: "full",
      targetDeviceId: "empty",
      utilizationGapBefore: 0.8,
      utilizationGapAfter: 0,
    });
  });

  it("does not move an object onto a device that already holds it", () => {
    expect(
      planRebalance(
        [device("full", 90), device("empty", 10)],
        [{ objectHash: "shared", sizeBytes: 20 * GB, healthyDeviceIds: ["full", "empty"] }],
        0.1
      )
    ).toBeNull();
  });

  it("does not move when capacity, reachability or minimum skew rejects it", () => {
    const object = [{ objectHash: "object", sizeBytes: 20 * GB, healthyDeviceIds: ["full"] }];

    expect(
      planRebalance(
        [device("full", 60), device("empty", 55)],
        object,
        0.1
      )
    ).toBeNull();
    expect(
      planRebalance(
        [device("full", 90), device("empty", 90, { allocatedBytes: 100 * GB })],
        object,
        0.1
      )
    ).toBeNull();
    expect(
      planRebalance(
        [device("full", 90), device("empty", 10, { reachable: false })],
        object,
        0.1
      )
    ).toBeNull();
  });
});
