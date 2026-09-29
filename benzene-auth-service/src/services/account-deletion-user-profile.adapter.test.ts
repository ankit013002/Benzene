import { describe, expect, it, vi } from "vitest";
import { STORED_OBJECTS_DELETION_GRACE_SECONDS } from "../lib/account-deletion-timing";
import {
  createDeviceDataDeletionHandler,
  createStoredObjectsDeletionHandler,
  createUserProfileDeletionHandler,
  readAccountDeletionWorkerConfig,
} from "./account-deletion-user-profile.adapter";

const validEnvironment = {
  ACCOUNT_DELETION_USER_SERVICE_URL:
    "http://user-service:8082/internal/account-deletion",
  ACCOUNT_DELETION_USER_SERVICE_SECRET:
    "shared-test-secret-with-at-least-32-utf8-bytes",
  ACCOUNT_DELETION_CONTROL_PLANE_URL:
    "http://control-plane:5000/internal/account-deletion",
  ACCOUNT_DELETION_CONTROL_PLANE_SECRET:
    "another-shared-secret-with-at-least-32-utf8-bytes",
  ACCOUNT_DELETION_WORKER_INTERVAL_SECONDS: "30",
} as NodeJS.ProcessEnv;
const profileOnlyEnvironment = {
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

  it("keeps profile-only worker configuration available while requiring control-plane settings as a pair", () => {
    const config = readAccountDeletionWorkerConfig(profileOnlyEnvironment, "development");
    expect(config?.profile.endpoint.pathname).toBe("/internal/account-deletion");
    expect(config?.storedObjects).toBeUndefined();

    expect(() =>
      readAccountDeletionWorkerConfig(
        {
          ...profileOnlyEnvironment,
          ACCOUNT_DELETION_CONTROL_PLANE_URL:
            "http://control-plane:5000/internal/account-deletion",
        },
        "development",
      ),
    ).toThrow("control-plane URL and secret must be configured together");
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
        ACCOUNT_DELETION_CONTROL_PLANE_URL:
          "https://control-plane.internal/internal/account-deletion",
      },
      "production",
    );

    expect(config?.intervalSeconds).toBe(30);
    expect(config?.profile.endpoint.pathname).toBe("/internal/account-deletion");
    expect(config?.storedObjects?.endpoint.pathname).toBe("/internal/account-deletion");
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
      requestedAt: new Date(),
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
        requestedAt: new Date(),
        phase: "user_profile",
        attempt: 1,
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("uses the control-plane adapter and only accepts a completed purge receipt", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ complete: true }), { status: 200 }),
    );
    const config = readAccountDeletionWorkerConfig(validEnvironment, "development");
    if (!config?.storedObjects) throw new Error("Expected explicit adapter config");
    const handler = createStoredObjectsDeletionHandler(
      config.storedObjects,
      fetchImplementation,
    );

    await handler({
      requestId: "request-1",
      credentialId: "7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
      requestedAt: new Date(
        Date.now() - (STORED_OBJECTS_DELETION_GRACE_SECONDS + 1) * 1000,
      ),
      phase: "stored_objects",
      attempt: 2,
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL(
        "http://control-plane:5000/internal/account-deletion/7e1c77ad-56a0-483f-8eba-52a4f50bf2a1/stored-objects",
      ),
      expect.objectContaining({
        method: "POST",
        headers: {
          "X-Benzene-Internal-Secret": validEnvironment.ACCOUNT_DELETION_CONTROL_PLANE_SECRET,
        },
        redirect: "error",
      }),
    );

    const incomplete = createStoredObjectsDeletionHandler(
      config.storedObjects,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ complete: false }), { status: 200 }),
      ),
    );
    await expect(
      incomplete({
        requestId: "request-1",
        credentialId: "7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
        requestedAt: new Date(
          Date.now() - (STORED_OBJECTS_DELETION_GRACE_SECONDS + 1) * 1000,
        ),
        phase: "stored_objects",
        attempt: 3,
      }),
    ).rejects.toThrow("remains incomplete");
  });

  it("defers stored-object cleanup until existing access tokens and clock margin expire", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const config = readAccountDeletionWorkerConfig(validEnvironment, "development");
    if (!config?.storedObjects) throw new Error("Expected explicit adapter config");
    const handler = createStoredObjectsDeletionHandler(
      config.storedObjects,
      fetchImplementation,
    );

    await expect(
      handler({
        requestId: "request-1",
        credentialId: "7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
        requestedAt: new Date(),
        phase: "stored_objects",
        attempt: 1,
      }),
    ).rejects.toThrow("so existing access tokens expire");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("keeps device-data cleanup pending until every node acknowledges removal", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          complete: false,
          removalStarted: 2,
          awaitingDeviceAcknowledgement: 1,
        }),
        { status: 200 },
      ),
    );
    const config = readAccountDeletionWorkerConfig(validEnvironment, "development");
    if (!config?.storedObjects) throw new Error("Expected shared control-plane adapter config");
    const handler = createDeviceDataDeletionHandler(
      config.storedObjects,
      fetchImplementation,
    );

    await expect(
      handler({
        requestId: "request-1",
        credentialId: "7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
        requestedAt: new Date(),
        phase: "device_data",
        attempt: 1,
      }),
    ).rejects.toThrow("remains incomplete");
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL(
        "http://control-plane:5000/internal/account-deletion/7e1c77ad-56a0-483f-8eba-52a4f50bf2a1/device-data",
      ),
      expect.objectContaining({
        method: "POST",
        headers: {
          "X-Benzene-Internal-Secret": validEnvironment.ACCOUNT_DELETION_CONTROL_PLANE_SECRET,
        },
        redirect: "error",
      }),
    );

    const completeHandler = createDeviceDataDeletionHandler(
      config.storedObjects,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ complete: true }), { status: 200 }),
      ),
    );
    await expect(
      completeHandler({
        requestId: "request-1",
        credentialId: "7e1c77ad-56a0-483f-8eba-52a4f50bf2a1",
        requestedAt: new Date(),
        phase: "device_data",
        attempt: 2,
      }),
    ).resolves.toBeUndefined();
  });
});
