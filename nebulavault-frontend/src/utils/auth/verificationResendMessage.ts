const ALREADY_VERIFIED_ERROR = "Email is already verified";

export function verificationResendErrorMessage(
  status: number,
  upstreamError: string | undefined,
): string {
  if (upstreamError === ALREADY_VERIFIED_ERROR) {
    return "This email is already verified. You can sign in to your Vault.";
  }

  if (status === 400 || status === 401) {
    return "Your sign-in expired. Return to sign in and try again.";
  }

  return "Unable to resend the verification email. Please try again.";
}
