import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../controller/login.controller", () => ({ default: vi.fn() }));
vi.mock("../controller/logout.controller", () => ({ default: vi.fn() }));
vi.mock("../controller/refresh.controller", () => ({ default: vi.fn() }));

import loginController from "../controller/login.controller";
import handleLogout from "../controller/logout.controller";
import refreshRefreshToken from "../controller/refresh.controller";
import {
  NATIVE_CLIENT_KIND,
  NATIVE_CLIENT_KIND_HEADER,
} from "../lib/native-client";
import router from "./native-auth.route";

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

function request(body: unknown, native = true): Request {
  return {
    body,
    get: vi.fn((name: string) =>
      native && name === NATIVE_CLIENT_KIND_HEADER
        ? NATIVE_CLIENT_KIND
        : undefined,
    ),
  } as unknown as Request;
}

function response(): Response {
  return {
    json: vi.fn(),
    set: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

describe("native mobile authentication routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not expose tokens unless the native client contract is explicit", async () => {
    const res = response();

    await registeredHandler("/native/login")(
      request({ email: "ada@example.com", password: "correct-password" }, false),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(loginController).not.toHaveBeenCalled();
  });

  it("returns short-lived bearer and refresh credentials only to a native login", async () => {
    vi.mocked(loginController).mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      emailVerified: true,
    });
    const res = response();

    await registeredHandler("/native/login")(
      request({ email: "ada@example.com", password: "correct-password" }),
      res,
      vi.fn(),
    );

    expect(loginController).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct-password",
    });
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.set).toHaveBeenCalledWith("Pragma", "no-cache");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresInSeconds: 900,
      emailVerified: true,
    });
  });

  it("rotates the native refresh credential from the JSON body", async () => {
    vi.mocked(refreshRefreshToken).mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
    });
    const res = response();

    await registeredHandler("/native/refresh")(
      request({ refreshToken: "old-refresh-token" }),
      res,
      vi.fn(),
    );

    expect(refreshRefreshToken).toHaveBeenCalledWith({
      refreshToken: "old-refresh-token",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      tokenType: "Bearer",
      expiresInSeconds: 900,
    });
  });

  it("rejects a native refresh body with additional fields", async () => {
    const res = response();

    await registeredHandler("/native/refresh")(
      request({ refreshToken: "old-refresh-token", clientOverride: "web" }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(refreshRefreshToken).not.toHaveBeenCalled();
  });

  it("revokes the refresh credential supplied by a native logout", async () => {
    vi.mocked(handleLogout).mockResolvedValue(undefined);
    const res = response();

    await registeredHandler("/native/logout")(
      request({ refreshToken: "refresh-token" }),
      res,
      vi.fn(),
    );

    expect(handleLogout).toHaveBeenCalledWith({ refreshToken: "refresh-token" });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
