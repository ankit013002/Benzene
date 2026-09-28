import { hashToken, makeOpaqueToken, signAccessToken } from "../lib/tokens";
import { retrieveCredentialsByEmail } from "../services/credentials.service";
import bcrypt from "bcrypt";
import { createRefreshToken } from "../services/refresh.service";

/**
 * Handles user login by validating credentials, generating access and refresh tokens,
 * and returning them along with the email verification status.
 * If the credentials are invalid, it throws an error indicating that the login attempt was unsuccessful.
 *
 * @param data - An object containing the user's email and password for authentication.
 * @returns An object containing the access token, refresh token, and email verification status.
 * @throws {InvalidCredentialsError} If the email does not exist or the password is incorrect.
 */
async function loginController(data: { email: string; password: string }) {
  const { email, password } = data;

  const credentials = await retrieveCredentialsByEmail(email);

  if (!credentials) {
    const error = new Error("Invalid credentials");
    error.name = "InvalidCredentialsError";
    throw error;
  }

  if (credentials.account_status === "deletion_requested") {
    const error = new Error("Invalid credentials");
    error.name = "InvalidCredentialsError";
    throw error;
  }

  const isPasswordValid = await bcrypt.compare(
    password,
    credentials.password_hash || "",
  );

  if (!isPasswordValid) {
    const error = new Error("Invalid credentials");
    error.name = "InvalidCredentialsError";
    throw error;
  }

  const accessToken = signAccessToken(credentials.id, email);

  const rawRefreshToken = makeOpaqueToken();
  const hashedRefreshToken = hashToken(rawRefreshToken);

  await createRefreshToken(
    credentials.id,
    hashedRefreshToken,
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  );

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    emailVerified: credentials.email_verified,
  };
}

export default loginController;
