import { resetPasswordSchema } from "../lib/schema";
import { hashToken } from "../lib/tokens";
import { resetPasswordAtomically } from "../services/password-reset-token.service";
import bcrypt from "bcrypt";

async function resetPassword(data: { token: string; newPassword: string }) {
  const { token, newPassword } = resetPasswordSchema.parse(data);

  const hashedParsedToken = hashToken(token);
  const hashedPassword = await bcrypt.hash(newPassword, 12);
  await resetPasswordAtomically(hashedParsedToken, hashedPassword);
}

export default resetPassword;
