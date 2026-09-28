import { sendPasswordResetEmail } from "../lib/mailer";
import { forgotPasswordSchema } from "../lib/schema";
import { hashToken, makeOpaqueToken } from "../lib/tokens";
import { retrieveCredentialsByEmail } from "../services/credentials.service";
import {
  createPasswordResetToken,
  deletePasswordResetToken,
} from "../services/password-reset-token.service";

async function forgotPassword(data: { email: string }) {
  const parsedEmail = forgotPasswordSchema.parse(data).email;

  const credential = await retrieveCredentialsByEmail(parsedEmail);

  if (!credential) {
    // Don't reveal whether the email exists or not to prevent user enumeration attacks
    return;
  }

  if (credential.account_status === "deletion_requested") return;

  await deletePasswordResetToken(credential.id);

  const rawResetToken = makeOpaqueToken();
  const hashedResetToken = hashToken(rawResetToken);

  const created = await createPasswordResetToken(credential.id, hashedResetToken);
  if (!created) return;

  try {
    await sendPasswordResetEmail(credential.email, rawResetToken);
  } catch (err) {
    console.error("Failed to send password reset email:", err);
    // Don't reveal whether the email was sent successfully or not to prevent user enumeration attacks
    return;
  }
}

export default forgotPassword;
