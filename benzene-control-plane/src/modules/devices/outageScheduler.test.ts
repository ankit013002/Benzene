import { describe, expect, it, vi } from "vitest";

import { startOutageScheduler } from "./outageScheduler.js";

const NO_CHANGES = { offline: 0, extendedOffline: 0, suspectedLost: 0 };

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function harness(classify: () => Promise<typeof NO_CHANGES>) {
  let tick: (() => void) | undefined;
  const timer = { unref: vi.fn() };
  const clearIntervalFn = vi.fn();
  const logger = { log: vi.fn(), error: vi.fn() };
  const scheduler = startOutageScheduler({
    intervalSeconds: 30,
    classify,
    logger,
    setIntervalFn(callback, delayMs) {
      expect(delayMs).toBe(30_000);
      tick = callback;
      return timer;
    },
    clearIntervalFn,
  });
  return { scheduler, tick: () => tick?.(), timer, clearIntervalFn, logger };
}

describe("outage scheduler", () => {
  it("runs immediately and on the configured interval", async () => {
    const classify = vi.fn().mockResolvedValue(NO_CHANGES);
    const { scheduler, tick, timer } = harness(classify);

    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
    tick();
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2));

    expect(timer.unref).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it("does not overlap a slow sweep", async () => {
    const first = deferred<typeof NO_CHANGES>();
    const classify = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(NO_CHANGES);
    const { scheduler, tick } = harness(classify);

    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    tick();
    expect(classify).toHaveBeenCalledOnce();

    first.resolve(NO_CHANGES);
    await scheduler.stop();
  });

  it("contains one failed sweep and continues later", async () => {
    const failure = new Error("database unavailable");
    const classify = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(NO_CHANGES);
    const { scheduler, tick, logger } = harness(classify);

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        "[control-plane] device outage sweep failed",
        failure
      )
    );
    tick();
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2));

    await scheduler.stop();
  });

  it("clears the timer and waits for an active sweep before stopping", async () => {
    const active = deferred<typeof NO_CHANGES>();
    const classify = vi.fn().mockReturnValue(active.promise);
    const { scheduler, tick, clearIntervalFn } = harness(classify);

    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });

    expect(clearIntervalFn).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    tick();
    expect(classify).toHaveBeenCalledOnce();

    active.resolve(NO_CHANGES);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("logs only sweeps that persist transitions", async () => {
    const classify = vi.fn().mockResolvedValue({
      offline: 2,
      extendedOffline: 1,
      suspectedLost: 1,
    });
    const { scheduler, logger } = harness(classify);

    await vi.waitFor(() =>
      expect(logger.log).toHaveBeenCalledWith(
        "[control-plane] device outage sweep updated 4 device(s): " +
          "2 offline, 1 extended offline, 1 suspected lost"
      )
    );

    await scheduler.stop();
  });
});
