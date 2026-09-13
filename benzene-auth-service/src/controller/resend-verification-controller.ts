import { verifyAccessToken } from "../lib/tokens";
import { makeOpaqueToken, hashToken } from "../lib/tokens";
import { sendVerificationEmail } from "../lib/mailer";
import { retrieveCredentialsByCredentialId } from "../services/credentials.service";
import { replaceVerificationTokenAtomically } from "../services/email-verification-token";

/**
 * Resends the email verification token to the user associated with the provided session token.
 * It validates the session token, checks if the user's email is already verified, and if not,
 * it generates a new verification token, stores it in the database, and sends a new verification
 * email to the user.
 *
 * @param data - An object that may contain the session token used to identify the user for whom the verification email should be resent.
 * @throws {SessionTokenMissingError} If the session token is not provided in the input data.
 * @throws {InvalidSessionTokenError} If the provided session token is invalid or cannot be decoded.
 * @throws {EmailAlreadyVerifiedError} If the user's email associated with the session token is already verified.
 */
async function resendVerification(data: { session: string }): Promise<void> {
  const session = data.session;

  if (!session) {
    const error = new Error("Session token missing");
    error.name = "SessionTokenMissingError";
    throw error;
  }

  let decoded;
  try {
    decoded = verifyAccessToken(session);
  } catch (err) {
    const error = new Error("Invalid or expired session token");
    error.name = "InvalidSessionTokenError";
    throw error;
  }

  if (!decoded || !decoded.sub) {
    const error = new Error("Invalid session token");
    error.name = "InvalidSessionTokenError";
    throw error;
  }

  const credentialId = decoded.sub;

  const credentials = await retrieveCredentialsByCredentialId(credentialId);

  if (!credentials) {
    const error = new Error("Invalid session token");
    error.name = "InvalidSessionTokenError";
    throw error;
  }

  if (credentials.email_verified) {
    const error = new Error("Email already verified");
    error.name = "EmailAlreadyVerifiedError";
    throw error;
  }

  const rawVerificationToken = makeOpaqueToken();
  const hashedVerificationToken = hashToken(rawVerificationToken);

  await replaceVerificationTokenAtomically(credentialId, hashedVerificationToken);

  await sendVerificationEmail(credentials.email, rawVerificationToken);
}

export default resendVerification;
