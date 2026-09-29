import { timingSafeEqual } from "node:crypto";
import { Router } from "express";

import { config } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { removeAccountDeviceData } from "./deviceData.service.js";
import { purgeAccountStoredObjects } from "./storedObjects.service.js";

const router = Router();

router.post(
  "/:ownerId/device-data",
  asyncHandler(async (req, res) => {
    const secret = config().accountDeletionInternalSecret;
    if (!secret) {
      res.status(503).json({ error: "Account deletion adapter is not configured" });
      return;
    }

    const provided = req.get("X-Benzene-Internal-Secret") ?? "";
    const expectedBytes = Buffer.from(secret, "utf8");
    const providedBytes = Buffer.from(provided, "utf8");
    if (
      expectedBytes.length !== providedBytes.length ||
      !timingSafeEqual(expectedBytes, providedBytes)
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const ownerIdParam = req.params.ownerId;
    const ownerId = typeof ownerIdParam === "string" ? ownerIdParam : "";
    if (!ownerId || ownerId.length > 200) {
      res.status(400).json({ error: "Invalid account subject" });
      return;
    }

    const progress = await removeAccountDeviceData(ownerId);
    res.status(200).json(progress);
  })
);

router.post(
  "/:ownerId/stored-objects",
  asyncHandler(async (req, res) => {
    const secret = config().accountDeletionInternalSecret;
    if (!secret) {
      res.status(503).json({ error: "Account deletion adapter is not configured" });
      return;
    }

    const provided = req.get("X-Benzene-Internal-Secret") ?? "";
    const expectedBytes = Buffer.from(secret, "utf8");
    const providedBytes = Buffer.from(provided, "utf8");
    if (
      expectedBytes.length !== providedBytes.length ||
      !timingSafeEqual(expectedBytes, providedBytes)
    ) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const ownerIdParam = req.params.ownerId;
    const ownerId = typeof ownerIdParam === "string" ? ownerIdParam : "";
    if (!ownerId || ownerId.length > 200) {
      res.status(400).json({ error: "Invalid account subject" });
      return;
    }

    const progress = await purgeAccountStoredObjects(ownerId);
    res.status(200).json(progress);
  })
);

export default router;
