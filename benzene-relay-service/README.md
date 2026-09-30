# Benzene relay service

This package provides the opaque WebSocket byte-forwarding transport for the
encrypted-object data plane. Mobile downloads remain direct-first, then may ask
the control plane for complementary client/node tickets; the selected node
claims its durable assignment and produces the encrypted object through this
relay. Upload, repair and ordinary direct reads do not use it. The wired path
has package and real-database integration coverage, but no production relay has
been deployed and no live remote client-to-device journey has been verified.

The relay does not accept filenames, `objectId`, plaintext size, encryption
metadata, or Vault keys. A signed scope contains only `storageHash` (the
encrypted object's physical byte identity), device, operation, role, expiry,
session, ticket ID, and a maximum byte count. The relay forwards binary frames
without parsing their contents. Consequently, the trusted scope issuer and
clients must ensure those bytes are ciphertext; the relay cannot determine
whether arbitrary binary data is encrypted. Clients and storage nodes remain
responsible for verifying the final ciphertext hash.

## Protocol

Clients connect to `WSS /relay/{sessionId}`. The path contains only the opaque
session ID, never the ticket. The first WebSocket frame must be a small text
JSON message with exactly `type` and `ticket` fields:

```json
{"type":"authenticate","ticket":"<Ed25519-signed relay scope>"}
```

Signature and canonical base64url validation happen before payload parsing.
The scope schema rejects extra fields. After the node and client present
opposite-role tickets with identical bindings, each receives the small
`{"type":"paired"}` control message. Thereafter only binary frames are
accepted. For `get`, the node is the only sender; for `put`, the client is the
only sender. Frames are limited to 64 KiB by default, bytes are claimed in
PostgreSQL before each frame is forwarded, and the session closes on an
operation-direction violation, size overflow, peer disconnect, idle timeout,
or ticket expiry. `maxBytes` is the exact encrypted ciphertext length and may
not exceed 1 GiB. Stream handling pauses the source while the destination
drains; per-socket queued frames and buffered sends have fixed ceilings.

`src/relayScopeVectors.ts` is byte-identical to the node-agent and
control-plane copies. All three packages test the exact signed ticket and CI
diffs the copies. The vector uses the repository's existing throwaway test-key
fixture only; its private key is not used by the relay service and must never be
used for production tickets.

## Shared durable state

Apply the schema as an explicit release step before starting or updating the
service. After building, run `npm run db:migrate:runtime` with the relay
`DATABASE_URL`; this uses the SQL shipped in `migrations/` and does not run when
the server starts. The command is safe to retry and serializes concurrent
release jobs with a PostgreSQL advisory lock. Every instance must use the same
PostgreSQL database and `RELAY_MAX_SESSIONS`. A separate transaction advisory
lock serializes ticket claims and global capacity admission;
`ticket_id` and `(session_id, role)` are unique in PostgreSQL. Claims survive
process restarts and reject replay on every instance. Expired session rows and
their ticket tombstones are removed during subsequent claims, after ticket
expiry.

WebSocket bytes remain on the instance that claimed the first role. Configure
the load balancer for consistent session affinity using the untrusted
`{sessionId}` path segment; the service checks that both tickets bind the
session, but never trusts the path as authorization. A ticket routed to another
instance gets `wrong_instance` and remains unclaimed so the peer may retry at
the owning instance. If the owner process restarts, PostgreSQL retains every
ticket claim and rejects replays. The process-local sockets are gone, so the
session is abandoned until expiry; the service does not provide cross-instance
socket handoff or resumable streams, including when only one role had joined.

## TLS and deployment

The Node process speaks plain HTTP/WebSocket and is designed to sit behind a
TLS terminator that provides WSS. Bind it to a private interface, allow access
only from the trusted ingress/network, and do not publish its HTTP port to the
internet. The load balancer must preserve `/relay/{sessionId}` for affinity,
support WebSocket upgrades, disable request/response body logging, and redact
the first WebSocket frame from packet/application tracing. Tickets are short
lived, but still bearer credentials. Never place them in URLs or log frames.

The service requires the relay database, the control-plane Ed25519 public key,
and a unique stable `RELAY_INSTANCE_ID`. See `.env.example`. Use a dedicated
least-privilege PostgreSQL role, database TLS where applicable, and network
policies that allow only the service and operators to reach the database. The
health endpoint is process liveness only; it does not validate database
readiness.

The multi-stage `Dockerfile` builds the TypeScript service and runs only its
production dependencies as the non-root `benzene` user. The image binds to
`0.0.0.0:8090` inside its container; keep that port private behind the TLS
terminator. Its default command starts the relay and never migrates the
database. Run the migration as a one-off release job using the same image and
database credentials, overriding the command with `node built/migrate.js`.
The image is published to GHCR as
`ghcr.io/<repository-owner>/benzene-relay-service` using the same SHA, branch,
semver and default-branch `latest` tags as the other services. A buildable and
published image does not mean the relay is deployed or remotely verified.

## Local use

```sh
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run build
npm run db:migrate:runtime
npm start
```

The suite has deterministic scope and transport tests. If `TEST_DATABASE_URL`
is set, it also creates an isolated schema and exercises shared-instance and
restart replay claims against real PostgreSQL. CI run `36606892325` passed all
15 relay-service tests together with the control-plane assignment and
node/mobile contract suites. These tests do not make the service
production-ready: a real container release, deployment, TLS termination and
DNS, abuse controls, operational monitoring, client-to-node remote acceptance and
representative network-failure testing remain outstanding.
