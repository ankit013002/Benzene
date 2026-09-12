import { Router } from "express";
import { z } from "zod";

import { requireUser } from "../../middleware/requireUser.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { enrollmentPairingThrottle } from "./enrollmentThrottle.js";
import {
  approveEnrollment,
  beginDeviceRemoval,
  listDevices,
  listPendingEnrollments,
  rejectEnrollment,
  setAllocation,
} from "./devices.service.js";

const router = Router();

router.use(requireUser);

const uuidParam = z.string().uuid("must be a UUID");

const approveSchema = z.object({
  code: z.string().min(4).max(32),
  // Nothing is contributed until the user says how much.
  allocatedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const codeSchema = z.object({ code: z.string().min(4).max(32) });

const allocationSchema = z.object({
  allocatedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw AppError.badRequest("Request validation failed", z.flattenError(result.error));
  }
  return result.data;
}

function ownerOf(req: { ownerId?: string }): string {
  if (!req.ownerId) throw AppError.unauthorized();
  return req.ownerId;
}

/*
 * Enrollment, user side. These require the gateway-verified identity.
 */

router.get(
  "/enrollments/pending/list",
  asyncHandler(async (req, res) => {
    const pending = await listPendingEnrollments(ownerOf(req));
    res.status(200).json({ data: pending });
  })
);

router.post(
  "/enrollments/approve",
  enrollmentPairingThrottle,
  asyncHandler(async (req, res) => {
    const body = parse(approveSchema, req.body);
    const device = await approveEnrollment(
      ownerOf(req),
      body.code,
      body.allocatedBytes
    );
    res.status(201).json({
      data: { id: device.id, name: device.name, status: device.status },
    });
  })
);

router.post(
  "/enrollments/reject",
  enrollmentPairingThrottle,
  asyncHandler(async (req, res) => {
    const body = parse(codeSchema, req.body);
    await rejectEnrollment(ownerOf(req), body.code);
    res.status(204).send();
  })
);

/*
 * Device management, user side.
 */

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const list = await listDevices(ownerOf(req));
    res.status(200).json({ data: list });
  })
);

router.patch(
  "/:deviceId/allocation",
  asyncHandler(async (req, res) => {
    const deviceId = parse(uuidParam, req.params["deviceId"]);
    const body = parse(allocationSchema, req.body);
    const device = await setAllocation(ownerOf(req), deviceId, body.allocatedBytes);
    res.status(200).json({ data: device });
  })
);

router.post(
  "/:deviceId/removal",
  asyncHandler(async (req, res) => {
    const deviceId = parse(uuidParam, req.params["deviceId"]);
    const device = await beginDeviceRemoval(ownerOf(req), deviceId);
    res.status(202).json({ data: device });
  })
);

export default router;
