import type { ConnectionOptions } from "tls";

export type DatabaseSslConfig = false | ConnectionOptions;

/**
 * Production database connections must validate the server certificate. A
 * deployment using a private CA can provide its PEM chain explicitly.
 */
export function databaseSslConfig(
  nodeEnv = process.env.NODE_ENV,
  ca = process.env.DATABASE_SSL_CA,
): DatabaseSslConfig {
  if (nodeEnv !== "production") return false;

  const trimmedCa = ca?.trim();
  return trimmedCa ? { ca: trimmedCa, rejectUnauthorized: true } : { rejectUnauthorized: true };
}
