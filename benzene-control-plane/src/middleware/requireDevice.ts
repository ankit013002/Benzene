import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { config } from "../config/env.js";
import { db } from "../db/client.js";
import { deviceRequestReplays } from "../db/schema.js";
import {
  canonicalRequest,
  verifyRequestSignature,
} from "../modules/devices/deviceIdentity.js";
import { findDeviceById } from "../modules/devices/devices.service.js";
import { AppError } from "../utils/AppError.js";

/**
 * Authenticates a node agent by Ed25519 request signature.
 *
 * Unlike the user path, this does not go through the gateway's JWT: a device is
 * not a person and holds no session. It proves identity per request by signing
 * method, path, timestamp and body hash, so a captured signature cannot be
 * replayed against a different endpoint or with altered content.
 *
 * The timestamp window remains authoritative for freshness; PostgreSQL's
 * one-shot claim below closes replay of an otherwise valid deterministic
 * signature inside that window.
 */
export function requireDevice(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  void authenticateDevice(req)
    .then(() => next())
    .catch(next);
}

/** Removal polling/completion remains idempotent after the row is removed. */
export function requireDeviceForRemoval(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  void authenticateDevice(req, true)
    .then(() => next())
    .catch(next);
}

async function authenticateDevice(
  req: Request,
  allowRemoved = false
): Promise<void> {
  const deviceId = req.get("x-device-id")?.trim();
  const timestamp = req.get("x-device-timestamp")?.trim();
  const signature = req.get("x-device-signature")?.trim();

  if (!deviceId || !timestamp || !signature) {
    throw AppError.unauthorized(
      "X-Device-Id, X-Device-Timestamp and X-Device-Signature are required"
    );
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    throw AppError.unauthorized("X-Device-Timestamp must be a unix epoch in seconds");
  }

  const skewSeconds = Math.abs(Date.now() / 1000 - sentAt);
  if (skewSeconds > config().deviceClockSkewSeconds) {
    throw AppError.unauthorized("Request timestamp is outside the accepted window");
  }

  const device = await findDeviceById(deviceId);
  if (!device) throw AppError.unauthorized("Unknown device");
  if (device.status === "removed" && !allowRemoved) {
    throw AppError.unauthorized("This device has been removed from the vault");
  }

  const message = canonicalRequest({
    method: req.method,
    // originalUrl keeps the query string, which is part of what was signed.
    path: req.originalUrl,
    timestamp,
    body: req.rawBody ?? "",
  });

  if (!verifyRequestSignature({ publicKey: device.publicKey, signature, message })) {
    throw AppError.unauthorized("Invalid device signature");
  }

  await claimRequestReplay({
    deviceId: device.id,
    method: req.method,
    path: req.originalUrl,
    timestamp,
    body: req.rawBody ?? "",
    sentAt,
  });

  req.deviceId = device.id;
  req.vaultId = device.vaultId;
}

/**
 * Claims a verified request before the route handler can mutate state. The
 * unique index is the concurrency boundary: two identical requests may race,
 * but exactly one can commit the claim. Cleanup is deliberately bounded so an
 * attacker cannot turn authentication into an unbounded delete operation.
 */
async function claimRequestReplay(input: {
  deviceId: string;
  method: string;
  path: string;
  timestamp: string;
  body: string;
  sentAt: number;
}): Promise<void> {
  // The signature has already verified. Claim canonical request bytes rather
  // than base64 spelling so stripped padding or ignored whitespace cannot
  // create a second claim for the same authenticated request.
  const digest = createHash("sha256")
    .update(
      canonicalRequest({
        method: input.method,
        path: input.path,
        timestamp: input.timestamp,
        body: input.body,
      }),
      "utf8"
    )
    .digest("hex");
  const now = new Date();
  const expiresAt = new Date(
    (input.sentAt + config().deviceClockSkewSeconds) * 1000
  );

  await db().transaction(async (tx) => {
    // PostgreSQL has no portable DELETE ... LIMIT. This CTE bounds opportunistic
    // cleanup while keeping the claim and cleanup in the same transaction.
    await tx.execute(sql`
      WITH expired AS (
        SELECT id
        FROM ${deviceRequestReplays}
        WHERE device_id = ${input.deviceId}
          AND expires_at <= ${now}
        ORDER BY expires_at ASC
        LIMIT 32
      )
      DELETE FROM ${deviceRequestReplays}
      WHERE id IN (SELECT id FROM expired)
    `);

    const [claim] = await tx
      .insert(deviceRequestReplays)
      .values({
        deviceId: input.deviceId,
        requestDigest: digest,
        expiresAt,
      })
      .onConflictDoNothing({
        target: [deviceRequestReplays.deviceId, deviceRequestReplays.requestDigest],
      })
      .returning({ id: deviceRequestReplays.id });

    if (!claim) throw AppError.unauthorized("Device request has already been used");
  });
}
