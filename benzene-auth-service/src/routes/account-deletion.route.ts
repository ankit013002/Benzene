import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  getAccountDeletionStatus,
  getAccountDeletionStatusByReceipt,
  requestAccountDeletion,
} from "../services/account-deletion.service";
import {
  accountDeletionRequestSchema,
  accountDeletionReceiptStatusSchema,
  accountDeletionStatusSchema,
} from "../lib/schema";
import {
  accountDeletionLimiter,
  accountDeletionReceiptLimiter,
} from "../lib/rateLimiter";

const router = Router();

function setNoStore(res: Response) {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
}

function invalidCredentials(res: Response) {
  setNoStore(res);
  return res.status(401).json({ error: "Invalid credentials" });
}

router.post(
  "/account-deletion",
  accountDeletionLimiter,
  async (req: Request, res: Response) => {
    try {
      const input = accountDeletionRequestSchema.parse(req.body);
      const result = await requestAccountDeletion(input);
      setNoStore(res);
      return res.status(result.created ? 202 : 200).json({
        requestId: result.request.id,
        receipt: result.receipt,
        status: result.request.status,
        currentPhase: result.request.current_phase,
        requestedAt: result.request.requested_at,
        deletionComplete: result.request.completed_at !== null,
        lastErrorCode: result.request.last_error_code ?? null,
        downstreamCleanupStarted:
          result.request.current_phase !== "awaiting_cleanup_operator",
        message:
          "The request is recorded. Refresh and session-renewal credentials are revoked; any already-issued access token can remain valid for up to 15 minutes. Associated data is removed only as each cleanup phase succeeds.",
      });
    } catch (err) {
      setNoStore(res);
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Validation error", details: err.issues });
      }
      if (err instanceof Error && err.name === "InvalidCredentialsError") {
        return invalidCredentials(res);
      }
      console.error(err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.post(
  "/account-deletion/receipt-status",
  accountDeletionReceiptLimiter,
  async (req: Request, res: Response) => {
    try {
      const input = accountDeletionReceiptStatusSchema.parse(req.body);
      const request = await getAccountDeletionStatusByReceipt(input);
      setNoStore(res);
      return res.status(200).json({
        requestId: request.id,
        status: request.status,
        currentPhase: request.current_phase,
        requestedAt: request.requested_at,
        updatedAt: request.updated_at,
        completedAt: request.completed_at,
        deletionComplete: request.completed_at !== null,
        downstreamCleanupStarted:
          request.current_phase !== "awaiting_cleanup_operator",
        lastErrorCode: request.last_error_code ?? null,
      });
    } catch (err) {
      setNoStore(res);
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Validation error", details: err.issues });
      }
      if (err instanceof Error && err.name === "InvalidDeletionRequestError") {
        return res.status(401).json({ error: "Deletion receipt not found" });
      }
      console.error(err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.post(
  "/account-deletion/status",
  accountDeletionLimiter,
  async (req: Request, res: Response) => {
    try {
      const input = accountDeletionStatusSchema.parse(req.body);
      const request = await getAccountDeletionStatus(input);
      setNoStore(res);
      return res.status(200).json({
        requestId: request.id,
        status: request.status,
        currentPhase: request.current_phase,
        requestedAt: request.requested_at,
        updatedAt: request.updated_at,
        completedAt: request.completed_at,
        deletionComplete: request.completed_at !== null,
        downstreamCleanupStarted:
          request.current_phase !== "awaiting_cleanup_operator",
        lastErrorCode: request.last_error_code ?? null,
      });
    } catch (err) {
      setNoStore(res);
      if (err instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: "Validation error", details: err.issues });
      }
      if (
        err instanceof Error &&
        (err.name === "InvalidCredentialsError" ||
          err.name === "InvalidDeletionRequestError")
      ) {
        return invalidCredentials(res);
      }
      console.error(err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
