import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountDeletionPhaseHandlers } from "./account-deletion.worker";
import type { AccountDeletionWorkerResult } from "./account-deletion.worker";
import { startAccountDeletionWorkerScheduler } from "./account-deletion.scheduler";

describe("account deletion scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves the fail-closed missing stored-object handler for profile-only deployments", () => {
    const config = {
      profile: {
        endpoint: new URL("http://user-service:8082/internal/account-deletion"),
        secret: "shared-test-secret-with-at-least-32-utf8-bytes",
      },
      intervalSeconds: 30,
    };
    let capturedHandlers: AccountDeletionPhaseHandlers | undefined;
    const runBatch = vi.fn(
      async (handlers: AccountDeletionPhaseHandlers): Promise<AccountDeletionWorkerResult[]> => {
        capturedHandlers = handlers;
        return [{ outcome: "idle" }];
      },
    );

    const stop = startAccountDeletionWorkerScheduler(config, runBatch);
    expect(runBatch).toHaveBeenCalledOnce();
    expect(capturedHandlers?.user_profile).toBeTypeOf("function");
    expect(capturedHandlers?.stored_objects).toBeUndefined();
    expect(capturedHandlers?.device_data).toBeUndefined();
    stop();
  });

  it("runs bounded batches without overlapping a slow prior tick", async () => {
    vi.useFakeTimers();
    const config = {
      profile: {
        endpoint: new URL("http://user-service:8082/internal/account-deletion"),
        secret: "shared-test-secret-with-at-least-32-utf8-bytes",
      },
      storedObjects: {
        endpoint: new URL("http://control-plane:5000/internal/account-deletion"),
        secret: "another-shared-secret-with-at-least-32-utf8-bytes",
      },
      intervalSeconds: 5,
    };
    let releaseCurrentBatch: (() => void) | undefined;
    let capturedHandlers: AccountDeletionPhaseHandlers | undefined;
    const runBatch = vi.fn(
      async (
        handlers: AccountDeletionPhaseHandlers,
        _maximumPhases?: number,
      ): Promise<AccountDeletionWorkerResult[]> =>
        new Promise((resolve) => {
          capturedHandlers = handlers;
          releaseCurrentBatch = () => resolve([{ outcome: "idle" }]);
        }),
    );

    const stop = startAccountDeletionWorkerScheduler(config, runBatch);
    expect(runBatch).toHaveBeenCalledOnce();
    expect(runBatch.mock.calls[0]?.[1]).toBe(10);
    expect(capturedHandlers?.device_data).toBeTypeOf("function");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(runBatch).toHaveBeenCalledOnce();

    releaseCurrentBatch?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(runBatch.mock.calls[1]?.[1]).toBe(10);
    stop();
  });
});
