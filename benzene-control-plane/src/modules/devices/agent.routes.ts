import { Router } from "express";
import { z } from "zod";

import { PLATFORMS } from "../../db/schema.js";
import {
  requireDevice,
  requireDeviceForRemoval,
} from "../../middleware/requireDevice.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { confirmReplicaForDevice } from "../placement/placement.service.js";
import {
  pollRepairForDevice,
  reportRepairSourceFailure,
} from "../placement/repair.service.js";
import { transferPublicKey } from "../placement/uploadTargets.service.js";
import {
  getEnrollmentStatus,
  completeDeviceRemoval,
  pollDeviceRemoval,
  recordHeartbeat,
  requestEnrollment,
} from "./devices.service.js";
import { enrollmentCreationThrottle } from "./enrollmentThrottle.js";

/**
 * The node agent API.
 *
 * Kept under its own prefix rather than mixed into /devices because the two
 * have different callers and different authentication: everything here is
 * either unauthenticated (a machine mid-enrollment holds no credentials) or
 * authenticated by device signature, never by a user session. Separating them
 * lets the gateway apply its session filter to one prefix and not the other,
 * instead of carving exceptions out of overlapping paths.
 */
const router = Router();

const enrollmentRequestSchema = z.object({
  publicKey: z.string().min(1).max(1024),
  deviceName: z.string().min(1).max(120),
  platform: z.enum(PLATFORMS).default("other"),
});

const heartbeatSchema = z.object({
  usedBytes: z.number().int().nonnegative().optional(),
  availableBytes: z.number().int().nonnegative().optional(),
  appVersion: z.string().max(40).optional(),
  advertisedUrl: z.string().url().max(512).optional(),
});

const possessionSchema = z.object({
  objectHash: z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 hex digest"),
  sizeBytes: z.number().int().nonnegative(),
});

const repairFailureSchema = z.object({
  objectHash: z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 hex digest"),
  sourceDeviceId: z.string().uuid(),
  repairAssignmentId: z.string().uuid(),
  reason: z.literal("integrity"),
});

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw AppError.badRequest("Request validation failed", z.flattenError(result.error));
  }
  return result.data;
}

router.post(
  "/enrollments",
  enrollmentCreationThrottle,
  asyncHandler(async (req, res) => {
    const enrollment = await requestEnrollment(parse(enrollmentRequestSchema, req.body));
    res.status(201).json({ data: enrollment });
  })
);

router.get(
  "/enrollments/:enrollmentId",
  asyncHandler(async (req, res) => {
    const enrollmentId = parse(z.string().uuid(), req.params["enrollmentId"]);
    const publicKey = req.query["publicKey"];
    if (typeof publicKey !== "string" || publicKey === "") {
      throw AppError.badRequest("publicKey query parameter is required");
    }
    const status = await getEnrollmentStatus(enrollmentId, publicKey);

    // Once approved, the device needs the control plane's public key so it can
    // verify the transfer grants it will be handed. Sent only on success, so a
    // pending or rejected enrollment reveals nothing.
    const controlPlanePublicKey =
      status.status === "consumed" ? safeTransferPublicKey() : undefined;

    res.status(200).json({
      data: { ...status, ...(controlPlanePublicKey ? { controlPlanePublicKey } : {}) },
    });
  })
);

router.post(
  "/heartbeat",
  requireDevice,
  asyncHandler(async (req, res) => {
    const body = parse(heartbeatSchema, req.body);
    if (!req.deviceId) throw AppError.unauthorized();
    res.status(200).json({ data: await recordHeartbeat(req.deviceId, body) });
  })
);

/**
 * A node calls this only after its transfer server has accepted and
 * hash-validated an object. The device signature is the authority here; a
 * browser cannot promote a reservation by claiming that its PUT succeeded.
 */
router.post(
  "/possession",
  requireDevice,
  asyncHandler(async (req, res) => {
    const body = parse(possessionSchema, req.body);
    if (!req.deviceId) throw AppError.unauthorized();
    res.status(200).json({
      data: await confirmReplicaForDevice(req.deviceId, body),
    });
  })
);

/** Returns at most one source assignment for this authenticated target node. */
router.get(
  "/repair",
  requireDevice,
  asyncHandler(async (req, res) => {
    if (!req.deviceId) throw AppError.unauthorized();
    res.status(200).json({ data: await pollRepairForDevice(req.deviceId) });
  })
);

/** Lets a target quarantine a source whose signed transfer failed hash validation. */
router.post(
  "/repair-failure",
  requireDevice,
  asyncHandler(async (req, res) => {
    const body = parse(repairFailureSchema, req.body);
    if (!req.deviceId) throw AppError.unauthorized();
    res.status(200).json({
      data: await reportRepairSourceFailure(req.deviceId, body),
    });
  })
);

/** A draining node may poll this signed endpoint after every heartbeat. */
router.get(
  "/removal",
  requireDeviceForRemoval,
  asyncHandler(async (req, res) => {
    if (!req.deviceId) throw AppError.unauthorized();
    res.status(200).json({ data: await pollDeviceRemoval(req.deviceId) });
  })
);

/** Completes the erase handshake; retries are safe after removal. */
router.post(
  "/removal/complete",
  requireDeviceForRemoval,
  asyncHandler(async (req, res) => {
    if (!req.deviceId) throw AppError.unauthorized();
    res.status(200).json({ data: await completeDeviceRemoval(req.deviceId) });
  })
);

/**
 * A deployment without a signing key configured can still enroll devices; they
 * simply cannot be given transfer authority until one exists.
 */
function safeTransferPublicKey(): string | undefined {
  try {
    return transferPublicKey();
  } catch {
    return undefined;
  }
}

export default router;
