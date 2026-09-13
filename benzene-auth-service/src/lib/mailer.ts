import nodemailer from "nodemailer";

/**
 * Configure the nodemailer transporter using environment variables. This transporter will be used to send emails for verification and password resets.
 *
 * Environment variables:
 * - SMTP_HOST: The hostname of the SMTP server (default: "localhost")
 * - SMTP_PORT: The port number of the SMTP server (default: 1025)
 * - SMTP_SECURE: Whether to use a secure connection (true/false, default: false)
 * - SMTP_USER: The username for SMTP authentication (optional)
 * - SMTP_PASS: The password for SMTP authentication (optional)
 * - SMTP_FROM: The "from" address for outgoing emails (default: "Benzene <noreply@benzene.dev>")
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "localhost",
  port: Number(process.env.SMTP_PORT) || 1025,
  secure: process.env.SMTP_SECURE === "true",
  auth:
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
});

const FROM = process.env.SMTP_FROM || "Benzene <noreply@benzene.dev>";
const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:3000";

/**
 * Sends a verification email to the specified address with a link containing the provided token.
 * The link directs the user to the frontend application where they can verify their email address.
 *
 * @param to - The recipient's email address to which the verification email will be sent.
 * @param rawToken - The raw verification token that will be included in the verification link sent to the user.
 */
export async function sendVerificationEmail(
  to: string,
  rawToken: string,
): Promise<void> {
  const link = `${APP_ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
  await transporter.sendMail({
    from: FROM,
    to,
    subject: "Verify your Benzene email",
    html: `
      <p>Welcome to Benzene!</p>
      <p>Click the link below to verify your email:</p>
      <a href="${link}">${link}</a>
      <p>This link expires in 24 hours.</p>
    `,
  });
}

/**
 * Sends a password reset email to the specified address with a link containing the provided token.
 *
 * @param to - The recipient's email address to which the password reset email will be sent.
 * @param rawToken - The raw password reset token that will be included in the reset link sent to the user.
 */
export async function sendPasswordResetEmail(
  to: string,
  rawToken: string,
): Promise<void> {
  const link = `${APP_ORIGIN}/reset-password?token=${rawToken}`;
  await transporter.sendMail({
    from: FROM,
    to,
    subject: "Reset your Benzene password",
    html: `
      <p>Click the link below to reset your password:</p>
      <a href="${link}">${link}</a>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}
