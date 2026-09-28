import { Router, type Request, type Response } from "express";
import { z } from "zod";
import loginController from "../controller/login.controller";
import handleLogout from "../controller/logout.controller";
import refreshRefreshToken from "../controller/refresh.controller";
import {
  isNativeMobileRequest,
  NATIVE_CLIENT_KIND,
  NATIVE_CLIENT_KIND_HEADER,
  setNativeTokenResponseHeaders,
} from "../lib/native-client";
import { ACCESS_TOKEN_LIFETIME_SECONDS } from "../lib/tokens";
import { loginLimiter } from "../lib/rateLimiter";
import { loginSchema } from "../lib/schema";

const router = Router();

const refreshTokenSchema = z
  .object({ refreshToken: z.string().min(1, "Refresh token is required") })
  .strict();

function requireNativeMobile(req: Request, res: Response): boolean {
  if (isNativeMobileRequest(req)) return true;

  res.status(400).json({
    error: `${NATIVE_CLIENT_KIND_HEADER}: ${NATIVE_CLIENT_KIND} is required`,
  });
  return false;
}

function tokenResponse(accessToken: string, refreshToken: string) {
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer" as const,
    expiresInSeconds: ACCESS_TOKEN_LIFETIME_SECONDS,
  };
}

router.post(
  "/native/login",
  loginLimiter,
  async (req: Request, res: Response) => {
    if (!requireNativeMobile(req, res)) return;

    try {
      const data = loginSchema.parse(req.body);
      const { accessToken, refreshToken, emailVerified } =
        await loginController(data);
      setNativeTokenResponseHeaders(res);
      return res.status(200).json({
        ...tokenResponse(accessToken, refreshToken),
        emailVerified,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Validation error", details: err.issues });
      }
      if (err instanceof Error && err.name === "InvalidCredentialsError") {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      console.error(err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.post("/native/refresh", async (req: Request, res: Response) => {
  if (!requireNativeMobile(req, res)) return;

  try {
    const { refreshToken: oldRefreshToken } = refreshTokenSchema.parse(req.body);
    const { accessToken, refreshToken } = await refreshRefreshToken({
      refreshToken: oldRefreshToken,
    });
    setNativeTokenResponseHeaders(res);
    return res.status(200).json(tokenResponse(accessToken, refreshToken));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Validation error", details: err.issues });
    }
    if (err instanceof Error && err.name === "InvalidTokenError") {
      return res.status(401).json({ error: "Invalid refresh token" });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/native/logout", async (req: Request, res: Response) => {
  if (!requireNativeMobile(req, res)) return;

  try {
    const { refreshToken } = refreshTokenSchema.parse(req.body);
    await handleLogout({ refreshToken });
    return res.status(200).json({ message: "Logged out successfully" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Validation error", details: err.issues });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
