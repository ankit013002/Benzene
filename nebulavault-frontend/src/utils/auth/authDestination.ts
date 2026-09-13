const AUTH_DESTINATION_ORIGIN = "https://benzene.invalid";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export function authDestination(
  emailVerified: boolean | undefined,
  requestedNext: string | null = null,
): string {
  if (emailVerified === false) return "/verify-email?status=pending";

  if (
    requestedNext === null ||
    requestedNext === "" ||
    CONTROL_CHARACTER_PATTERN.test(requestedNext) ||
    requestedNext.includes("\\")
  ) {
    return "/dashboard";
  }

  try {
    const destination = new URL(requestedNext, AUTH_DESTINATION_ORIGIN);
    if (destination.origin !== AUTH_DESTINATION_ORIGIN) return "/dashboard";

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/dashboard";
  }
}
