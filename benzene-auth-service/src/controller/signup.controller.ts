import { sendVerificationEmail } from "../lib/mailer";
import { hashToken, makeOpaqueToken, signAccessToken } from "../lib/tokens";
import {
  deleteCredentialsById,
  retrieveCredentialsByEmail,
} from "../services/credentials.service";
import { createVerificationToken } from "../services/email-verification-token";
import { createRefreshToken } from "../services/refresh.service";
import { createCredentials } from "../services/signup.service";
import bcrypt from "bcrypt";

/**
 * Creates a new user account, sends a verification email, and returns the access and refresh tokens.
 *
 * @param data - An object containing the user's email, password for account creation.
 * @returns An object containing the access token and refresh token for the newly created user.
 * @throws {UserExistsError} If a user with the provided email already exists in the database.
 * @throws {Error} If there is an issue during user creation, token generation, or email sending.
 */
type SignupData = { email: string; password: string };
type SignupSession = { accessToken: string; refreshToken: string };

function createUser(data: SignupData, options: { issueSession: false }): Promise<void>;
function createUser(data: SignupData, options?: { issueSession?: true }): Promise<SignupSession>;
async function createUser(data: SignupData, options: { issueSession?: boolean } = {}): Promise<void | SignupSession> {
  const { email: rawEmail, password } = data;
  const email = rawEmail.toLowerCase().trim();

  const credentialsExist = await retrieveCredentialsByEmail(email);

  if (credentialsExist) {
    const error = new Error("User with this email already exists");
    error.name = "UserExistsError";
    throw error;
  }

  const saltRounds = 12;
  const hashedPassword = await bcrypt.hash(password, saltRounds);

  const credentials = await createCredentials(email, hashedPassword);

  if (!credentials) {
    const error = new Error("Failed to create user credentials");
    error.name = "UserCreationError";
    throw error;
  }

  try {
    const rawToken = makeOpaqueToken();
    const hashedToken = hashToken(rawToken);

    await createVerificationToken(credentials.id, hashedToken);

    if (options.issueSession === false) {
      await sendVerificationEmail(email, rawToken);
      return;
    }

    const rawRefreshToken = makeOpaqueToken();
    const hashedRefreshToken = hashToken(rawRefreshToken);
    await createRefreshToken(credentials.id, hashedRefreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    const accessToken = signAccessToken(credentials.id, email);
    await sendVerificationEmail(email, rawToken);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
    };
  } catch (err) {
    await deleteCredentialsById(credentials.id);
    throw err;
  }
}

export default createUser;
