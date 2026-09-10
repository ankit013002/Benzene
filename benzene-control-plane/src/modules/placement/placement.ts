/**
 * The placement engine: given a set of candidate devices, decide which should
 * hold an object.
 *
 * Kept as a pure function over plain data, separate from any database access,
 * because this is the decision the whole product rests on — "where should this
 * data live so the user never has to think about it" — and it needs to be
 * exhaustively testable without standing up a vault.
 *
 * Follows architecture §23's algorithm. §24's weighted score (uptime,
 * reliability, network, battery) comes later; the inputs are shaped so that
 * ranking can be swapped without changing callers.
 */

export interface PlacementCandidate {
  deviceId: string;
  /** Only online devices can receive bytes right now. */
  online: boolean;
  /** Devices being retired must not be given new data. */
  draining: boolean;
  allocatedBytes: number;
  usedBytes: number;
  /** Total replicas this device already holds, used to spread load. */
  replicaCount: number;
  /** Whether a browser can reach this device for direct transfer. */
  reachable?: boolean;
}

export interface PlacementRequest {
  sizeBytes: number;
  /** How many distinct devices should end up holding this object. */
  desiredReplicas: number;
  /** Devices already holding it, which must not be chosen again (§22). */
  existingDeviceIds?: string[];
}

export type PlacementShortfallReason =
  | "no_devices"
  | "none_online"
  | "insufficient_capacity"
  | "unreachable_devices";

export interface PlacementPlan {
  /** Devices selected, best first. May be shorter than `desiredReplicas`. */
  deviceIds: string[];
  desiredReplicas: number;
  /** True when the vault cannot currently satisfy the policy. */
  shortfall: boolean;
  reason?: PlacementShortfallReason;
}

function freeBytes(candidate: PlacementCandidate): number {
  return Math.max(0, candidate.allocatedBytes - candidate.usedBytes);
}

/** Free space as a fraction, so a large full disk loses to a small empty one. */
function freeFraction(candidate: PlacementCandidate): number {
  if (candidate.allocatedBytes <= 0) return 0;
  return freeBytes(candidate) / candidate.allocatedBytes;
}

/**
 * Ranks candidates: emptiest first by proportion, then fewest replicas held,
 * then device id so the order is deterministic.
 *
 * Proportional rather than absolute free space keeps a single large device from
 * absorbing everything and becoming a de facto single point of failure.
 */
export function rankCandidates(
  candidates: PlacementCandidate[]
): PlacementCandidate[] {
  return [...candidates].sort((a, b) => {
    const byFraction = freeFraction(b) - freeFraction(a);
    if (Math.abs(byFraction) > Number.EPSILON) return byFraction;

    const byLoad = a.replicaCount - b.replicaCount;
    if (byLoad !== 0) return byLoad;

    return a.deviceId.localeCompare(b.deviceId);
  });
}

/**
 * Chooses devices for one object.
 *
 * Returns a shortfall rather than throwing when the vault cannot satisfy the
 * policy: placing one copy of a two-copy file is strictly better than refusing
 * the upload, and the protection status then reports it as degraded so repair
 * can finish the job when capacity appears.
 */
export function planPlacement(
  candidates: PlacementCandidate[],
  request: PlacementRequest,
  options: { requireReachable?: boolean } = {}
): PlacementPlan {
  const desired = Math.max(1, Math.floor(request.desiredReplicas));
  const excluded = new Set(request.existingDeviceIds ?? []);

  if (candidates.length === 0) {
    return { deviceIds: [], desiredReplicas: desired, shortfall: true, reason: "no_devices" };
  }

  const eligible = candidates.filter(
    (candidate) =>
      candidate.online &&
      !candidate.draining &&
      (!options.requireReachable || candidate.reachable !== false) &&
      !excluded.has(candidate.deviceId) &&
      freeBytes(candidate) >= request.sizeBytes
  );

  const anyOnline = candidates.some(
    (c) =>
      c.online &&
      !c.draining &&
      (!options.requireReachable || c.reachable !== false)
  );
  const anyUnreachableOnline =
    options.requireReachable &&
    candidates.some((c) => c.online && !c.draining && c.reachable === false);
  const chosen = rankCandidates(eligible)
    .slice(0, desired)
    .map((candidate) => candidate.deviceId);

  // Already-held copies count toward the policy; only the remainder is placed.
  const satisfied = chosen.length + excluded.size;
  const shortfall = satisfied < desired;

  const plan: PlacementPlan = {
    deviceIds: chosen,
    desiredReplicas: desired,
    shortfall,
  };

  if (shortfall) {
    plan.reason = !anyOnline
      ? anyUnreachableOnline
        ? "unreachable_devices"
        : "none_online"
      : "insufficient_capacity";
  }
  return plan;
}

export type ProtectionState = "healthy" | "degraded" | "at_risk" | "unprotected";

/**
 * Translates replica counts into the status a user sees (product §23).
 *
 * `at_risk` is deliberately distinct from `degraded`: degraded means redundancy
 * is below target but a copy survives, while at_risk means exactly one copy
 * remains and the next failure loses the data.
 */
export function protectionState(input: {
  desiredReplicas: number;
  healthyReplicas: number;
}): ProtectionState {
  if (input.healthyReplicas <= 0) return "unprotected";
  if (input.healthyReplicas >= input.desiredReplicas) return "healthy";
  return input.healthyReplicas === 1 ? "at_risk" : "degraded";
}

/**
 * Whether a single-copy policy leaves data unrecoverable.
 *
 * Architecture §17 offers replication factor 1 as "Maximum Capacity". That is a
 * real data-loss footgun in a product sold as a private cloud: one dead drive
 * and those files are gone permanently. The engine still honours it — it is the
 * user's storage — but flags it so the UI can say so plainly rather than
 * presenting it as an equivalent choice.
 */
export function isSingleCopyPolicy(desiredReplicas: number): boolean {
  return desiredReplicas <= 1;
}
