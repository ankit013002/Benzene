import mongoose from "mongoose";

import { config } from "../config/env.js";
import { closeDb } from "../db/client.js";
import { reconcileStorageFormats } from "../modules/placement/storageFormatReconciliation.js";
import { parseReconcileStorageFormatArgs } from "./reconcileStorageFormatsArgs.js";

async function main(): Promise<void> {
  const options = parseReconcileStorageFormatArgs(process.argv.slice(2));
  await mongoose.connect(config().mongooseUri);
  try {
    const report = await reconcileStorageFormats(options);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error("[control-plane] storage-format reconciliation failed", error);
  process.exitCode = 1;
});
