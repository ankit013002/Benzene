import {
  blockAccountDeletionPhase,
  claimNextAccountDeletionPhase,
  completeAccountDeletionPhase,
  type AccountDeletionCleanupPhase,
  type ClaimedAccountDeletionPhase,
} from "./account-deletion.service";

export type AccountDeletionPhaseHandler = (
  context: Pick<ClaimedAccountDeletionPhase, "requestId" | "credentialId" | "phase" | "attempt">,
) => Promise<void>;

export type AccountDeletionPhaseHandlers = Partial<
  Record<AccountDeletionCleanupPhase, AccountDeletionPhaseHandler>
>;

export type AccountDeletionWorkerResult =
  | { outcome: "idle" }
  | { outcome: "completed"; requestId: string; nextPhase: string }
  | { outcome: "lease_lost"; requestId: string; phase: AccountDeletionCleanupPhase }
  | { outcome: "blocked"; requestId: string; phase: AccountDeletionCleanupPhase };

/**
 * Executes one durable phase. Downstream actions must be idempotent because
 * their success can precede a process crash before the phase receipt commits.
 */
export async function runNextAccountDeletionPhase(
  handlers: AccountDeletionPhaseHandlers,
): Promise<AccountDeletionWorkerResult> {
  const claim = await claimNextAccountDeletionPhase();
  if (!claim) return { outcome: "idle" };

  const handler = handlers[claim.phase];
  if (!handler) {
    const blocked = await blockAccountDeletionPhase(claim, "phase_handler_unavailable");
    return {
      outcome: blocked ? "blocked" : "lease_lost",
      requestId: claim.requestId,
      phase: claim.phase,
    };
  }

  try {
    await handler({
      requestId: claim.requestId,
      credentialId: claim.credentialId,
      phase: claim.phase,
      attempt: claim.attempt,
    });
  } catch {
    const blocked = await blockAccountDeletionPhase(claim, "phase_execution_failed");
    return {
      outcome: blocked ? "blocked" : "lease_lost",
      requestId: claim.requestId,
      phase: claim.phase,
    };
  }

  try {
    const nextPhase = await completeAccountDeletionPhase(claim);
    return { outcome: "completed", requestId: claim.requestId, nextPhase };
  } catch (error) {
    if (error instanceof Error && error.name === "StaleAccountDeletionLeaseError") {
      return { outcome: "lease_lost", requestId: claim.requestId, phase: claim.phase };
    }
    throw error;
  }
}

/** Runs a bounded number of claims so a single invocation cannot monopolize the worker. */
export async function runAccountDeletionWorkerBatch(
  handlers: AccountDeletionPhaseHandlers,
  maximumPhases = 10,
): Promise<AccountDeletionWorkerResult[]> {
  if (!Number.isInteger(maximumPhases) || maximumPhases < 1 || maximumPhases > 100) {
    throw new RangeError("maximumPhases must be an integer from 1 through 100");
  }

  const results: AccountDeletionWorkerResult[] = [];
  for (let count = 0; count < maximumPhases; count += 1) {
    const result = await runNextAccountDeletionPhase(handlers);
    results.push(result);
    if (result.outcome !== "completed") break;
  }
  return results;
}
