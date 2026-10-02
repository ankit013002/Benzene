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

After publishing and deploying the image, run the repository's **Verify public
relay ingress** GitHub Actions workflow and provide the public origin as
`wss://relay.example.net`. It runs on a GitHub-hosted runner, outside the
operator's LAN, and checks that public DNS resolves only to public addresses,
HTTPS `/ready` reports the database-backed relay as ready, TLS validates, and
WSS reaches `/relay/{sessionId}` and rejects a deliberately invalid ticket.
The probe sends no file bytes and does not need a production ticket. It is
read-only and safe to rerun after DNS, certificate, proxy, affinity, or service
changes.

This is an ingress check, not a remote client-to-device acceptance: it does not
prove that two real peers can exchange ciphertext through the deployment, that
home NAT/firewall conditions trigger the fallback, or that a specific proxy
configuration preserves session affinity under scale or restart. Keep the
existing local real-component relay acceptance and complete a live remote
journey before treating remote access as verified. The ingress workflow has
not yet been run against a live public deployment.

### Live remote client-to-device acceptance

`benzene-control-plane/scripts/accept-remote-relay.mts` exercises the real
public WSS relay with an actual short-lived `client/get` ticket. It first runs
the public ingress check, verifies the control-plane signature and every scope
binding against the ticket, then uses the mobile receiver implementation to
receive the exact ciphertext and checks SHA-256 and byte count before saving
those ciphertext bytes. It accepts only encrypted-object transfers up to the
current 25 MiB client limit. It never asks for a Vault key or device signing
key, and it never sends file bytes to the control plane. This acceptance helper
is implemented but has not been run against a live relay deployment.

For a bounded operator rehearsal:

1. Put an enrolled source node on its normal independent connection and make
   sure its agent is running and online. Use a disposable encrypted-v1 file no
   larger than 25 MiB, stored on that node and referenced by a committed file
   version.
2. On a second computer outside the source node's LAN (for example, a
   Windows laptop on a phone hotspot), sign in to the normal Benzene web app.
   In that browser's developer console, issue one fresh acceptance assignment
   for the existing file's `nodeId` (not its storage hash):

   ```js
   const response = await fetch('/api/placement/relay-read', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ nodeId: 'YOUR_FILE_NODE_ID', requestId: crypto.randomUUID() }),
   });
   if (!response.ok) throw new Error(`Relay assignment failed: ${response.status}`);
   await navigator.clipboard.writeText(JSON.stringify(await response.json()));
   ```

   The signed-in browser supplies its existing session; do not copy or expose
   its session cookie. Paste the clipboard response into a temporary JSON file
   on that computer and restrict it to the current user (`chmod 600 <file>` on
   macOS/Linux). On Windows, save it under the current user's profile with
   its inherited private ACL; do not use a shared folder. The ticket is a
   one-use bearer credential: do not paste it into a command, issue tracker,
   chat, or CI log, and clear the clipboard and delete the file when the run
   finishes or it expires. This explicit route
   creates the pending assignment; the enrolled source agent claims its
   complementary node ticket through its ordinary signed queue.
3. On that second computer, install Node.js 22.13 or newer, then install the
   control-plane and mobile dependencies (`npm ci --include=dev` in each
   package directory). From the control-plane package directory, run:

   ```sh
   cd benzene-control-plane
   BENZENE_RELAY_FALLBACK_FILE=/secure/path/fallback.json \
   BENZENE_RELAY_CIPHERTEXT_OUT=/secure/path/received-ciphertext.bin \
   BENZENE_TRANSFER_PUBLIC_KEY='<control-plane Ed25519 public key, base64 SPKI>' \
   node --import tsx scripts/accept-remote-relay.mts
   ```

   Choose an output path that does not already exist. The script creates it
   exclusively with mode 0600 on POSIX systems. On Windows, input and output
   ACLs are inherited from their containing directories and are not
   programmatically verified; use a directory private to the current user.
   Its output reports only the endpoint checks and byte count; it does not
   print ticket contents.

   In PowerShell, use the same private user-profile paths and set the
   environment for this process before running it:

   ```powershell
   Set-Location benzene-control-plane
   $env:BENZENE_RELAY_FALLBACK_FILE = "$env:LOCALAPPDATA\BenzeneRelay\fallback.json"
   $env:BENZENE_RELAY_CIPHERTEXT_OUT = "$env:LOCALAPPDATA\BenzeneRelay\received-ciphertext.bin"
   $env:BENZENE_TRANSFER_PUBLIC_KEY = '<control-plane Ed25519 public key, base64 SPKI>'
   node --import tsx scripts/accept-remote-relay.mts
   ```

   Create the `BenzeneRelay` directory under `LOCALAPPDATA` first and confirm
   its ACL is private to the current user; the script does not inspect Windows
   ACLs. The output file must not already exist.
4. Confirm the enrolled node completed the corresponding relay assignment.
   The receiving helper verifies the transfer signature and exact encrypted
   ciphertext hash/length; it does not perform Vault-key recovery or establish
   release readiness.

The two computers are important: running this from the same LAN as the source
does not exercise the intended remote/NAT failure condition. The script cannot
create a production assignment or extract a ticket from a client session; the
normal authenticated client journey must request it. It cannot substitute for
testing the full mobile/desktop UX, failover behavior during network changes,
load-balancer affinity under multiple instances, or restart/retry behavior.

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
