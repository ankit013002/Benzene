import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  blockAccountDeletionPhase: vi.fn(),
  claimNextAccountDeletionPhase: vi.fn(),
  completeAccountDeletionPhase: vi.fn(),
}));

vi.mock("./account-deletion.service", () => serviceMocks);

import {
  blockAccountDeletionPhase,
  claimNextAccountDeletionPhase,
  completeAccountDeletionPhase,
} from "./account-deletion.service";
import {
  runAccountDeletionWorkerBatch,
  runNextAccountDeletionPhase,
} from "./account-deletion.worker";

const claim = {
  requestId: "request-1",
  credentialId: "credential-1",
  requestedAt: new Date("2026-09-29T12:00:00.000Z"),
  phase: "user_profile" as const,
  leaseToken: "lease-1",
  attempt: 1,
};

describe("account deletion phase worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimNextAccountDeletionPhase).mockResolvedValue(claim);
    vi.mocked(blockAccountDeletionPhase).mockResolvedValue(true);
    vi.mocked(completeAccountDeletionPhase).mockResolvedValue("stored_objects");
  });

  it("blocks instead of skipping a phase without a cleanup adapter", async () => {
    await expect(runNextAccountDeletionPhase({})).resolves.toEqual({
      outcome: "blocked",
      requestId: "request-1",
      phase: "user_profile",
    });
    expect(blockAccountDeletionPhase).toHaveBeenCalledWith(
      claim,
      "phase_handler_unavailable",
    );
    expect(completeAccountDeletionPhase).not.toHaveBeenCalled();
  });

  it("records handler failures as retryable blocked phases", async () => {
    const failed = vi.fn().mockRejectedValue(new Error("downstream detail"));
    const handlers = { user_profile: failed };

    await runNextAccountDeletionPhase(handlers);

    expect(blockAccountDeletionPhase).toHaveBeenCalledWith(
      claim,
      "phase_execution_failed",
    );
    expect(completeAccountDeletionPhase).not.toHaveBeenCalled();
  });

  it("does not report a blocked state when the worker already lost its lease", async () => {
    vi.mocked(blockAccountDeletionPhase).mockResolvedValue(false);
    const failed = vi.fn().mockRejectedValue(new Error("phase exceeded lease"));

    await expect(
      runNextAccountDeletionPhase({ user_profile: failed }),
    ).resolves.toMatchObject({
      outcome: "lease_lost",
      requestId: "request-1",
      phase: "user_profile",
    });
  });

  it("advances only after the phase handler returns successfully", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    await expect(
      runNextAccountDeletionPhase({ user_profile: handler }),
    ).resolves.toEqual({
      outcome: "completed",
      requestId: "request-1",
      nextPhase: "stored_objects",
    });
    expect(handler).toHaveBeenCalledWith({
      requestId: claim.requestId,
      credentialId: claim.credentialId,
      requestedAt: claim.requestedAt,
      phase: claim.phase,
      attempt: claim.attempt,
    });
    expect(completeAccountDeletionPhase).toHaveBeenCalledWith(claim);
    expect(blockAccountDeletionPhase).not.toHaveBeenCalled();
  });

  it("reports a lease lost while recording successful handler completion", async () => {
    const staleLease = new Error("Account deletion phase lease is stale");
    staleLease.name = "StaleAccountDeletionLeaseError";
    vi.mocked(completeAccountDeletionPhase).mockRejectedValue(staleLease);

    await expect(
      runNextAccountDeletionPhase({ user_profile: vi.fn().mockResolvedValue(undefined) }),
    ).resolves.toEqual({
      outcome: "lease_lost",
      requestId: "request-1",
      phase: "user_profile",
    });
  });

  it("blocks at stored objects after profile cleanup instead of skipping ahead", async () => {
    vi.mocked(claimNextAccountDeletionPhase)
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce({ ...claim, phase: "stored_objects", attempt: 2 });
    const profileHandler = vi.fn().mockResolvedValue(undefined);

    const outcomes = await runAccountDeletionWorkerBatch(
      { user_profile: profileHandler },
      10,
    );

    expect(outcomes).toEqual([
      { outcome: "completed", requestId: "request-1", nextPhase: "stored_objects" },
      { outcome: "blocked", requestId: "request-1", phase: "stored_objects" },
    ]);
    expect(profileHandler).toHaveBeenCalledOnce();
    expect(completeAccountDeletionPhase).toHaveBeenCalledOnce();
    expect(blockAccountDeletionPhase).toHaveBeenCalledWith(
      { ...claim, phase: "stored_objects", attempt: 2 },
      "phase_handler_unavailable",
    );
  });

  it("fails closed if the stored-object handler is invoked before token expiry", async () => {
    vi.mocked(claimNextAccountDeletionPhase).mockResolvedValue({
      ...claim,
      phase: "stored_objects",
    });
    const deferred = vi.fn().mockRejectedValue(
      new Error("Stored-object cleanup is deferred until token expiry"),
    );

    await expect(
      runNextAccountDeletionPhase({ stored_objects: deferred }),
    ).resolves.toEqual({
      outcome: "blocked",
      requestId: claim.requestId,
      phase: "stored_objects",
    });
    expect(deferred).toHaveBeenCalledWith({
      requestId: claim.requestId,
      credentialId: claim.credentialId,
      requestedAt: claim.requestedAt,
      phase: "stored_objects",
      attempt: claim.attempt,
    });
    expect(completeAccountDeletionPhase).not.toHaveBeenCalled();
    expect(blockAccountDeletionPhase).toHaveBeenCalledWith(
      { ...claim, phase: "stored_objects" },
      "phase_execution_failed",
    );
  });
});
