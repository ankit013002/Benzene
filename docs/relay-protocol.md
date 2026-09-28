# Relay protocol foundation

This document and `benzene-node-agent/src/relayScope.ts` define a bounded,
opaque-relay contract foundation for architecture §§36–39. There is no running
relay service and no upload, download, repair, mobile, or control-plane path
uses it. The service-specific transport and deployment choices remain open.

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
ticket before parsing its claims, atomically claims each `ticketId`, and pairs
only opposite roles with identical bindings. For `get`, only the node may
send; for `put`, only the client may send. A receiver can never turn its
capability into a write. Forwarded bytes are counted before forwarding, and the
session closes if it exceeds the signed ceiling. Streams need bounded buffers,
backpressure, an idle timeout, an absolute session deadline, and a hard
concurrent-session limit. The relay handles ciphertext bytes only; object
metadata and all Vault keys stay outside it.

The current executable core verifies ticket signatures, schema, expiry and
size, and models complementary one-use claims, pairing, operation direction,
session capacity and byte accounting. `RelaySessionRegistry` is intentionally
process-local. It is a testable state-machine reference, not durable replay
protection: a process restart or a second instance can accept a previously used
ticket. The production service must claim tickets in a shared transactional
store and retain tombstones through ticket expiry before it may advertise
one-use semantics.

## Integration blockers

- The control plane has no relay ticket issuer, session record, per-owner
  authorization, or durable atomic ticket-claim store.
- Neither the node agent nor clients can open outbound relay streams, pause and
  resume under backpressure, or distinguish a failed direct transfer from a
  relay-eligible one. No code is allowed to send today's plaintext-era objects
  to a relay.
- The current direct transfer-grant contract identifies the device and
  plaintext-era object route. It must not be repurposed for relay tickets; the
  future issuer needs to bind the encrypted `storageHash`, exact ciphertext
  size and session role after encryption is integrated.
- The relay transport (TLS TCP framing versus a WebSocket/TURN-compatible
  protocol), deployment trust, abuse controls, bandwidth limits, telemetry,
  and cost policy need implementation and review.
- Encryption's executable v1 is a buffer-based foundation and is not connected
  to live paths. Key lifecycle, recovery, streaming/chunk limits, migration of
  existing plaintext objects, and client conformance still block real encrypted
  relay traffic.

Until those pieces are implemented and exercised end to end, HTTPS configured
on an individual agent and this state-machine core do not constitute remote
access, NAT traversal, or a relay fallback.
