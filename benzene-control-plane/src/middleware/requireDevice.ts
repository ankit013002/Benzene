import type { NextFunction, Request, Response } from "express";

import { config } from "../config/env.js";
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
 * The timestamp window bounds replay of an identical request. Closing that gap
 * completely needs a nonce store, which is worth adding before devices are
 * reachable from the public internet.
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

  req.deviceId = device.id;
  req.vaultId = device.vaultId;
}
