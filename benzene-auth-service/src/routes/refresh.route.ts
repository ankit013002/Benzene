import { Router, Request, Response } from "express";
import { setAuthCookies } from "../lib/cookies";
import refreshRefreshToken from "../controller/refresh.controller";

const router = Router();

router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { accessToken, refreshToken } = await refreshRefreshToken(
      { refreshToken: req.cookies.refresh_token },
    );
    setAuthCookies(res, accessToken, refreshToken);
    return res.status(204).end();
  } catch (err) {
    if (err instanceof Error && err.name === "InvalidTokenError") {
      return res.status(401).json({ error: "Invalid refresh token" });
    }
    if (err instanceof Error && err.name === "RefreshTokenMissingError") {
      return res.status(400).json({ error: "Refresh token not provided" });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
