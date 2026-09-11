import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../controller/logout.controller", () => ({
  default: vi.fn(),
}));

vi.mock("../lib/cookies", () => ({
  clearAuthCookies: vi.fn(),
}));

import handleLogout from "../controller/logout.controller";
import { clearAuthCookies } from "../lib/cookies";
import router from "./logout.route";

type RouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

function registeredLogoutHandler(): RouteHandler {
  type RouteStack = Array<{
    route?: {
      path: string;
      stack: Array<{ handle: RouteHandler }>;
    };
  }>;
  const route = (router as unknown as { stack: RouteStack }).stack.find(
    (layer) => layer.route?.path === "/logout",
  );
  const handler = route?.route?.stack[0]?.handle;
  if (!handler) throw new Error("Logout route handler was not registered");
  return handler;
}

describe("POST /logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears both cookies when refresh-token revocation fails", async () => {
    vi.mocked(handleLogout).mockRejectedValue(new Error("database unavailable"));
    const response = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const request = {
      cookies: { refresh_token: "refresh-token" },
    } as unknown as Request;

    await registeredLogoutHandler()(request, response, vi.fn());

    expect(clearAuthCookies).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("clears both cookies after successful revocation", async () => {
    vi.mocked(handleLogout).mockResolvedValue(undefined);
    const response = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const request = {
      cookies: { refresh_token: "refresh-token" },
    } as unknown as Request;

    await registeredLogoutHandler()(request, response, vi.fn());

    expect(clearAuthCookies).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      message: "Logged out successfully",
    });
  });
});
