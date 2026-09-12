import { sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { config } from "../../config/env.js";
import { db } from "../../db/client.js";
import { enrollmentRateLimitAttempts } from "../../db/schema.js";
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

  const cfg = config();
  runThrottle(
    `peer:${clientKey}`,
    "peer:",
    {
      max: cfg.enrollmentRateLimitMax,
      windowSeconds: cfg.enrollmentRateLimitWindowSeconds,
    },
    res,
    next
  );
}

/** Limits pairing-code guesses across both approval and rejection endpoints. */
export function enrollmentPairingThrottle(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ownerId = req.ownerId?.trim();
  if (!ownerId) {
    next(AppError.unauthorized("Missing X-User-Id header from gateway"));
    return;
  }

  const cfg = config();
  runThrottle(
    `owner:${ownerId}`,
    "owner:",
    {
      max: cfg.enrollmentPairingRateLimitMax,
      windowSeconds: cfg.enrollmentPairingRateLimitWindowSeconds,
    },
    res,
    next
  );
}

function runThrottle(
  bucketKey: string,
  bucketPrefix: string,
  limit: RateLimit,
  res: Response,
  next: NextFunction
): void {
  void claimEnrollmentAttempt(bucketKey, bucketPrefix, limit)
    .then((allowed) => {
      if (allowed) {
        next();
        return;
      }

      res.setHeader("Retry-After", String(limit.windowSeconds));
      next(
        new AppError(
          429,
          "RATE_LIMITED",
          "Too many enrollment attempts; please try again later"
        )
      );
    })
    .catch(next);
}

interface RateLimit {
  max: number;
  windowSeconds: number;
}

/** Claims one namespaced enrollment bucket in one transaction. */
async function claimEnrollmentAttempt(
  bucketKey: string,
  bucketPrefix: string,
  limit: RateLimit
): Promise<boolean> {
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - limit.windowSeconds * 1000
  );

  return db().transaction(async (tx) => {
    // Keep stale keys from accumulating forever, while bounding cleanup work
    // performed by any one unauthenticated or authenticated request.
    await tx.execute(sql`
      WITH expired AS (
        SELECT ${enrollmentRateLimitAttempts.clientKey}
        FROM ${enrollmentRateLimitAttempts}
        WHERE left(
          ${enrollmentRateLimitAttempts.clientKey},
          ${bucketPrefix.length}
        ) = ${bucketPrefix}
          AND ${enrollmentRateLimitAttempts.windowStartedAt} <= ${windowStart}
        ORDER BY ${enrollmentRateLimitAttempts.windowStartedAt} ASC
        LIMIT 32
      )
      DELETE FROM ${enrollmentRateLimitAttempts}
      WHERE client_key IN (
        SELECT client_key FROM expired
      )
    `);

    const [attempt] = await tx
      .insert(enrollmentRateLimitAttempts)
      .values({ clientKey: bucketKey, windowStartedAt: now, attemptCount: 1 })
      .onConflictDoUpdate({
        target: enrollmentRateLimitAttempts.clientKey,
        set: {
          windowStartedAt: sql`
            CASE
              WHEN ${enrollmentRateLimitAttempts.windowStartedAt} <= ${windowStart}
              THEN ${now}
              ELSE ${enrollmentRateLimitAttempts.windowStartedAt}
            END
          `,
          // Saturating at max+1 prevents an abusive caller from overflowing
          // the integer counter while it remains over the configured limit.
          attemptCount: sql`
            CASE
              WHEN ${enrollmentRateLimitAttempts.windowStartedAt} <= ${windowStart}
              THEN 1
              ELSE LEAST(
                ${enrollmentRateLimitAttempts.attemptCount} + 1,
                ${limit.max + 1}
              )
            END
          `,
        },
      })
      .returning({ attemptCount: enrollmentRateLimitAttempts.attemptCount });

    if (!attempt) throw new AppError(500, "SERVER", "Could not record enrollment attempt");
    return attempt.attemptCount <= limit.max;
  });
}
