import { describe, expect, it } from "vitest";

import { parseReconcileStorageFormatArgs } from "./reconcileStorageFormatsArgs.js";

describe("storage-format reconciliation CLI arguments", () => {
  it("defaults to dry-run", () => {
    expect(parseReconcileStorageFormatArgs([])).toEqual({ apply: false });
  });

  it("rejects apply without the maintenance-window confirmation", () => {
    expect(() => parseReconcileStorageFormatArgs(["--apply"]))
      .toThrow("--confirm-maintenance-window");
  });

  it("rejects apply combined with dry-run", () => {
    expect(() => parseReconcileStorageFormatArgs([
      "--apply",
      "--confirm-maintenance-window",
      "--dry-run",
    ])).toThrow("Choose either --dry-run or --apply");
  });

  it("rejects unknown arguments", () => {
    expect(() => parseReconcileStorageFormatArgs(["--force"]))
      .toThrow("Unknown argument: --force");
  });
});
