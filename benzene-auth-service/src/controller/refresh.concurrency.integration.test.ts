import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../lib/tokens";

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)("refresh token rotation concurrency", () => {
  let pool: typeof import("../db").default;
  let refreshRefreshToken: typeof import("./refresh.controller").default;
  let credentialId: string;
  const rawRefreshToken = "concurrent-refresh-token";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ default: pool } = await import("../db"));
    ({ default: refreshRefreshToken } = await import("./refresh.controller"));

    const result = await pool.query(
      `
        INSERT INTO credentials (email, password_hash, email_verified)
        VALUES ($1, $2, true)
        RETURNING id
      `,
      [`refresh-race-${Date.now()}@example.com`, "unused-password-hash"],
    );
    credentialId = result.rows[0].id as string;
    await pool.query(
      `
        INSERT INTO refresh_tokens (credential_id, token_hash, expires_at)
        VALUES ($1, $2, now() + interval '1 hour')
      `,
      [credentialId, hashToken(rawRefreshToken)],
    );
  });

  afterAll(async () => {
    if (pool && credentialId) {
      await pool.query("DELETE FROM credentials WHERE id = $1", [credentialId]);
      await pool.end();
    }
  });

  it("allows one concurrent refresh and persists only its replacement", async () => {
    const results = await Promise.allSettled([
      refreshRefreshToken({ refreshToken: rawRefreshToken }),
      refreshRefreshToken({ refreshToken: rawRefreshToken }),
    ]);

    const successes = results.filter(
      (result): result is PromiseFulfilledResult<{
        accessToken: string;
        refreshToken: string;
      }> => result.status === "fulfilled",
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ name: "InvalidTokenError" });

    const persisted = await pool.query(
      `
        SELECT token_hash
        FROM refresh_tokens
        WHERE credential_id = $1
      `,
      [credentialId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].token_hash).toBe(
      hashToken(successes[0].value.refreshToken),
    );
  });
});
