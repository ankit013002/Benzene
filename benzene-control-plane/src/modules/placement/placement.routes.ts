import { Router } from "express";
import { z } from "zod";

import { PROTECTION_MODES } from "../../db/schema.js";
import { requireUser } from "../../middleware/requireUser.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  decidePlacement,
  getObjectProtection,
  getPolicy,
  getVaultProtection,
  listUnderProtectedObjects,
  reservePlacement,
  setPolicy,
} from "./placement.service.js";
import { planDownload, planUpload } from "./uploadTargets.service.js";

const router = Router();

router.use(requireUser);

const objectHash = z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 hex digest");

const policySchema = z.object({
  mode: z.enum(PROTECTION_MODES),
  cloudProtection: z.boolean().optional(),
});

const decideSchema = z.object({
  objectHash,
  sizeBytes: z.number().int().nonnegative(),
});

const reserveSchema = z.object({
  objectHash,
  sizeBytes: z.number().int().nonnegative(),
  deviceIds: z.array(z.string().uuid()).min(1).max(10),
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

router.get(
  "/policy",
  asyncHandler(async (req, res) => {
    res.status(200).json({ data: await getPolicy(ownerOf(req)) });
  })
);

router.put(
  "/policy",
  asyncHandler(async (req, res) => {
    const body = parse(policySchema, req.body);
    res.status(200).json({ data: await setPolicy(ownerOf(req), body) });
  })
);

/** Asks where an object should go, without committing to it. */
router.post(
  "/decide",
  asyncHandler(async (req, res) => {
    const body = parse(decideSchema, req.body);
    res.status(200).json({ data: await decidePlacement(ownerOf(req), body) });
  })
);

/** Reserves the chosen devices before any bytes move. */
router.post(
  "/reserve",
  asyncHandler(async (req, res) => {
    const body = parse(reserveSchema, req.body);
    const reserved = await reservePlacement(ownerOf(req), body, { requireReachable: true });
    res.status(201).json({ data: { reserved } });
  })
);

router.post(
  "/confirm",
  asyncHandler(async (_req, _res) => {
    // Healthy status is evidence from the device, not a browser assertion.
    throw new AppError(
      410,
      "DEVICE_CONFIRMATION_REQUIRED",
      "Replica confirmation is reported by the device after it stores the object"
    );
  })
);

/**
 * Where to PUT an object, and with what authority. The browser sends the bytes
 * to the devices named here; they never pass through the control plane.
 */
router.post(
  "/upload-targets",
  asyncHandler(async (req, res) => {
    const body = parse(decideSchema, req.body);
    res.status(200).json({ data: await planUpload(ownerOf(req), body) });
  })
);

/** Devices that hold an object, with read authorisation for each. */
router.get(
  "/download-targets/:objectHash",
  asyncHandler(async (req, res) => {
    const hash = parse(objectHash, req.params["objectHash"]);
    res.status(200).json({ data: { targets: await planDownload(ownerOf(req), hash) } });
  })
);

router.get(
  "/protection",
  asyncHandler(async (req, res) => {
    res.status(200).json({ data: await getVaultProtection(ownerOf(req)) });
  })
);

router.get(
  "/protection/under-protected",
  asyncHandler(async (req, res) => {
    res.status(200).json({ data: await listUnderProtectedObjects(ownerOf(req)) });
  })
);

router.get(
  "/protection/:objectHash",
  asyncHandler(async (req, res) => {
    const hash = parse(objectHash, req.params["objectHash"]);
    res.status(200).json({ data: await getObjectProtection(ownerOf(req), hash) });
  })
);

export default router;
