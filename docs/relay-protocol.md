# Relay protocol foundation

This document and `benzene-node-agent/src/relayScope.ts` define the bounded,
opaque-relay contract for architecture §§36–39. An executable WebSocket relay
service now verifies and pairs tickets, and the node agent has a producer-only
transport slice. No control-plane, upload, repair, web-client or mobile path
issues or consumes relay tickets yet, so this is not a remote-access fallback.

## Proposed scope

The control plane would issue two independently signed Ed25519 tickets for a
single rendezvous: one `node` role and one `client` role. Both tickets bind the
same `sessionId`, `storageHash`, `deviceId`, `op`, expiry, and byte ceiling; their
`ticketId` and `role` differ. A ticket is limited to one device, one object, one
operation, one rendezvous, and at most five minutes. Its `storageHash` must be
the encrypted object's `storageHash` from
[`contracts/encrypted-object-v1/README.md`](../contracts/encrypted-object-v1/README.md),
and `maxBytes` must be the exact ciphertext length. It must never refer to the
plaintext `objectId` or carry file metadata.

Both peers connect outbound over authenticated TLS. The relay verifies each
ticket before parsing its claims, atomically claims each `ticketId` in its
shared PostgreSQL store, and pairs only opposite roles with identical
bindings. For `get`, only the node may send; for `put`, only the client may
send. A receiver can never turn its capability into a write. Forwarded bytes
are counted before forwarding, and the session closes if it exceeds the signed
ceiling. The service bounds frames, queued data and destination buffers, and
enforces idle and signed-expiry deadlines plus configured session capacity.
The relay handles opaque binary frames only; object metadata and all Vault keys
stay outside it.

The node-agent API `sendStoredRelayObject` implements only the `node/get`
producer side. It independently verifies the signed scope and expiry, requires
the caller's device id, storage hash and exact size to match the ticket,
rejects the legacy `encryption: "none"` sidecar, verifies the local object
before connecting, and re-hashes/counts while streaming bounded frames with
backpressure. It requires `wss://`; insecure `ws://` is available only as an
explicit localhost test option. The API is not called by repair, upload,
download or any production control path. It does not implement the client
consumer or select relay only after a direct attempt fails.

`RelaySessionRegistry` in the node-agent scope module remains an in-memory
state-machine reference. The relay service uses its PostgreSQL-backed session
store for shared atomic ticket claims and retains claims through ticket expiry.
The server and node producer are covered by a local integration test, but
production relay deployment and remote end-to-end behavior have not been
verified.

## Integration blockers

- The control plane has no relay ticket issuer, session record, or per-owner
  authorization. No product flow can obtain complementary tickets yet.
- The node agent can produce one encrypted object for a signed `node/get`
  ticket, but client/web/mobile receiving and `client/put` production paths do
  not exist. Relay selection after a failed direct transfer is not wired, and
  direct-first behavior is not changed.
- The relay's production TLS endpoint, DNS, certificate lifecycle, deployment
  configuration, abuse controls and operating limits still need deployment
  work and review. A local `ws://` integration test is not evidence of remote
  TLS connectivity or NAT traversal.
- The current direct transfer-grant contract identifies the device and
  plaintext-era object route. It must not be repurposed for relay tickets; the
  future issuer needs to bind the encrypted `storageHash`, exact ciphertext
  size and session role after encryption is integrated.
- Bandwidth policy, telemetry, cost policy, multi-instance operational
  behavior and remote failure recovery need implementation and review.
- Encryption's executable v1 is a buffer-based foundation and is not connected
  to live paths. Key lifecycle, recovery, streaming/chunk limits, migration of
  existing plaintext objects, and client conformance still block real encrypted
  relay traffic. The producer API requires the encrypted-object marker, but
  that marker alone is not proof that arbitrary stored bytes are ciphertext.

Until ticket issuance, a client consumer, direct-first fallback, production TLS
deployment, encryption/key lifecycle and remote end-to-end tests are complete,
the relay server and node producer slice do not constitute remote access, NAT
traversal, or a relay fallback.
