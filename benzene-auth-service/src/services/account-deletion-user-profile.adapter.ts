import type { AccountDeletionPhaseHandler } from "./account-deletion.worker";
import { STORED_OBJECTS_DELETION_GRACE_SECONDS } from "../lib/account-deletion-timing";

export interface UserProfileDeletionConfig {
  endpoint: URL;
  secret: string;
}

export interface StoredObjectsDeletionConfig {
  endpoint: URL;
  secret: string;
}

/**
 * These narrowly scoped values are operator attestations for the current
 * deployment inventory, not general-purpose phase skip switches. Replace each
 * with a real idempotent deletion adapter as soon as that data is managed.
 */
export const BILLING_RECORDS_ABSENCE_ATTESTATION =
  "BENZENE_V1_NO_MANAGED_BILLING_RECORDS" as const;
export const BACKUPS_AND_LOGS_ABSENCE_ATTESTATION =
  "BENZENE_V1_NO_MANAGED_ACCOUNT_BACKUPS_OR_LOGS" as const;

export interface AccountDeletionWorkerConfig {
  profile: UserProfileDeletionConfig;
  storedObjects?: StoredObjectsDeletionConfig;
  billingRecordsAbsenceAttestation?: typeof BILLING_RECORDS_ABSENCE_ATTESTATION;
  backupsAndLogsAbsenceAttestation?: typeof BACKUPS_AND_LOGS_ABSENCE_ATTESTATION;
  intervalSeconds: number;
}

export function readAccountDeletionWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = env.NODE_ENV,
): AccountDeletionWorkerConfig | undefined {
  const profileEndpointValue = env.ACCOUNT_DELETION_USER_SERVICE_URL?.trim();
  const profileSecret = env.ACCOUNT_DELETION_USER_SERVICE_SECRET;
  const storedObjectsEndpointValue = env.ACCOUNT_DELETION_CONTROL_PLANE_URL?.trim();
  const storedObjectsSecret = env.ACCOUNT_DELETION_CONTROL_PLANE_SECRET;
  const intervalValue = env.ACCOUNT_DELETION_WORKER_INTERVAL_SECONDS?.trim();
  const billingRecordsAttestation = readAbsenceAttestation(
    env,
    "ACCOUNT_DELETION_BILLING_RECORDS_ABSENCE_ATTESTATION",
    BILLING_RECORDS_ABSENCE_ATTESTATION,
    "billing_records",
  );
  const backupsAndLogsAttestation = readAbsenceAttestation(
    env,
    "ACCOUNT_DELETION_BACKUPS_AND_LOGS_ABSENCE_ATTESTATION",
    BACKUPS_AND_LOGS_ABSENCE_ATTESTATION,
    "backups_and_logs",
  );
  const profileValues = [profileEndpointValue, profileSecret?.trim(), intervalValue];
  const profileConfiguredCount = profileValues.filter(
    (value) => value !== undefined && value.length > 0,
  ).length;
  const storedObjectsValues = [storedObjectsEndpointValue, storedObjectsSecret?.trim()];
  const storedObjectsConfiguredCount = storedObjectsValues.filter(
    (value) => value !== undefined && value.length > 0,
  ).length;

  if (profileConfiguredCount === 0 && storedObjectsConfiguredCount === 0) {
    return undefined;
  }
  if (profileConfiguredCount !== 3) {
    throw new Error(
      "Account deletion user-service URL, secret, and interval must be configured together",
    );
  }
  if (storedObjectsConfiguredCount === 1) {
    throw new Error(
      "Account deletion control-plane URL and secret must be configured together",
    );
  }
  if (!profileEndpointValue || !profileSecret || !intervalValue) {
    throw new Error("Account deletion worker configuration is incomplete");
  }

  const profileEndpoint = validateEndpoint(
    profileEndpointValue,
    "/internal/account-deletion",
    "user-service",
    nodeEnvironment,
  );
  validateSecret(profileSecret, "user-service");

  let storedObjects: StoredObjectsDeletionConfig | undefined;
  if (storedObjectsEndpointValue && storedObjectsSecret) {
    const endpoint = validateEndpoint(
      storedObjectsEndpointValue,
      "/internal/account-deletion",
      "control-plane",
      nodeEnvironment,
    );
    validateSecret(storedObjectsSecret, "control-plane");
    storedObjects = { endpoint, secret: storedObjectsSecret };
  }

  const intervalSeconds = Number(intervalValue);
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 5 ||
    intervalSeconds > 3600
  ) {
    throw new Error(
      "Account deletion worker interval must be an integer from 5 through 3600 seconds",
    );
  }

  return {
    profile: { endpoint: profileEndpoint, secret: profileSecret },
    ...(storedObjects ? { storedObjects } : {}),
    ...(billingRecordsAttestation
      ? { billingRecordsAbsenceAttestation: billingRecordsAttestation }
      : {}),
    ...(backupsAndLogsAttestation
      ? { backupsAndLogsAbsenceAttestation: backupsAndLogsAttestation }
      : {}),
    intervalSeconds,
  };
}

function readAbsenceAttestation<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  expected: T,
  phase: string,
): T | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value !== expected) {
    throw new Error(
      `${name} must exactly equal ${expected} to attest that no ${phase} data is managed`,
    );
  }
  return expected;
}

function validateEndpoint(
  endpointValue: string,
  expectedPath: string,
  service: string,
  nodeEnvironment: string | undefined,
): URL {
  const endpoint = new URL(endpointValue);
  const normalizedPath = endpoint.pathname.replace(/\/$/, "");
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    normalizedPath !== expectedPath
  ) {
    throw new Error(
      `Account deletion ${service} URL must target ${expectedPath} without URL credentials or query parameters`,
    );
  }
  if (nodeEnvironment === "production" && endpoint.protocol !== "https:") {
    throw new Error(`Production account deletion requires an HTTPS ${service} URL`);
  }
  return endpoint;
}

function validateSecret(secret: string, service: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(`Account deletion ${service} secret must contain at least 32 UTF-8 bytes`);
  }
}

/**
 * A phase may be skipped only when the operator supplies the exact inventory
 * attestation parsed by readAccountDeletionWorkerConfig. This must be replaced
 * by a real deletion adapter if the service starts managing billing records.
 */
export function createBillingRecordsAbsenceAttestedHandler(
  attestation: typeof BILLING_RECORDS_ABSENCE_ATTESTATION,
): AccountDeletionPhaseHandler {
  if (attestation !== BILLING_RECORDS_ABSENCE_ATTESTATION) {
    throw new Error("Billing-record absence attestation is invalid");
  }
  return async () => {};
}

/**
 * A phase may be skipped only when the operator supplies the exact inventory
 * attestation parsed by readAccountDeletionWorkerConfig. This must be replaced
 * by real backup/log deletion adapters if the service starts managing them.
 */
export function createBackupsAndLogsAbsenceAttestedHandler(
  attestation: typeof BACKUPS_AND_LOGS_ABSENCE_ATTESTATION,
): AccountDeletionPhaseHandler {
  if (attestation !== BACKUPS_AND_LOGS_ABSENCE_ATTESTATION) {
    throw new Error("Backup-and-log absence attestation is invalid");
  }
  return async () => {};
}

export function createUserProfileDeletionHandler(
  config: UserProfileDeletionConfig,
  fetchImplementation: typeof fetch = fetch,
): AccountDeletionPhaseHandler {
  return async ({ credentialId }) => {
    const endpoint = new URL(
      encodeURIComponent(credentialId),
      `${config.endpoint.href.replace(/\/$/, "")}/`,
    );
    const response = await fetchImplementation(endpoint, {
      method: "DELETE",
      headers: { "X-Benzene-Internal-Secret": config.secret },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`User-profile deletion returned HTTP ${response.status}`);
    }
  };
}

export function createStoredObjectsDeletionHandler(
  config: StoredObjectsDeletionConfig,
  fetchImplementation: typeof fetch = fetch,
): AccountDeletionPhaseHandler {
  return async ({ credentialId, requestedAt }) => {
    if (!Number.isFinite(requestedAt.getTime())) {
      throw new Error("Stored-object cleanup requires a valid deletion request timestamp");
    }
    const safeAfter = new Date(
      requestedAt.getTime() +
        STORED_OBJECTS_DELETION_GRACE_SECONDS * 1000,
    );
    if (Date.now() < safeAfter.getTime()) {
      throw new Error(
        `Stored-object cleanup is deferred until ${safeAfter.toISOString()} so existing access tokens expire`,
      );
    }

    const endpoint = new URL(
      `${encodeURIComponent(credentialId)}/stored-objects`,
      `${config.endpoint.href.replace(/\/$/, "")}/`,
    );
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: { "X-Benzene-Internal-Secret": config.secret },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Stored-object deletion returned HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("complete" in result) ||
      result.complete !== true
    ) {
      throw new Error("Stored-object cleanup remains incomplete");
    }
  };
}

/** Starts device retirement and waits for each signed erase acknowledgement. */
export function createDeviceDataDeletionHandler(
  config: StoredObjectsDeletionConfig,
  fetchImplementation: typeof fetch = fetch,
): AccountDeletionPhaseHandler {
  return async ({ credentialId }) => {
    const endpoint = new URL(
      `${encodeURIComponent(credentialId)}/device-data`,
      `${config.endpoint.href.replace(/\/$/, "")}/`,
    );
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: { "X-Benzene-Internal-Secret": config.secret },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Device-data deletion returned HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("complete" in result) ||
      result.complete !== true
    ) {
      throw new Error("Device-data deletion remains incomplete");
    }
  };
}

/** Deletes the relational Vault graph only after storage and device cleanup receipts. */
export function createVaultMetadataDeletionHandler(
  config: StoredObjectsDeletionConfig,
  fetchImplementation: typeof fetch = fetch,
): AccountDeletionPhaseHandler {
  return async ({ credentialId }) => {
    const endpoint = new URL(
      `${encodeURIComponent(credentialId)}/vault-metadata`,
      `${config.endpoint.href.replace(/\/$/, "")}/`,
    );
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: { "X-Benzene-Internal-Secret": config.secret },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Vault-metadata deletion returned HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("complete" in result) ||
      result.complete !== true
    ) {
      throw new Error("Vault-metadata cleanup remains incomplete");
    }
  };
}
