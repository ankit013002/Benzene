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

Transfer-grant v2 signs the physical encryption mode (`none` for legacy
plaintext or `benzene-encrypted-object-v1` for encrypted objects) on PUT and
GET grants. The node agent stores that authenticated mode in the sidecar and
refuses an idempotent PUT if the existing bytes have missing or conflicting
mode metadata. The agent accepts old v1 GET grants only as plaintext and
rejects v1 PUTs; repair/rebalance require v2 source grants. Use the
control-plane and node-agent releases together when rolling out v2. Migration
0010 deliberately marks every pre-v2 replica `unknown` rather than guessing
from a ciphertext-looking hash or its old `none` sidecar. Downloads fail closed
for those rows, and repair/rebalance will not copy them until their format is
explicitly reconciled. The bytes and replica rows are retained; this is a
temporary availability gate, not deletion. Before upgrading a deployed fleet,
pause new transfers and reconcile existing replicas against authoritative
version metadata as a coordinated operation. There is not yet an automated
reconciliation command, so this pre-production migration is not a zero-downtime
rolling upgrade.

Repair assignments bind a target reservation to one healthy source and a
persisted one-shot assignment id. A signed source-failure report must name
both values and arrive before the same Unix-second grant boundary. Consuming
the report clears the binding, preventing replay or unrelated-source
quarantine.

Explicitly purged versions release conservative PostgreSQL object references.
Once no live or legacy MongoDB version references an object, the control plane
issues durable, exact per-device garbage-collection assignments and retains
replica metadata until each agent acknowledges its idempotent local deletion.

The private `POST /internal/account-deletion/:ownerId/stored-objects` adapter
uses that same purge path in batches of 50 file versions. It returns
`complete: true` only when the owner's Mongo versions, conservative object
references, and Vault replica rows are all gone. Device bytes are never removed
by this endpoint; offline devices keep the auth-service phase incomplete until
they receive and acknowledge their durable GC assignments. Configure
`ACCOUNT_DELETION_INTERNAL_SECRET` only when the auth service is enabled, and
share it with that service's `ACCOUNT_DELETION_CONTROL_PLANE_SECRET` setting.

After protection is satisfied, the control plane may admit one whole-file
rebalance per Vault cooldown. It selects an online target that reduces
proportional usage skew, copies and verifies the replacement before marking the
old source for durable deletion, and serializes that state with GC, repair,
inventory recovery and device drain.

## Outage classification

Device outage classification is persisted by a process-local, non-overlapping
background sweep every 60 seconds by default, and refreshed when active repair
or user-facing paths inspect a Vault. A device becomes `offline` after 120
seconds without a heartbeat by default and `extended_offline` after 24 hours.
`suspected_lost` is disabled unless
`DEVICE_SUSPECTED_LOST_AFTER_SECONDS` is explicitly configured, and that value
must be later than the extended-offline threshold.

Offline and extended-offline devices retain durable bytes and replica metadata;
those replicas still count as healthy protection, but cannot serve downloads or
repair while the device is not online. A suspected-lost device is quarantined
and excluded from protection counts while its replica metadata is preserved. A
signed heartbeat alone does not restore that quarantine.

## Metadata backup and restore

`npm run db:backup -- --output /secure/backups/benzene-YYYYMMDD` creates a
paired PostgreSQL custom-format dump and compressed MongoDB archive, with a
manifest containing database names and SHA-256 checksums. Set `DATABASE_URL`
and `MONGOOSE_URI` as for the control plane. The destination must not already
exist. The script requires `--confirm-maintenance-window`; stop the control
plane and all other writers before starting it. It writes owner-only files and
does not store connection strings in the backup. The host must provide
`pg_dump`, `pg_restore`, `mongodump` and `mongorestore`; use client versions
compatible with the target database servers.

Restore first stops the control plane and all writers, then runs:

```bash
npm run db:restore -- --from /secure/backups/benzene-YYYYMMDD \
  --confirm-maintenance-window \
  --confirm-replace-targets=benzene,benzene
```

The confirmation value is the exact PostgreSQL database name followed by the
MongoDB database name, matching `DATABASE_URL` and `MONGOOSE_URI`. Restore
checks both checksums and both target names before invoking either native
restore tool. It replaces the target PostgreSQL objects and drops/reloads the
target MongoDB database. Keep a separate copy of any target data you need.

The two databases cannot be snapshotted or restored atomically with this
workflow. The maintenance window prevents Benzene writes between the two dump
operations; the manifest identifies the pair but does not make them a
distributed transaction. If a restore command fails after PostgreSQL has been
restored, keep the application offline and rerun the same restore after
resolving the error. Use database-native point-in-time recovery and managed
backup policies for availability objectives; this operator workflow has not
been exercised against a production-sized deployment and is not a substitute
for them. The archive contains control-plane metadata, including sensitive
file names and ownership information, so store it encrypted with restricted
access and test recovery on isolated databases before relying on it.

The script-level workflow tests run without database servers or cloud
accounts:

```bash
node --test ../scripts/metadata-backup.test.mjs
```

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

This slice is whole-file and LAN-only. Encryption and key recovery, remote
access and chunking/manifests remain unfinished. Rebalancing is intentionally
limited to one whole-file move per Vault cooldown, without bandwidth or power
awareness, user scheduling, multi-object queues or chunk-level resumption.
