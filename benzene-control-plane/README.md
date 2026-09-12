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
signed heartbeat does not restore that quarantine; inventory
reconciliation/recovery is still unimplemented.

## Verification

The suite uses a throwaway PostgreSQL database per test file and covers
placement, repair, capacity, drain readiness, device-authenticated possession,
outage classification and tenant isolation. See the repository README for the
latest fully verified cross-service counts.

## Explicit limits

This slice is whole-file and LAN-only. Inventory reconciliation/recovery after
outage classification, rebalancing, encryption and key recovery, remote access,
chunking/manifests and garbage collection remain unfinished.
