export interface ReconcileStorageFormatArgs {
  apply: boolean;
}

export function parseReconcileStorageFormatArgs(args: string[]): ReconcileStorageFormatArgs {
  const allowed = new Set(["--apply", "--dry-run", "--confirm-maintenance-window"]);
  for (const arg of args) {
    if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`);
  }
  const apply = args.includes("--apply");
  if (apply && !args.includes("--confirm-maintenance-window")) {
    throw new Error("Apply requires --confirm-maintenance-window after control-plane writers are stopped");
  }
  if (args.includes("--dry-run") && apply) {
    throw new Error("Choose either --dry-run or --apply");
  }
  return { apply };
}
