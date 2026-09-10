import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, db } from "./client.js";

/**
 * Explicit production migration entrypoint. Migrations are intentionally not
 * run from server startup: multiple replicas starting together would make
 * deployment ordering and failure recovery ambiguous.
 */
async function main(): Promise<void> {
  try {
    await migrate(db(), {
      migrationsFolder: process.env["DRIZZLE_MIGRATIONS_DIR"] ?? "./drizzle",
    });
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error("[control-plane] database migration failed", error);
  process.exitCode = 1;
});
