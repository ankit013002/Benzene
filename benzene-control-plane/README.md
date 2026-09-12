# Benzene control plane

The control plane owns Vault, Device, allocation, policy, replica and logical
file metadata. It answers where bytes belong and whether protection is
satisfied; device agents carry the bytes directly over the LAN.

## Storage safety

Capacity admission uses the latest device heartbeat's `usedBytes` as a
baseline, then adds active `placing` reservations and possession-confirmed
replicas newer than `usageReportedAt`. Placement, repair, drain preflight and
allocation changes share this calculation and lock the allocation row before
admission, so exact-fit reservations cannot be over-issued between
heartbeats.

Repair assignments bind a target reservation to one healthy source and a
persisted one-shot assignment id. A signed source-failure report must name
both values and arrive before the same Unix-second grant boundary. Consuming
the report clears the binding, preventing replay or unrelated-source
quarantine.

## Outage classification

Device outage classification is persisted opportunistically when active repair
or user-facing paths inspect a Vault; there is no standalone scheduler. A
device becomes `offline` after 120 seconds without a heartbeat by default and
`extended_offline` after 24 hours. `suspected_lost` is disabled unless
`DEVICE_SUSPECTED_LOST_AFTER_SECONDS` is explicitly configured, and that value
must be later than the extended-offline threshold.

Offline and extended-offline devices retain durable bytes and replica metadata;
those replicas still count as healthy protection, but cannot serve downloads or
repair while the device is not online. A suspected-lost device is quarantined
and excluded from protection counts while its replica metadata is preserved. A
signed heartbeat alone does not restore that quarantine.

### Presumed-lost inventory reconciliation

When a presumed-lost device returns, its agent must first complete a fresh
usage heartbeat and then submit one complete, signed inventory request. The
agent scans its local store and verifies each whole-file object's SHA-256 and
size before submission. The MVP accepts at most 8,000 objects in that one
request; larger stores must wait for a future paged protocol. The request is
authenticated, but it is not independent proof against a compromised device.

The control plane reconciles only replica metadata it already knows. An exact
known hash/size match is restored as healthy, an omission or size mismatch is
marked missing, and unknown hashes are ignored rather than creating file
metadata. The transaction locks the allocation and per-object guards, updates
verification watermarks, and safely clears or preserves repair bindings so the
returning device cannot create a capacity or source-failure race. Only after a
successful report is the device released from quarantine and marked online.

Protection and availability remain separate. A file can retain durable healthy
protection while waiting for an offline device. Availability is `available`
when an online healthy copy is reachable, `waiting_for_device` when durable
copies exist but none are reachable, `restoring_protection` when a reachable
copy exists while repair is active, and `unavailable` when no durable healthy
copy remains.

## Verification

The suite uses a throwaway PostgreSQL database per test file and covers
placement, repair, capacity, drain readiness, device-authenticated possession,
outage classification and tenant isolation. See the repository README for the
latest fully verified cross-service counts.

## Explicit limits

This slice is whole-file and LAN-only. Rebalancing, encryption and key recovery,
remote access, chunking/manifests and garbage collection remain unfinished.
