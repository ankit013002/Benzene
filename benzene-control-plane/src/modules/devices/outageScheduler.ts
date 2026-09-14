import { classifyDeviceOutages } from "./outageClassification.js";

interface IntervalHandle {
  unref?: () => unknown;
}

interface OutageCounts {
  offline: number;
  extendedOffline: number;
  suspectedLost: number;
}

interface SchedulerLogger {
  log(message: string): void;
  error(message: string, error: unknown): void;
}

export interface OutageScheduler {
  stop(): Promise<void>;
}

export interface OutageSchedulerOptions {
  intervalSeconds: number;
  classify?: () => Promise<OutageCounts>;
  logger?: SchedulerLogger;
  setIntervalFn?: (callback: () => void, delayMs: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

function describeTransitions(counts: OutageCounts): string | undefined {
  const total = counts.offline + counts.extendedOffline + counts.suspectedLost;
  if (total === 0) return undefined;
  return (
    `[control-plane] device outage sweep updated ${total} device(s): ` +
    `${counts.offline} offline, ${counts.extendedOffline} extended offline, ` +
    `${counts.suspectedLost} suspected lost`
  );
}

/**
 * Starts one process-local outage sweep. Database row locks make concurrent
 * instances safe, while the in-flight guard prevents one slow sweep from
 * piling up work inside this process.
 */
export function startOutageScheduler(options: OutageSchedulerOptions): OutageScheduler {
  const classify = options.classify ?? (() => classifyDeviceOutages());
  const logger = options.logger ?? console;
  const setIntervalFn =
    options.setIntervalFn ??
    ((callback, delayMs) => setInterval(callback, delayMs));
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const sweep = (): void => {
    if (stopped || inFlight) return;

    inFlight = Promise.resolve()
      .then(classify)
      .then((counts) => {
        const message = describeTransitions(counts);
        if (message) logger.log(message);
      })
      .catch((error: unknown) => {
        logger.error("[control-plane] device outage sweep failed", error);
      })
      .finally(() => {
        inFlight = undefined;
      });
  };

  sweep();
  const timer = setIntervalFn(sweep, options.intervalSeconds * 1000);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearIntervalFn(timer);
      await inFlight;
    },
  };
}
