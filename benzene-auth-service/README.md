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

Native login issues credentials only after email verification. Correct
credentials for an unverified account receive a no-store `403` response with
`{ "error": "Email verification required", "emailVerified": false }` and no
tokens. The service revokes the refresh credential created by the shared login
controller before returning that response. Browser login retains its existing
cookie behavior.

The browser endpoints remain cookie-only even if a native-looking header or
JSON refresh token is supplied. They never serialize access or refresh tokens
into a response body. Conversely, native endpoints do not set authentication
cookies. This split is deliberate: do not make response transport depend only
on a loosely inferred user agent.

---

## Database Schema

Run the numbered SQL migrations against the Benzene auth PostgreSQL database
before starting. Migrations 002 and 003 add the account-deletion ledger and
retry-safe phase leases; migration 005 adds the minimal durable credential-
deletion tombstone. A password-confirmed request blocks new sessions.

```
credentials              — email, password_hash, email_verified
refresh_tokens           — token_hash, expires_at (7 days)
email_verification_tokens — token_hash, expires_at (24 hrs)
password_reset_tokens    — token_hash, expires_at (1 hr), used_at
account_deletion_requests — durable cleanup status, phase leases, retry counts
auth_account_deletion_tombstones — deletion request ID, former credential ID, deletion time
```

`POST /api/auth/account-deletion` requires the account email, current password,
and an idempotency key. It records one durable request, revokes refresh tokens,
and prevents later login, refresh, and password-reset completion. The phase
runner claims one step using a two-minute database lease, executes its handler,
then advances only if that exact lease is still current. Expired leases can be
retried; a missing handler or failed action leaves the request `blocked` at the
same phase with a five-minute retry delay. Handlers must be idempotent because
a process may stop after a downstream side effect and before saving phase
progress.

The declared order is profile, stored-object references, device data,
Vault metadata, billing, backups and logs, then `auth_credential`. The final
phase writes a tombstone containing only the deletion request ID, former
credential ID and deletion time, removes the credential and its cascading token
rows, and marks the request complete in one PostgreSQL transaction. A crash
rolls back the tombstone, credential deletion and completion receipt together,
so the same phase can be retried. A later signup may reuse the same email and
receives a new credential ID; the old deletion receipt remains attached to the
former ID. The device-data handler must
use the control plane's reference-safe garbage collection and wait for each
device acknowledgement; offline devices keep that phase incomplete, and Vault
and device metadata must remain available to deliver and acknowledge durable
deletion assignments. An optional bounded, non-overlapping scheduler executes
the `user_profile` phase through the user service's private idempotent
endpoint. When the optional control-plane URL and secret are configured, the
`stored_objects` phase calls its private adapter only after the account-deletion
request is at least 15 minutes and 60 seconds old, allowing issued access JWTs
to expire with a clock-skew margin. It then purges legacy version objects in
bounded batches and releases the matching version references; device-backed
bytes use the existing durable garbage-collection assignments and per-device
acknowledgements. The phase stays
`cleanup_pending` without an error during the token grace period because the
phase is not claimable yet. It stays blocked after an actual handler failure,
or while versions, references, or replica rows remain, so an offline device
keeps account cleanup incomplete. With no worker settings, requests stay at
`awaiting_cleanup_operator`. The state machine cannot skip a missing phase
adapter and status remains incomplete until every phase handler reports
success.
`POST /api/auth/account-deletion/status`
requires the same password and returns the persisted phase and a stable error
code. Existing access JWTs remain usable until their 15-minute expiry because
the gateway does not check account state on every request. The profile-deletion
tombstone prevents those tokens from recreating the profile, but other services
may still honor the JWT until expiry. This is still not completed Apple or
Google account deletion.

`billing_records` and `backups_and_logs` have no application-managed data
repository or deletion adapter in this version. They remain blocked by default.
An operator may enable each phase only after auditing the deployment and
confirming that it has no managed data in that category, using the exact
inventory-scoped values below. This records an explicit operator attestation;
it is not a general phase-skip switch. If billing, application-managed backups,
or account-linked application logs are introduced, remove the corresponding
attestation and add a real, idempotent deletion adapter before deploying that
system. Existing attestations must be revisited as part of each data-inventory
change. Any partial or non-exact value fails service configuration validation.

Set the profile URL, secret, and interval together to enable the profile phase;
the interval is 5–3600 seconds. The control-plane URL and secret are an
optional pair that enables the `stored_objects` phase. If omitted, the worker
still completes profile cleanup and then blocks safely at the missing storage
handler. Partial profile or control-plane configuration is rejected. In
production, every configured service URL must use HTTPS. When enabling the
control-plane phase, configure its `ACCOUNT_DELETION_INTERNAL_SECRET` to match
`ACCOUNT_DELETION_CONTROL_PLANE_SECRET`.

```ini
ACCOUNT_DELETION_USER_SERVICE_URL=http://localhost:8082/internal/account-deletion
ACCOUNT_DELETION_USER_SERVICE_SECRET=<shared 32-byte-or-longer secret>
ACCOUNT_DELETION_CONTROL_PLANE_URL=http://localhost:5000/internal/account-deletion
ACCOUNT_DELETION_CONTROL_PLANE_SECRET=<different shared 32-byte-or-longer secret>
ACCOUNT_DELETION_WORKER_INTERVAL_SECONDS=30
ACCOUNT_DELETION_BILLING_RECORDS_ABSENCE_ATTESTATION=BENZENE_V1_NO_MANAGED_BILLING_RECORDS
ACCOUNT_DELETION_BACKUPS_AND_LOGS_ABSENCE_ATTESTATION=BENZENE_V1_NO_MANAGED_ACCOUNT_BACKUPS_OR_LOGS
```

Only set the last two values when the deployment operator has verified the
absence of those managed data stores. Unset values leave their phases blocked.
The attestation values are scoped to the current Benzene inventory and must not
be carried forward automatically when a corresponding subsystem is added.

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
psql "$DATABASE_URL" -f src/db/migrations/003_account_deletion_worker_leases.sql
psql "$DATABASE_URL" -f src/db/migrations/004_account_deletion_credential_phase.sql
psql "$DATABASE_URL" -f src/db/migrations/005_account_deletion_tombstones.sql
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
│       ├── 002_account_deletion_requests.sql — deletion request ledger
│       ├── 003_account_deletion_worker_leases.sql — durable worker leases and retries
│       ├── 004_account_deletion_credential_phase.sql — adds final credential erasure phase
│       └── 005_account_deletion_tombstones.sql — retains minimal credential-deletion tombstones
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
