import { sql } from "drizzle-orm";
import mongoose from "mongoose";

import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { closeDb, db } from "./db/client.js";
import { startOutageScheduler } from "./modules/devices/outageScheduler.js";

async function main(): Promise<void> {
  const cfg = config();

  // Fail fast on an unreachable control-plane database rather than surfacing
  // it as a 500 on the first request that touches a vault.
  await db().execute(sql`select 1`);
  console.log("[control-plane] connected to PostgreSQL");

  await mongoose.connect(cfg.mongooseUri);
  console.log("[control-plane] connected to file metadata DB");

  const app = createApp();
  const server = app.listen(cfg.port, () => {
    console.log(
      `[control-plane] listening on :${cfg.port} (storage: ${cfg.storageDriver})`
    );
  });
  const outageScheduler = startOutageScheduler({
    intervalSeconds: cfg.deviceOutageSweepIntervalSeconds,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[control-plane] ${signal} received, shutting down`);
    await outageScheduler.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await mongoose.disconnect();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").catch((error: unknown) => {
      console.error("[control-plane] shutdown failed:", error);
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT").catch((error: unknown) => {
      console.error("[control-plane] shutdown failed:", error);
      process.exit(1);
    });
  });
}

main().catch((err: unknown) => {
  console.error("[control-plane] failed to start:", err);
  process.exit(1);
});
