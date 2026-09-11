import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../controller/refresh.controller", () => ({
  default: vi.fn(),
}));

vi.mock("../lib/cookies", () => ({
  setAuthCookies: vi.fn(),
}));

import refreshRefreshToken from "../controller/refresh.controller";
import { setAuthCookies } from "../lib/cookies";
import router from "./refresh.route";

describe("POST /refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rotates cookies without exposing an access token in the response body", async () => {
    vi.mocked(refreshRefreshToken).mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });

    type RouteStack = Array<{
      route?: {
        path: string;
        stack: Array<{ handle: RouteHandler }>;
      };
    }>;
    type RouteHandler = (
      req: Request,
      res: Response,
      next: NextFunction,
    ) => Promise<unknown> | unknown;
    const route = (router as unknown as { stack: RouteStack }).stack.find(
      (layer) => layer.route?.path === "/refresh",
    );
    const handler = route?.route?.stack[0]?.handle;
    if (!handler) throw new Error("Refresh route handler was not registered");

    const response = {
      end: vi.fn(),
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const request = {
      cookies: { refresh_token: "old-refresh-token" },
    } as unknown as Request;

    await handler(request, response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(204);
    expect(response.end).toHaveBeenCalledOnce();
    expect(response.json).not.toHaveBeenCalled();
    expect(refreshRefreshToken).toHaveBeenCalledWith({
      refreshToken: "old-refresh-token",
    });
    expect(setAuthCookies).toHaveBeenCalledWith(
      expect.anything(),
      "access-token",
      "refresh-token",
    );
  });
});
