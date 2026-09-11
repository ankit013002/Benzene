# Benzene node agent

The process that turns a computer into storage for a Benzene vault.

It holds this device's Ed25519 identity, reports signed presence to the control
plane, serves authorized objects to peers on the local network, and performs
bounded repair work when the control plane assigns it.

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
| `BENZENE_HEARTBEAT_MS` | `30000` | Presence interval |
| `BENZENE_REPAIR_MS` | `60000` | Minimum interval between repair polls |
| `BENZENE_DEVICE_NAME` | hostname | Name shown in the Devices list |
| `BENZENE_ADVERTISED_URL` | first non-internal LAN IPv4 | URL peers use for direct transfers |

The advertised URL matters when a computer has multiple interfaces: it is the
address the control plane gives to browsers and other agents. Override it when
the automatic LAN address chooses a VPN or virtual interface.

After enrollment, each heartbeat is signed with the device's private key. The
agent also polls signed `GET /agent/repair` assignments. When work is available,
the control plane supplies a healthy peer URL and a short-lived Ed25519 transfer
grant scoped to one object, device and operation;
the agent fetches that one whole file directly from the peer, verifies its
SHA-256 hash while writing, and reports possession back with another signed
request. File bytes do not pass through the browser or control plane.

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

**The object format is versioned.** Client-side encryption is not implemented
yet, but each object records `v` and an explicit `encryption: "none"`. When
encryption lands, encrypted and plaintext-era objects coexist and no migration
is needed — which matters because these files live on machines we do not
control.

## Known limits

- **Transfers are HTTP/LAN oriented.** CORS is enabled for direct browser-to-
  device requests, but an HTTPS-hosted app cannot directly PUT to an HTTP LAN
  address; remote access and relay are unfinished.
- **Objects are plaintext.** Each sidecar records `encryption: "none"`; at-rest
  encryption and its key-recovery design must precede real user data.
- **The private key is a `0600` file**, not platform-secure storage. Keychain,
  DPAPI and Keystore are per-platform native work (§34).
- **Repair is whole-file and bounded.** The agent fills recorded replica
  shortfalls through direct healthy-peer transfer, including assignments that
  copy from a draining source during drain preparation. Final detach/device-row
  removal, outage/loss classification, rebalancing and garbage collection are
  not implemented.
- **Whole files, not chunks.** Deliberate, per §107 — chunking lands after the
  core loop is proven.
- **There is no automatic erase policy or GC.** An authorized object-delete
  operation exists, but lifecycle cleanup of unreferenced data is unfinished.

## Protocol contract

`src/protocolVectors.ts` is byte-identical to the control plane's copy and both
packages assert against it. The agent signs and the control plane verifies, so
these vectors are what stop two separate deployables drifting apart on the wire
format. CI diffs the two files.

## Verification

The current node-agent suite has **86 tests**. The broader verified counts are
control plane **287**, auth **72**, gateway **15**, and **34 smoke checks**.
