import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/account-deletion.service", () => ({
  requestAccountDeletion: vi.fn(),
  getAccountDeletionStatus: vi.fn(),
  getAccountDeletionStatusByReceipt: vi.fn(),
}));

import {
  getAccountDeletionStatus,
  getAccountDeletionStatusByReceipt,
  requestAccountDeletion,
} from "../services/account-deletion.service";
import router from "./account-deletion.route";

type RouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

function registeredHandler(path: string): RouteHandler {
  type RouteStack = Array<{
    route?: { path: string; stack: Array<{ handle: RouteHandler }> };
  }>;
  const route = (router as unknown as { stack: RouteStack }).stack.find(
    (layer) => layer.route?.path === path,
  );
  const handler = route?.route?.stack.at(-1)?.handle;
  if (!handler) throw new Error(`${path} route handler was not registered`);
  return handler;
}

function request(body: unknown): Request {
  return { body } as Request;
}

function response(): Response {
  return {
    json: vi.fn(),
    set: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe("account deletion routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a durable pending state without claiming associated data was deleted", async () => {
    vi.mocked(requestAccountDeletion).mockResolvedValue({
      created: true,
      receipt: "a".repeat(43),
      request: {
        id: "request-id",
        status: "cleanup_pending",
        current_phase: "awaiting_cleanup_operator",
        requested_at: new Date("2026-09-28T12:00:00Z"),
        updated_at: new Date("2026-09-28T12:00:00Z"),
        completed_at: null,
      },
    });
    const res = response();

    await registeredHandler("/account-deletion")(
      request({
        email: "ada@example.com",
        password: "correct-password",
        idempotencyKey: "stable-operation-identifier",
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: "a".repeat(43),
        status: "cleanup_pending",
        currentPhase: "awaiting_cleanup_operator",
        deletionComplete: false,
        downstreamCleanupStarted: false,
        message: expect.stringContaining(
          "any already-issued access token can remain valid for up to 15 minutes",
        ),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "Refresh and session-renewal credentials are revoked",
        ),
      }),
    );
  });

  it("requires a nonempty deletion idempotency key", async () => {
    const res = response();

    await registeredHandler("/account-deletion")(
      request({ email: "ada@example.com", password: "correct-password" }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  it("requires password reauthentication before returning status", async () => {
    vi.mocked(getAccountDeletionStatus).mockRejectedValue(
      Object.assign(new Error("Invalid credentials"), {
        name: "InvalidCredentialsError",
      }),
    );
    const res = response();

    await registeredHandler("/account-deletion/status")(
      request({ email: "ada@example.com", password: "wrong-password" }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid credentials" });
  });

  it("returns receipt status without credentials and disables caching", async () => {
    vi.mocked(getAccountDeletionStatusByReceipt).mockResolvedValue({
      id: "f2dce0df-28f6-458c-8ab7-e7b2e64f3b1a",
      status: "completed",
      current_phase: "complete",
      requested_at: new Date("2026-09-28T12:00:00Z"),
      updated_at: new Date("2026-09-28T12:10:00Z"),
      completed_at: new Date("2026-09-28T12:10:00Z"),
    });
    const res = response();

    await registeredHandler("/account-deletion/receipt-status")(
      request({ requestId: "f2dce0df-28f6-458c-8ab7-e7b2e64f3b1a", receipt: "a".repeat(43) }),
      res,
      vi.fn(),
    );

    expect(getAccountDeletionStatusByReceipt).toHaveBeenCalledWith({
      requestId: "f2dce0df-28f6-458c-8ab7-e7b2e64f3b1a",
      receipt: "a".repeat(43),
    });
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ deletionComplete: true }));
  });
});
