import { Router } from "express";

import {
  completeUploadsHandler,
  completeDeviceUploadsHandler,
  completeEncryptedDeviceUploadsHandler,
  encryptedObjectMetadataHandler,
  downloadHandler,
  listDirectoryHandler,
  presignUploadsHandler,
  reserveDeviceUploadHandler,
  reserveEncryptedDeviceUploadHandler,
  usageHandler,
} from "../controllers/files.controller.js";
import { requireUser } from "../middleware/requireUser.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(requireUser);

router.get("/", asyncHandler(listDirectoryHandler));
router.get("/usage", asyncHandler(usageHandler));
router.post("/uploads", asyncHandler(presignUploadsHandler));
router.post("/uploads/complete", asyncHandler(completeUploadsHandler));
router.post("/uploads/device", asyncHandler(reserveDeviceUploadHandler));
router.post("/uploads/device/complete", asyncHandler(completeDeviceUploadsHandler));
router.post("/uploads/device/v1/encrypted", asyncHandler(reserveEncryptedDeviceUploadHandler));
router.post(
  "/uploads/device/v1/encrypted/complete",
  asyncHandler(completeEncryptedDeviceUploadsHandler)
);
router.get("/:nodeId/encrypted-object", asyncHandler(encryptedObjectMetadataHandler));
router.get("/:nodeId/download", asyncHandler(downloadHandler));

export default router;
