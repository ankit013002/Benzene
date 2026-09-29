# Benzene relay service

This package provides an opaque WebSocket byte-forwarding transport for the
future encrypted-object data plane. It is not integrated into current uploads,
downloads, repair, or mobile flows. No relay traffic is considered a supported
remote-access feature until the control plane and clients issue/use these
scopes only for encrypted ciphertext.

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

`src/relayScopeVectors.ts` is byte-identical to the node-agent copy. Both
verifiers test the exact signed ticket. The vector uses the repository's
existing throwaway test-key fixture only; its private key is not used by the
relay service and must never be used for production tickets.

## Shared durable state

Apply `migrations/001_relay_sessions.sql` once to the relay database before
starting a release. The service does not migrate at startup. Every instance
must use the same PostgreSQL database and `RELAY_MAX_SESSIONS`. A transaction
advisory lock serializes ticket claims and global capacity admission;
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

## Local use

```sh
npm ci
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_relay_sessions.sql
cp .env.example .env
npm run typecheck
npm test
npm run build
npm start
```

The suite has deterministic scope and transport tests. If `TEST_DATABASE_URL`
is set, it also creates an isolated schema and exercises shared-instance and
restart replay claims against real PostgreSQL. These tests do not make the
service production-ready: control-plane issuance, client/agent dialing,
encrypted-object integration, TLS deployment, abuse controls, operational
monitoring, and end-to-end remote transfer acceptance remain outstanding.
