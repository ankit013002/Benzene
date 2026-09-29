import type { AccountDeletionPhaseHandler } from "./account-deletion.worker";

export interface UserProfileDeletionConfig {
  endpoint: URL;
  secret: string;
}

export function readAccountDeletionWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = env.NODE_ENV,
): { profile: UserProfileDeletionConfig; intervalSeconds: number } | undefined {
  const endpointValue = env.ACCOUNT_DELETION_USER_SERVICE_URL?.trim();
  const secret = env.ACCOUNT_DELETION_USER_SERVICE_SECRET;
  const intervalValue = env.ACCOUNT_DELETION_WORKER_INTERVAL_SECONDS?.trim();
  const configuredCount = [endpointValue, secret?.trim(), intervalValue].filter(
    (value) => value !== undefined && value.length > 0,
  ).length;

  if (configuredCount === 0) return undefined;
  if (configuredCount !== 3) {
    throw new Error(
      "Account deletion worker URL, secret, and interval must be configured together",
    );
  }
  if (!endpointValue || !secret || !intervalValue) {
    throw new Error("Account deletion worker configuration is incomplete");
  }

  const endpoint = new URL(endpointValue);
  const normalizedPath = endpoint.pathname.replace(/\/$/, "");
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    normalizedPath !== "/internal/account-deletion"
  ) {
    throw new Error(
      "Account deletion user-service URL must target /internal/account-deletion without URL credentials or query parameters",
    );
  }

  if (nodeEnvironment === "production" && endpoint.protocol !== "https:") {
    throw new Error(
      "Production account deletion requires an HTTPS user-service URL",
    );
  }

  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "Account deletion user-service secret must contain at least 32 UTF-8 bytes",
    );
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

  return { profile: { endpoint, secret }, intervalSeconds };
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
