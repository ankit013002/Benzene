import { sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import { enrollmentCreationAttempts } from "../../db/schema.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Limits the unauthenticated first step of enrollment without relying on
 * process-local memory. The gateway-owned client header is preferred, while
 * direct local/dev access falls back to the immediate peer address.
 */
export function enrollmentCreationThrottle(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // The gateway's /agent route strips and rewrites this header from the
  // observed socket address. The control plane must remain private; direct
  // local/dev access falls back to the socket because no trusted gateway is
  // present to provide the header.
  const clientKey =
    req.get("x-benzene-client-ip")?.trim() || req.socket.remoteAddress || "unknown";

  void claimEnrollmentAttempt(clientKey)
    .then((allowed) => {
      if (allowed) {
        next();
        return;
      }

      res.setHeader("Retry-After", String(config().enrollmentRateLimitWindowSeconds));
      next(
        new AppError(
          429,
          "RATE_LIMITED",
          "Too many enrollment requests; please try again later"
        )
      );
    })
    .catch(next);
}

async function claimEnrollmentAttempt(clientKey: string): Promise<boolean> {
  const cfg = config();
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - cfg.enrollmentRateLimitWindowSeconds * 1000
  );

  return db().transaction(async (tx) => {
    // Keep stale peer keys from accumulating forever, while bounding cleanup
    // work performed by any one unauthenticated request.
    await tx.execute(sql`
      WITH expired AS (
        SELECT ${enrollmentCreationAttempts.clientKey}
        FROM ${enrollmentCreationAttempts}
        WHERE ${enrollmentCreationAttempts.windowStartedAt} <= ${windowStart}
        ORDER BY ${enrollmentCreationAttempts.windowStartedAt} ASC
        LIMIT 32
      )
      DELETE FROM ${enrollmentCreationAttempts}
      WHERE client_key IN (
        SELECT client_key FROM expired
      )
    `);

    const [attempt] = await tx
      .insert(enrollmentCreationAttempts)
      .values({ clientKey, windowStartedAt: now, attemptCount: 1 })
      .onConflictDoUpdate({
        target: enrollmentCreationAttempts.clientKey,
        set: {
          windowStartedAt: sql`
            CASE
              WHEN ${enrollmentCreationAttempts.windowStartedAt} <= ${windowStart}
              THEN ${now}
              ELSE ${enrollmentCreationAttempts.windowStartedAt}
            END
          `,
          // Saturating at max+1 prevents an abusive peer from overflowing the
          // integer counter while it remains over the configured limit.
          attemptCount: sql`
            CASE
              WHEN ${enrollmentCreationAttempts.windowStartedAt} <= ${windowStart}
              THEN 1
              ELSE LEAST(
                ${enrollmentCreationAttempts.attemptCount} + 1,
                ${cfg.enrollmentRateLimitMax + 1}
              )
            END
          `,
        },
      })
      .returning({ attemptCount: enrollmentCreationAttempts.attemptCount });

    if (!attempt) throw new AppError(500, "SERVER", "Could not record enrollment request");
    return attempt.attemptCount <= cfg.enrollmentRateLimitMax;
  });
}
