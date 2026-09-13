export function authDestination(
  emailVerified: boolean | undefined,
  requestedNext: string | null = null,
): string {
  if (emailVerified === false) return "/verify-email?status=pending";

  return requestedNext?.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/dashboard";
}
