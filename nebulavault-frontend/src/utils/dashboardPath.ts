/**
 * Encode each Vault folder name independently so URL-reserved characters stay
 * part of the name rather than changing the route's meaning.
 */
export function encodeDashboardPath(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Decode a raw dashboard path (without the `/dashboard/` prefix) back into
 * folder names. Next already decodes dynamic route params, so components that
 * receive `useParams()` values should use those values directly.
 */
export function decodeDashboardPath(path: string): string[] {
  if (!path) return [];

  return path.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      // Keep a malformed legacy URL navigable instead of crashing the shell.
      return segment;
    }
  });
}

/**
 * Normalize values returned by `useParams()` through the same codec used for
 * links. This preserves literal percent sequences in existing folder names.
 */
export function normalizeDashboardSegments(
  segments: readonly string[],
): string[] {
  return decodeDashboardPath(encodeDashboardPath(segments));
}

export function dashboardHref(segments: readonly string[]): string {
  const encodedPath = encodeDashboardPath(segments);
  return encodedPath ? `/dashboard/${encodedPath}` : "/dashboard";
}
