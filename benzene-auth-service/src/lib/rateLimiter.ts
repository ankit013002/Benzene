import rateLimit from "express-rate-limit";

/**
 * Rate limiters for authentication-related routes to prevent brute-force attacks and abuse.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many login attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for signup route to prevent abuse. Allows a maximum of 5 signup attempts per hour from the same IP address.
 */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many signup attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for resend-verification route to prevent inbox flooding. Allows a maximum of 3 resend attempts per hour from the same IP address.
 */
export const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: "Too many resend attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for password reset route to prevent abuse. Allows a maximum of 5 password reset attempts per hour from the same IP address.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many password reset attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

export const accountDeletionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many account deletion attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

// Receipt values have 256 bits of entropy, so polling can use a higher bounded
// limit than password-backed request and status checks.
export const accountDeletionReceiptLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  message: "Too many account deletion status checks, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});
