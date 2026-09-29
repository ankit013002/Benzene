import cors from "cors";
import express from "express";
import helmet from "helmet";

import { config } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import driveNodeRouter from "./routes/driveNode.routes.js";
import filesRouter from "./routes/files.routes.js";
import foldersRouter from "./routes/folders.routes.js";
import localObjectsRouter, { localObjectsEnabled } from "./routes/localObjects.routes.js";
import permissionsRouter from "./routes/permissions.routes.js";
import agentRouter from "./modules/devices/agent.routes.js";
import devicesRouter from "./modules/devices/devices.routes.js";
import placementRouter from "./modules/placement/placement.routes.js";
import vaultsRouter from "./modules/vaults/vaults.routes.js";
import accountDeletionRouter from "./modules/accountDeletion/accountDeletion.routes.js";

export function createApp(): express.Express {
  const app = express();

  app.use(helmet());
  app.use(cors());

  // The local-object router needs the raw body, so it is mounted ahead of the
  // JSON parser rather than after it.
  if (localObjectsEnabled()) {
    app.use("/local-objects", localObjectsRouter);
  }

  // Device signatures cover the raw body, so it is captured before parsing;
  // re-serialising the parsed object would not reproduce the signed bytes.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf.toString("utf8");
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "file-service",
      storage: config().storageDriver,
    });
  });

  // Node agents: unauthenticated or device-signature authenticated. The
  // gateway routes this prefix without its session filter.
  app.use("/agent", agentRouter);
  // Private auth-service adapter; guarded by its dedicated shared secret.
  app.use("/internal/account-deletion", accountDeletionRouter);

  app.use("/vaults", vaultsRouter);
  app.use("/devices", devicesRouter);
  app.use("/placement", placementRouter);
  app.use("/drive-nodes", driveNodeRouter);
  app.use("/files", filesRouter);
  app.use("/folders", foldersRouter);
  app.use("/permissions", permissionsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
