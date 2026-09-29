# Relay protocol foundation

This document and `benzene-node-agent/src/relayScope.ts` define the bounded,
opaque-relay contract for architecture §§36–39. The WebSocket relay verifies
and pairs tickets; the control plane can now explicitly issue an encrypted-GET
fallback assignment and the node agent can claim and produce that object. This
is an integration slice, not a verified remote-access product path.

## Proposed scope

The control plane issues two independently signed Ed25519 tickets for a
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

The control-plane route `POST /placement/relay-read` is an explicit fallback
operation; normal read planning remains direct-first and does not create relay
work. An authenticated caller submits a Mongo file `nodeId` and UUID
`requestId`. The control plane requires the current committed encrypted-v1
version, exact encrypted metadata and a live object reference, then selects an
online healthy encrypted-v1 replica. It persists a bounded assignment for
that exact device and returns only the client capability:

```json
{
  "data": {
    "kind": "relay_fallback",
    "relayUrl": "wss://relay.example",
    "sessionId": "<uuid>",
    "ticket": "<client-role signed ticket>",
    "storageHash": "<ciphertext sha256>",
    "ciphertextBytes": 12345,
    "expiresAt": "<ISO timestamp>"
  }
}
```

`requestId` makes a retry of the same request return its original assignment;
the active queue is capped globally and per Vault. Only the selected device,
authenticated with its normal signed `/agent` request, can poll
`GET /agent/relay-read` and receive the node-role ticket. A 20-second claim
lease lets the node recover the exact same persisted ticket after a lost poll
response or pre-connect failure; no more than three claims are offered, and
relay-side one-use ticket claims prevent two producers from successfully using
the same capability. Completion is reported to
`POST /agent/relay-read/complete`. The node ticket is never returned to the
client. A failed assignment cannot be reused with the same request id; callers
must start a new explicit fallback request. `RELAY_PUBLIC_URL` must be configured with the public
`wss://` endpoint; without it, relay fallback is disabled.

The node-agent API `sendStoredRelayObject` implements only the `node/get`
producer side. It independently verifies the signed scope and expiry, requires
the caller's device id, storage hash and exact size to match the ticket,
rejects the legacy `encryption: "none"` sidecar, verifies the local object
before connecting, and re-hashes/counts while streaming bounded frames with
backpressure. It requires `wss://`; insecure `ws://` is available only as an
explicit localhost test option. The agent claims this API only from the
control-plane relay-read queue; repair and upload do not use it. Mobile has a
bounded client consumer and requests relay only after every direct read target
fails.

`RelaySessionRegistry` in the node-agent scope module remains an in-memory
state-machine reference. The relay service uses its PostgreSQL-backed session
store for shared atomic ticket claims and retains claims through ticket expiry.
The server/node producer local integration test passes. A control-plane
integration test exercises issuance and assignment against real Postgres plus
MongoMemoryServer, but could not be executed in this environment because no
`TEST_DATABASE_URL` Postgres server is available. Neither test proves the
remote client UI path.

## Integration blockers

- Control-plane ticket issuance exists only for explicitly requested encrypted
  GET fallback. Mobile requests it after direct attempts fail, but the running
  control plane, node, relay and mobile client have not yet been exercised as
  one system. Ordinary read planning remains direct-first. The `client/put`
  production path does not exist.
- The relay's production TLS endpoint, DNS, certificate lifecycle, deployment
  configuration, abuse controls and operating limits still need deployment
  work and review. A local `ws://` integration test is not evidence of remote
  TLS connectivity or NAT traversal.
- Direct transfer grants and relay tickets remain separate contracts. Relay
  tickets bind the encrypted `storageHash`, exact ciphertext size, device,
  session and role; their three byte-vector copies are checked in CI.
- Bandwidth policy, telemetry, cost policy, multi-instance operational
  behavior and remote failure recovery need implementation and review.
- Encryption v1 is connected to bounded mobile upload, direct download and
  relay-read paths. Trusted-device recovery, key rotation, streaming/chunk
  limits, migration of existing plaintext objects, and representative client
  conformance still block production use. The producer API requires the
  encrypted-object marker, but that marker alone is not independent proof that
  arbitrary stored bytes are ciphertext.

Until production TLS deployment, the remaining encryption/key lifecycle work
and full remote end-to-end tests are complete, this slice does not establish a
verified remote client path, production NAT traversal, or readiness for real
user data.
