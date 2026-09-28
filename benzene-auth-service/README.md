# benzene-auth-service

Self-contained email/password authentication service for Benzene. It issues
short-lived HS256 access tokens and rotates opaque refresh tokens, backed by
PostgreSQL; no external OAuth/OIDC provider is required.

---

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript (`tsx`)
- **Framework:** Express 5
- **Database:** PostgreSQL (`pg`)
- **Auth:** JWT access tokens (HS256, 15 min) + opaque refresh tokens (7 days, SHA-256 hashed in DB)
- **Browser session transport:** `httpOnly` cookies (`session` + `refresh_token`)
- **Native session transport:** bearer access token + app-secured opaque refresh token
- **Email:** nodemailer (optional SMTP for verification + password reset)
- **Validation:** Zod
- **Security:** helmet, express-rate-limit, bcrypt (cost 12)
- **Tests:** Vitest

---

## Endpoints

Auth routes are mounted under `/api/auth`; the service health check is
available at `/api/health`.

| Method | Path                    | Rate limit      | Description                              |
|--------|-------------------------|-----------------|------------------------------------------|
| GET    | `/api/health`           | —               | Health check                             |
| POST   | `/api/auth/signup`      | 3 / hr          | Create account, send verification email  |
| POST   | `/api/auth/login`       | 5 / 15 min      | Authenticate, set browser cookies        |
| POST   | `/api/auth/logout`      | —               | Revoke refresh token, clear cookies      |
| POST   | `/api/auth/refresh`     | —               | Rotate browser authentication cookies    |
| POST   | `/api/auth/native/login` | 5 / 15 min     | Issue native bearer and refresh credentials |
| POST   | `/api/auth/native/refresh` | —             | Atomically rotate a native refresh credential |
| POST   | `/api/auth/native/logout` | —              | Revoke a native refresh credential          |
| GET    | `/api/auth/verify-email`| —               | Confirm email via link token             |
| POST   | `/api/auth/resend-verification` | 3 / hr  | Resend email verification link           |
| POST   | `/api/auth/forgot-password`    | 5 / hr  | Send password reset email                |
| POST   | `/api/auth/reset-password`     | 5 / hr  | Apply new password, invalidate all sessions |

The three native endpoints require the exact request header
`X-Benzene-Client-Kind: native-mobile`. Login accepts the normal email/password
body. Refresh and logout accept `{ "refreshToken": "…" }`. Successful login
and refresh responses use this shape:

```json
{
  "accessToken": "short-lived HS256 JWT",
  "refreshToken": "rotating opaque credential",
  "tokenType": "Bearer",
  "expiresInSeconds": 900
}
```

Through the public gateway, the corresponding paths are
`/auth/native/login`, `/auth/native/refresh`, and `/auth/native/logout`.
Native clients must call these endpoints over HTTPS and send the access token
to protected gateway routes as
`Authorization: Bearer <accessToken>` and must store the refresh credential in
Keychain or Android Keystore-backed storage. Token responses are marked
`Cache-Control: no-store`. Native refresh rotation uses the same atomic
PostgreSQL consume operation as browser refresh, so one credential cannot win
two concurrent rotations.

The browser endpoints remain cookie-only even if a native-looking header or
JSON refresh token is supplied. They never serialize access or refresh tokens
into a response body. Conversely, native endpoints do not set authentication
cookies. This split is deliberate: do not make response transport depend only
on a loosely inferred user agent.

---

## Database Schema

Run the numbered SQL migrations against the Benzene auth PostgreSQL database
before starting. Migration 002 adds the account-deletion request ledger and
blocks new sessions after a password-confirmed request.

```
credentials              — email, password_hash, email_verified
refresh_tokens           — token_hash, expires_at (7 days)
email_verification_tokens — token_hash, expires_at (24 hrs)
password_reset_tokens    — token_hash, expires_at (1 hr), used_at
account_deletion_requests — durable cleanup status; does not itself delete associated data
```

`POST /api/auth/account-deletion` requires the account email, current password,
and an idempotency key. It records one durable request, revokes refresh tokens,
and prevents later login, refresh, and password-reset completion. The response
is deliberately `cleanup_pending` with `deletionComplete: false`; no downstream
data is removed by this route. `POST /api/auth/account-deletion/status` requires
the same password and returns the persisted phase. The initial phase is
`awaiting_cleanup_operator` because there is not yet a cleanup worker. Existing
access JWTs remain usable until their 15-minute expiry because the gateway does
not check account state on every request. Do not present this foundation as
completed Apple or Google account deletion.

---

## Environment Variables

Create a `.env` file in this directory:

```env
PORT=4000
APP_ORIGIN=http://localhost:3000
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/benzene_auth

# JWT signing secret — 64 hex chars (32 bytes) or any long random string
AUTH_SECRET=

# Optional SMTP — without these settings email flows cannot deliver messages.
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM="Benzene <no-reply@benzene.local>"
```

To generate a strong `AUTH_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Getting Started

### 1. Install dependencies

```bash
npm ci
```

### 2. Run the database migration

```bash
psql "$DATABASE_URL" -f src/db/migrations/001_initial.sql
psql "$DATABASE_URL" -f src/db/migrations/002_account_deletion_requests.sql
```

### 3. Configure email delivery (optional)

Set the `SMTP_*` variables from `.env.example` to a reachable SMTP server. For
local-only development, a MailHog-compatible server may listen on port 1025;
the auth service does not start or manage that server.

### 4. Start the service

```bash
npm run dev       # development (watch mode)
npm run start     # production
```

The service runs on `http://localhost:4000` by default.

---

## Running Tests

```bash
npm test               # watch mode
npm run test:run       # single run
npm run test:coverage  # with coverage report
```

Tests cover the eight auth flows and the `tokens`, `cookies`, and `schema` lib
utilities.

---

## Docker

```bash
docker build -t benzene-auth-service .
docker run -p 4000:4000 --env-file .env benzene-auth-service
```

---

## Project Structure

```
src/
├── server.ts                  — app bootstrap and route mounting
├── db/
│   ├── index.ts               — pg Pool
│   └── migrations/
│       ├── 001_initial.sql    — initial schema
│       └── 002_account_deletion_requests.sql — deletion request ledger
├── lib/
│   ├── tokens.ts              — JWT signing/verification, opaque token generation, SHA-256 hashing
│   ├── cookies.ts             — httpOnly cookie helpers (set/clear)
│   ├── mailer.ts              — nodemailer transport, email templates
│   ├── schema.ts              — Zod validation schemas
│   └── rateLimiter.ts         — express-rate-limit instances
├── middleware/
│   ├── error-handler.ts       — Zod (400), rate limit (429), generic (500)
│   └── not-found.ts           — 404 handler
├── controller/                — request/response logic, one file per endpoint
├── routes/                    — applies rate limiter + validates + calls controller
├── services/                  — database operations split by domain
│   ├── credentials.service.ts
│   ├── refresh.service.ts
│   ├── email-verification-token.ts
│   ├── password-reset-token.service.ts
│   └── signup.service.ts
└── types/
    └── database.ts            — TypeScript types for DB rows
```
