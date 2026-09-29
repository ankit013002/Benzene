import { describe, expect, it, vi } from "vitest";
import {
  createUserProfileDeletionHandler,
  readAccountDeletionWorkerConfig,
} from "./account-deletion-user-profile.adapter";

const validEnvironment = {
  ACCOUNT_DELETION_USER_SERVICE_URL:
    "http://user-service:8082/internal/account-deletion",
  ACCOUNT_DELETION_USER_SERVICE_SECRET:
    "shared-test-secret-with-at-least-32-utf8-bytes",
  ACCOUNT_DELETION_WORKER_INTERVAL_SECONDS: "30",
} as NodeJS.ProcessEnv;

describe("account deletion user-profile adapter configuration", () => {
  it("keeps cleanup disabled when no worker settings are present", () => {
    expect(readAccountDeletionWorkerConfig({} as NodeJS.ProcessEnv, "development"))
      .toBeUndefined();
  });

  it("requires URL, secret and interval as one explicit configuration", () => {
    expect(() =>
      readAccountDeletionWorkerConfig(
        { ACCOUNT_DELETION_USER_SERVICE_URL: validEnvironment.ACCOUNT_DELETION_USER_SERVICE_URL } as NodeJS.ProcessEnv,
        "development",
      ),
    ).toThrow("must be configured together");
  });

  it("rejects short secrets and invalid production transport", () => {
    expect(() =>
      readAccountDeletionWorkerConfig(
        { ...validEnvironment, ACCOUNT_DELETION_USER_SERVICE_SECRET: "short" },
        "development",
      ),
    ).toThrow("at least 32 UTF-8 bytes");
    expect(() =>
      readAccountDeletionWorkerConfig(validEnvironment, "production"),
    ).toThrow("requires an HTTPS");
  });

  it("accepts a complete production configuration over HTTPS", () => {
    const config = readAccountDeletionWorkerConfig(
      {
        ...validEnvironment,
        ACCOUNT_DELETION_USER_SERVICE_URL:
          "https://user-service.internal/internal/account-deletion",
      },
      "production",
    );

    expect(config?.intervalSeconds).toBe(30);
    expect(config?.profile.endpoint.pathname).toBe("/internal/account-deletion");
  });
});

describe("account deletion user-profile adapter", () => {
  it("calls the private service with the credential subject and shared secret", async () => {
    const response = new Response(null, { status: 204 });
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response);
    const config = readAccountDeletionWorkerConfig(validEnvironment, "development");
    if (!config) throw new Error("Expected explicit adapter config");
    const handler = createUserProfileDeletionHandler(
      config.profile,
      fetchImplementation,
    );

    await handler({
      requestId: "request-1",
      credentialId: "7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
      phase: "user_profile",
      attempt: 1,
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL(
        "http://user-service:8082/internal/account-deletion/7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
      ),
      expect.objectContaining({
        method: "DELETE",
        headers: {
          "X-Benzene-Internal-Secret": validEnvironment.ACCOUNT_DELETION_USER_SERVICE_SECRET,
        },
        redirect: "error",
      }),
    );
  });

  it("blocks the phase when the downstream service does not confirm success", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const config = readAccountDeletionWorkerConfig(validEnvironment, "development");
    if (!config) throw new Error("Expected explicit adapter config");
    const handler = createUserProfileDeletionHandler(
      config.profile,
      fetchImplementation,
    );

    await expect(
      handler({
        requestId: "request-1",
        credentialId: "7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
        phase: "user_profile",
        attempt: 1,
      }),
    ).rejects.toThrow("HTTP 503");
  });
});
