import { Router, Request, Response } from "express";
import { clearAuthCookies } from "../lib/cookies";
import handleLogout from "../controller/logout.controller";

const router = Router();

router.post("/logout", async (req: Request, res: Response) => {
  let revocationFailed = false;

  try {
    await handleLogout({ refreshToken: req.cookies.refresh_token });
  } catch (err) {
    console.error("Error during logout:", err);
    revocationFailed = true;
  } finally {
    // Browser credentials must be removed even when the server cannot revoke
    // the refresh token (for example, while the database is unavailable).
    clearAuthCookies(res);
  }

  if (revocationFailed) {
    return res.status(500).json({ error: "Internal server error" });
  }

  return res.status(200).json({ message: "Logged out successfully" });
});

export default router;
