import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../controller/login.controller", () => ({ default: vi.fn() }));
vi.mock("../lib/cookies", () => ({ setAuthCookies: vi.fn() }));

import loginController from "../controller/login.controller";
import { setAuthCookies } from "../lib/cookies";
import router from "./login.route";

type RouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

function registeredLoginHandler(): RouteHandler {
  type RouteStack = Array<{
    route?: { path: string; stack: Array<{ handle: RouteHandler }> };
  }>;
  const route = (router as unknown as { stack: RouteStack }).stack.find(
    (layer) => layer.route?.path === "/login",
  );
  const handler = route?.route?.stack.at(-1)?.handle;
  if (!handler) throw new Error("Login route handler was not registered");
  return handler;
}

describe("POST /login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps browser credentials in httpOnly cookies and out of the response body", async () => {
    vi.mocked(loginController).mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      emailVerified: true,
    });
    const response = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const request = {
      body: { email: "ada@example.com", password: "correct-password" },
      headers: { "x-benzene-client-kind": "native-mobile" },
    } as unknown as Request;

    await registeredLoginHandler()(request, response, vi.fn());

    expect(setAuthCookies).toHaveBeenCalledWith(
      expect.anything(),
      "access-token",
      "refresh-token",
    );
    expect(response.json).toHaveBeenCalledWith({
      ok: true,
      emailVerified: true,
    });
  });
});
