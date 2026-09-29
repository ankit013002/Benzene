import bcrypt from "bcrypt";
import { makeOpaqueToken, hashToken } from "../lib/tokens";
import { sendVerificationEmail } from "../lib/mailer";
import { retrieveCredentialsByEmail } from "../services/credentials.service";
import { replaceVerificationTokenAtomically } from "../services/email-verification-token";

/** A password proof lets a native client resend without creating a cookie session. */
export async function resendNativeVerification(data: { email: string; password: string }): Promise<void> {
  const credentials = await retrieveCredentialsByEmail(data.email);
  if (!credentials || credentials.email_verified) return;
  const passwordMatches = await bcrypt.compare(data.password, credentials.password_hash);
  if (!passwordMatches) return;

  const rawToken = makeOpaqueToken();
  await replaceVerificationTokenAtomically(credentials.id, hashToken(rawToken));
  await sendVerificationEmail(credentials.email, rawToken);
}
