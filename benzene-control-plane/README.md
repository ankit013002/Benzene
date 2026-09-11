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

## Verification

The real-Postgres control-plane suite currently passes **287 tests**. The suite
uses a throwaway database per test file and covers placement, repair, capacity,
drain readiness, device-authenticated possession and tenant isolation.

## Explicit limits

This slice is whole-file and LAN-only. Final device detach/row removal,
outage/loss classification, encryption and key recovery, remote access,
chunking/manifests and garbage collection remain unfinished.
