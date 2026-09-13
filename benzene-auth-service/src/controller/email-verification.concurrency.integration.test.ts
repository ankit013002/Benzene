import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../lib/tokens";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)("email verification concurrency", () => {
  let pool: typeof import("../db").default;
  let handleVerifyEmail: typeof import("./verify-email.controller").handleVerifyEmail;
  let replaceVerificationTokenAtomically: typeof import("../services/email-verification-token").replaceVerificationTokenAtomically;
  let credentialId: string;
  const firstRawToken = "concurrent-email-verification-token-one";
  const secondRawToken = "concurrent-email-verification-token-two";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ default: pool } = await import("../db"));
    ({ handleVerifyEmail } = await import("./verify-email.controller"));
    ({ replaceVerificationTokenAtomically } = await import(
      "../services/email-verification-token"
    ));

    const result = await pool.query(
      `
        INSERT INTO credentials (email, password_hash, email_verified)
        VALUES ($1, $2, false)
        RETURNING id
      `,
      [`email-verification-race-${Date.now()}@example.com`, "unused-password-hash"],
    );
    credentialId = result.rows[0].id as string;
  });

  afterAll(async () => {
    if (pool && credentialId) {
      await pool.query("DELETE FROM credentials WHERE id = $1", [credentialId]);
    }
    if (pool) await pool.end();
  });

  it("serializes concurrent replacements so only one intended token remains", async () => {
    await pool.query(
      "DELETE FROM email_verification_tokens WHERE credential_id = $1",
      [credentialId],
    );
    const oldHash = hashToken("replacement-token-old");
    await pool.query(
      `
        INSERT INTO email_verification_tokens (credential_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '1 day')
      `,
      [credentialId, oldHash],
    );

    const firstHash = hashToken("replacement-token-one");
    const secondHash = hashToken("replacement-token-two");

    const results = await Promise.allSettled([
      replaceVerificationTokenAtomically(credentialId, firstHash),
      replaceVerificationTokenAtomically(credentialId, secondHash),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const persisted = await pool.query(
      `
        SELECT token_hash
        FROM email_verification_tokens
        WHERE credential_id = $1
      `,
      [credentialId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect([firstHash, secondHash]).toContain(persisted.rows[0].token_hash);
    expect(persisted.rows[0].token_hash).not.toBe(oldHash);
  });

  it("allows one concurrent legacy-token verification and leaves no tokens", async () => {
    await pool.query(
      "DELETE FROM email_verification_tokens WHERE credential_id = $1",
      [credentialId],
    );
    await pool.query(
      "UPDATE credentials SET email_verified = false WHERE id = $1",
      [credentialId],
    );
    await pool.query(
      `
        INSERT INTO email_verification_tokens (credential_id, token_hash, expires_at)
        VALUES
          ($1, $2, now() + interval '1 day'),
          ($1, $3, now() + interval '1 day')
      `,
      [credentialId, hashToken(firstRawToken), hashToken(secondRawToken)],
    );

    const results = await Promise.allSettled([
      handleVerifyEmail(firstRawToken),
      handleVerifyEmail(secondRawToken),
    ]);
    const successes = results.filter(
      (result): result is PromiseFulfilledResult<void> => result.status === "fulfilled",
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ name: "InvalidTokenError" });

    const persistedCredential = await pool.query(
      "SELECT email_verified FROM credentials WHERE id = $1",
      [credentialId],
    );
    expect(persistedCredential.rows[0]?.email_verified).toBe(true);
    const persistedTokens = await pool.query(
      "SELECT id FROM email_verification_tokens WHERE credential_id = $1",
      [credentialId],
    );
    expect(persistedTokens.rows).toHaveLength(0);
  });
});
