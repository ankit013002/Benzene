/**
 * Pure whole-file rebalance planning.
 *
 * The first implementation intentionally uses only the architecture §23
 * signals already trusted by placement: proportional free space and distinct
 * devices. Reliability, power and network scoring remain later refinements.
 */

export interface RebalanceDevice {
  deviceId: string;
  allocatedBytes: number;
  occupiedBytes: number;
  online: boolean;
  reachable: boolean;
  draining: boolean;
}

export interface RebalanceObject {
  objectHash: string;
  sizeBytes: number;
  healthyDeviceIds: string[];
}

export interface RebalancePlan {
  objectHash: string;
  sizeBytes: number;
  sourceDeviceId: string;
  targetDeviceId: string;
  utilizationGapBefore: number;
  utilizationGapAfter: number;
}

function utilization(device: RebalanceDevice, occupiedBytes = device.occupiedBytes): number {
  if (device.allocatedBytes <= 0) return 1;
  return Math.max(0, occupiedBytes) / device.allocatedBytes;
}

function comparePlans(a: RebalancePlan, b: RebalancePlan): number {
  const improvementA = a.utilizationGapBefore - a.utilizationGapAfter;
  const improvementB = b.utilizationGapBefore - b.utilizationGapAfter;
  if (Math.abs(improvementA - improvementB) > Number.EPSILON) {
    return improvementB - improvementA;
  }
  const source = a.sourceDeviceId.localeCompare(b.sourceDeviceId);
  if (source !== 0) return source;
  const target = a.targetDeviceId.localeCompare(b.targetDeviceId);
  if (target !== 0) return target;
  return a.objectHash.localeCompare(b.objectHash);
}

/** Selects one move that materially reduces proportional utilization skew. */
export function planRebalance(
  devices: RebalanceDevice[],
  objects: RebalanceObject[],
  minimumUsageDelta: number
): RebalancePlan | null {
  const eligible = devices.filter(
    (device) =>
      device.online &&
      device.reachable &&
      !device.draining &&
      device.allocatedBytes > 0
  );
  const plans: RebalancePlan[] = [];

  for (const source of eligible) {
    for (const target of eligible) {
      if (source.deviceId === target.deviceId) continue;
      const gapBefore = utilization(source) - utilization(target);
      if (gapBefore + Number.EPSILON < minimumUsageDelta) continue;

      for (const object of objects) {
        if (
          object.sizeBytes <= 0 ||
          !object.healthyDeviceIds.includes(source.deviceId) ||
          object.healthyDeviceIds.includes(target.deviceId) ||
          target.allocatedBytes - target.occupiedBytes < object.sizeBytes
        ) {
          continue;
        }

        const gapAfter = Math.abs(
          utilization(source, source.occupiedBytes - object.sizeBytes) -
            utilization(target, target.occupiedBytes + object.sizeBytes)
        );
        if (gapAfter + Number.EPSILON >= Math.abs(gapBefore)) continue;

        plans.push({
          objectHash: object.objectHash,
          sizeBytes: object.sizeBytes,
          sourceDeviceId: source.deviceId,
          targetDeviceId: target.deviceId,
          utilizationGapBefore: Math.abs(gapBefore),
          utilizationGapAfter: gapAfter,
        });
      }
    }
  }

  return plans.sort(comparePlans)[0] ?? null;
}
