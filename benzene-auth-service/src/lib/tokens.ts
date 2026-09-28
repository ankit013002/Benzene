import jwt, { JwtPayload } from "jsonwebtoken";
import crypto from "crypto";

/**
 * Utility functions for token generation and hashing. This includes functions to sign JWT access tokens, create opaque refresh tokens, and hash tokens for secure storage. The signing secret is derived from the AUTH_SECRET environment variable, which can be a hex string or a UTF-8 string. The access tokens are signed with the HS256 algorithm and have a short expiration time for security.
 */
const SIGNING_SECRET = (() => {
  const RAW = process.env.AUTH_SECRET?.trim();
  if (!RAW || RAW.length < 32) {
    throw new Error(
      "AUTH_SECRET environment variable is missing or too short (minimum 32 characters required)",
    );
  }
  return /^[0-9a-f]{64}$/i.test(RAW)
    ? Buffer.from(RAW, "hex")
    : Buffer.from(RAW, "utf8");
})();

export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

/**
 * Signs a JWT access token with the provided credential ID and email.
 * The token includes the credential ID as the subject (sub), the email, and a roles array with a default role of "user".
 * The token is signed using the HS256 algorithm and has an expiration time of 15 minutes.
 *
 * @param credentialId - The unique identifier for the user's credentials, which will be included in the token's subject (sub) claim.
 * @param email - The email address of the user, which will be included in the token's payload for reference.
 * @returns A signed JWT access token as a string that can be used for authentication in the application.
 */
export function signAccessToken(credentialId: string, email: string): string {
  return jwt.sign(
    { sub: credentialId, email, roles: ["user"] },
    SIGNING_SECRET,
    { algorithm: "HS256", expiresIn: ACCESS_TOKEN_LIFETIME_SECONDS },
  );
}

/**
 * Generates an opaque refresh token.
 * @returns A randomly generated opaque token as a hexadecimal string.
 */
export function makeOpaqueToken(): string {
  return crypto.randomBytes(64).toString("hex");
}

/**
 * Hashes a raw token using SHA-256 for secure storage in the database.
 * This ensures that even if the database is compromised, the actual token values are not exposed.
 *
 * @param raw - The raw token string that needs to be hashed before storing in the database.
 * @returns A SHA-256 hash of the input token as a hexadecimal string.
 */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Verifies a JWT access token and returns the decoded payload.
 *
 * @param token - The JWT access token to verify.
 * @returns The decoded JWT payload.
 * @throws If the token is invalid or expired.
 */
export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, SIGNING_SECRET) as JwtPayload;
}
