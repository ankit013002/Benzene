/**
 * The cutoff used by both device views and aggregate capacity summaries.
 * Keeping it in one pure helper prevents a stale stored status from becoming
 * an accidental second definition of liveness.
 */
export function deviceOnlineSince(
  offlineAfterMs: number,
  nowMs = Date.now()
): Date {
  return new Date(nowMs - offlineAfterMs);
}

export function deriveDeviceStatus(
  stored: string,
  lastSeenAt: Date | null,
  offlineAfterMs: number,
  nowMs = Date.now()
): string {
  if (stored === "draining" || stored === "removed" || stored === "suspected_lost") {
    return stored;
  }
  if (!lastSeenAt) return "pending";
  return lastSeenAt >= deviceOnlineSince(offlineAfterMs, nowMs) ? "online" : "offline";
}
