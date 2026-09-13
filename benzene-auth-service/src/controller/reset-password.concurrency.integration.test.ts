import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { hashToken } from "../lib/tokens";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)("password reset concurrency", () => {
  let pool: typeof import("../db").default;
  let resetPassword: typeof import("./reset-password-controller").default;
  let credentialId: string;
  const rawResetToken = "concurrent-password-reset-token";
  const firstPassword = "concurrent-reset-password-one";
  const secondPassword = "concurrent-reset-password-two";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ default: pool } = await import("../db"));
    ({ default: resetPassword } = await import("./reset-password-controller"));

    const result = await pool.query(
      `
        INSERT INTO credentials (email, password_hash, email_verified)
        VALUES ($1, $2, true)
        RETURNING id
      `,
      [`password-reset-race-${Date.now()}@example.com`, "old-password-hash"],
    );
    credentialId = result.rows[0].id as string;

    await pool.query(
      `
        INSERT INTO password_reset_tokens (credential_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '1 hour')
      `,
      [credentialId, hashToken(rawResetToken)],
    );
    await pool.query(
      `
        INSERT INTO refresh_tokens (credential_id, token_hash, expires_at)
        VALUES
          ($1, $2, now() + interval '1 hour'),
          ($1, $3, now() + interval '1 hour')
      `,
      [credentialId, hashToken("old-refresh-token-one"), hashToken("old-refresh-token-two")],
    );
  });

  afterAll(async () => {
    if (pool && credentialId) {
      await pool.query("DELETE FROM credentials WHERE id = $1", [credentialId]);
    }
    if (pool) {
      await pool.end();
    }
  });

  it("allows one reset and atomically persists its password, token use, and session revocation", async () => {
    const results = await Promise.allSettled([
      resetPassword({ token: rawResetToken, newPassword: firstPassword }),
      resetPassword({ token: rawResetToken, newPassword: secondPassword }),
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

    const persisted = await pool.query(
      `
        SELECT c.password_hash, prt.used_at
        FROM credentials c
        JOIN password_reset_tokens prt ON prt.credential_id = c.id
        WHERE c.id = $1
      `,
      [credentialId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].used_at).not.toBeNull();
    expect(persisted.rows[0].password_hash).not.toBe("old-password-hash");
    const passwordMatches = await Promise.all([
      bcrypt.compare(firstPassword, persisted.rows[0].password_hash),
      bcrypt.compare(secondPassword, persisted.rows[0].password_hash),
    ]);
    expect(passwordMatches.filter(Boolean)).toHaveLength(1);

    const refreshTokens = await pool.query(
      "SELECT id FROM refresh_tokens WHERE credential_id = $1",
      [credentialId],
    );
    expect(refreshTokens.rows).toHaveLength(0);
  });
});
