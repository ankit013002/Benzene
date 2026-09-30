import {
  createDeviceDataDeletionHandler,
  createStoredObjectsDeletionHandler,
  createUserProfileDeletionHandler,
  createVaultMetadataDeletionHandler,
  readAccountDeletionWorkerConfig,
} from "./account-deletion-user-profile.adapter";
import {
  runAccountDeletionWorkerBatch,
  type AccountDeletionPhaseHandlers,
} from "./account-deletion.worker";

export function startAccountDeletionWorkerScheduler(
  config: NonNullable<ReturnType<typeof readAccountDeletionWorkerConfig>>,
  runBatch: typeof runAccountDeletionWorkerBatch = runAccountDeletionWorkerBatch,
): () => void {
  const handlers: AccountDeletionPhaseHandlers = {
    user_profile: createUserProfileDeletionHandler(config.profile),
    // Credential deletion and its receipt commit together inside PostgreSQL.
    auth_credential: async () => {},
  };
  if (config.storedObjects) {
    handlers.stored_objects = createStoredObjectsDeletionHandler(config.storedObjects);
    handlers.device_data = createDeviceDataDeletionHandler(config.storedObjects);
    handlers.vault_metadata = createVaultMetadataDeletionHandler(config.storedObjects);
  }
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const outcomes = await runBatch(handlers, 10);
      for (const outcome of outcomes) {
        if (outcome.outcome === "blocked") {
          console.warn(
            "Account deletion phase blocked",
            JSON.stringify({ requestId: outcome.requestId, phase: outcome.phase }),
          );
        } else if (outcome.outcome === "lease_lost") {
          console.warn(
            "Account deletion worker lost its phase lease",
            JSON.stringify({ requestId: outcome.requestId, phase: outcome.phase }),
          );
        }
      }
    } catch {
      console.error("Account deletion worker batch failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), config.intervalSeconds * 1000);
  void run();
  console.info(
    "Account deletion cleanup worker enabled",
    JSON.stringify({ intervalSeconds: config.intervalSeconds }),
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Starts the opt-in worker. Unconfigured downstream phases block safely. */
export function startAccountDeletionSchedulerFromEnvironment(): (() => void) | undefined {
  const config = readAccountDeletionWorkerConfig();
  if (!config) {
    console.info("Account deletion worker disabled: downstream URLs, secrets, and interval are not configured");
    return undefined;
  }
  return startAccountDeletionWorkerScheduler(config);
}
