# Benzene node agent

The process that turns a computer into storage for a Benzene vault.

It holds this device's Ed25519 identity, reports signed presence to the control
plane, serves authorized objects to peers on the local network, and performs
bounded repair, garbage-collection and rebalancing work when the control plane
assigns it.

## Running it

```bash
cd benzene-node-agent
npm ci
BENZENE_CONTROL_PLANE_URL=http://localhost:8080 \
BENZENE_ALLOCATED_BYTES=$((50 * 1024 * 1024 * 1024)) \
npm run dev
```

On first run it generates an Ed25519 keypair, requests enrollment, and prints a
pairing code. Approve it from the web app (or `POST /devices/enrollments/approve`)
and the agent starts heartbeating.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENZENE_CONTROL_PLANE_URL` | `http://localhost:8080` | Gateway origin |
| `BENZENE_DATA_DIR` | `~/.benzene` | Identity and storage root |
| `BENZENE_ALLOCATED_BYTES` | `0` | Bytes this device contributes |
| `BENZENE_AGENT_PORT` | `7070` | Transfer server port |
| `BENZENE_AGENT_TLS_CERT_FILE` | unset | Optional TLS certificate chain |
| `BENZENE_AGENT_TLS_KEY_FILE` | unset | Optional TLS private key; configure with the certificate |
| `BENZENE_HEARTBEAT_MS` | `30000` | Presence interval |
| `BENZENE_REPAIR_MS` | `60000` | Minimum interval between repair polls |
| `BENZENE_REBALANCE_MS` | `60000` | Minimum interval between rebalance polls |
| `BENZENE_DEVICE_NAME` | hostname | Name shown in the Devices list |
| `BENZENE_ADVERTISED_URL` | first non-internal LAN IPv4 | URL peers use for direct transfers |

The advertised URL matters when a computer has multiple interfaces: it is the
address the control plane gives to browsers and other agents. Override it when
the automatic LAN address chooses a VPN or virtual interface. Configuring both
TLS files changes the default to `https://`; the certificate must be trusted by
clients and cover the advertised hostname or IP address.

After enrollment, each heartbeat is signed with the device's private key. The
agent also polls signed `GET /agent/repair` assignments. When work is available,
the control plane supplies a healthy peer URL and a short-lived Ed25519 transfer
grant scoped to one object, device, operation and storage-encryption mode. The
agent verifies the source grant, fetches that object directly from the peer,
preserves its authenticated mode in the local sidecar, verifies its SHA-256 hash
while writing, and reports possession back with another signed request. File
bytes do not pass through the browser or control plane.

## How storage is laid out

Objects are addressed by the SHA-256 of their bytes, never by the user's
filename or path:

```
storage/
├── objects/ab/abc123…      the bytes
├── meta/ab/abc123….json    sidecar: version, size, encryption mode
└── tmp/                    in-flight writes, cleared on restart
```

That decouples physical layout from the logical tree, makes corruption
detectable, makes repeated transfers idempotent, and leaves room for
deduplication. The sidecar mirrors architecture §54, so a node retains enough
local metadata to help reconstruct a lost control plane.

## Deliberate design points

**Allocation is a hard ceiling, enforced against bytes that actually arrive** —
not the size a client claims. A caller that under-reports is cut off mid-stream.

**Writes are atomic.** Bytes land in `tmp/` and are renamed into place only once
complete, so a crash leaves debris rather than a truncated object that would
pass an existence check and fail verification later.

**Usage is recomputed from disk at startup.** An in-memory counter cannot be
trusted across a restart the agent did not choose.

**Repair assignments are source-bound and one-shot.** The agent fetches only
the healthy peer and object named by the short-lived grant, verifies the whole
file before reporting possession, and reports an integrity failure with the
persisted assignment id. Network failures remain retryable; a consumed
failure report cannot be replayed against another source.

**Presumed-lost recovery is inventory-based.** After a fresh usage heartbeat
still reports `suspected_lost`, the agent scans the complete local object store,
hash-verifies every whole-file object, and submits one signed inventory request.
The MVP caps that request at 8,000 objects; an oversized scan is rejected
without submitting a partial report. The control plane restores only known
hash/size matches, marks omissions or size mismatches missing, and ignores
unknown hashes. The signature authenticates the report, but cannot provide
independent proof against a compromised device. Until reconciliation succeeds,
the agent does not poll repair assignments. A failed or lost submission
is retried on a later heartbeat; a normal heartbeat response clears the pending
recovery gate if the server has already accepted the report.

**GC is durable and idempotent.** After explicit logical purge, the agent may
receive one exact object-deletion assignment per heartbeat. It removes only the
content-addressed object and sidecar inside the managed store, then acknowledges
the stable nonce; a lost acknowledgement safely retries the same local delete.

**Rebalancing copies before deleting.** The agent uses the same direct,
grant-scoped peer transfer and hash verification as repair. Only after the
target reports possession does the old source receive a durable deletion
assignment. A node never overlaps repair, GC, rebalancing, inventory recovery
or removal work locally.

**The storage mode is authenticated.** Transfer-grant v2 requires `encryption`
to be exactly `none` or `benzene-encrypted-object-v1` for PUT and GET. The mode
is signed and copied into the object sidecar. A verified duplicate with a
missing or different mode is refused instead of silently relabeled. Legacy v1
GET grants are accepted only as `none`; v1 PUTs are rejected because they do
not authenticate a format. Repair/rebalance require v2 source grants, so a
legacy token cannot relabel copied bytes. This marker is not proof that
arbitrary bytes are ciphertext: clients and the control plane must still ensure
encrypted uploads contain ciphertext.

Deploy transfer-grant v2 in a coordinated control-plane/agent rollout. New
agents intentionally reject v1 PUT grants because those grants do not bind a
storage format. The control-plane migration marks all pre-v2 replicas
`unknown`; it retains their bytes but blocks reads and copies until an operator
reconciles their mode. There is no automated reconciliation tool yet, so do not
roll v2 onto a fleet with live objects without a separately planned migration.

## Known limits

- **HTTPS serving is configurable, not provisioned.** The same grant-protected
  transfer routes can listen with a supplied certificate and key, but Benzene
  does not yet issue or renew certificates, establish browser trust, discover
  remote peers, traverse NAT or provide a relay.
- **Encryption does not complete the key lifecycle.** Encrypted-object v1 bytes
  can be stored and replicated as ciphertext, but key recovery and legacy
  plaintext migration remain unresolved. Do not treat either path as ready for
  real user data until those designs and end-to-end recovery are verified.
- **The private key is a `0600` file**, not platform-secure storage. Keychain,
  DPAPI and Keystore are per-platform native work (§34).
- **Repair is whole-file and bounded.** The agent fills recorded replica
  shortfalls through direct healthy-peer transfer, including assignments that
  copy from a draining source during drain preparation. Outage classification
  is control-plane work performed by its background sweep and refreshed by
  active paths. Offline and extended-offline replicas stay
  durable healthy protection, but cannot serve downloads or repair while their
  device is not online; suspected-lost devices remain quarantined and excluded
  from protection counts until the fresh-heartbeat inventory reconciliation
  described above.
- **Rebalancing is conservative.** It moves one whole file at a time and has no
  bandwidth budget, power awareness, user schedule or chunk-level resumption.
- **Whole files, not chunks.** Deliberate, per §107 — chunking lands after the
  core loop is proven.

## Protocol contract

`src/protocolVectors.ts` is byte-identical to the control plane's copy and both
packages assert against it. The agent signs and the control plane verifies, so
these vectors are what stop two separate deployables drifting apart on the wire
format. CI diffs the two files.

The relay authorization contract is pinned by `src/relayScopeVectors.ts`, which
is byte-identical to the relay service's copy. Both verifiers assert against the
same exact signed ticket. Its Ed25519 public key and signature use the existing
throwaway test-key fixture only; no production key or private key belongs in
these vectors.

## Verification

The current node-agent suite has **152 tests**, including the relay-ticket
conformance vector. The last fully green broader baseline before the relay job
was added is CI run `36508422483`; the repository guide records its exact
cross-package counts.
