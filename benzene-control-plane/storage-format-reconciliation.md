# Replica storage-format reconciliation

Older PostgreSQL replica rows can retain `encryption = 'unknown'`. The control
plane can classify those rows from committed device-backed MongoDB file-version
metadata, but this maintenance command is deliberately conservative.

Run it from `benzene-control-plane` with `DATABASE_URL` and `MONGOOSE_URI`
configured. The default is a read-only dry run:

```bash
npm run storage-format:reconcile
```

The source command uses the development `tsx` runner. For the pruned runtime
image, build the control plane first and use the compiled entrypoint:

```bash
npm run build
npm run storage-format:reconcile:runtime
```

The JSON report lists each candidate, its proposed classification or skip
reason, and includes `classificationCounts` and `reasonCounts` summaries.
MongoDB records with a `storage` descriptor are cloud or
legacy storage records and are excluded. Only committed versions are eligible.
Plaintext metadata maps to `none`. Encrypted v1 metadata maps to
`benzene-encrypted-object-v1` only when its `objectHash` exactly equals the
encrypted object's `storageHash`. Vault owner, object hash, physical size, and
encrypted payload size must agree. Missing records, owner conflicts, inconsistent
hashes, malformed metadata, and size mismatches remain unchanged.

For apply, stop control-plane writers, take the normal PostgreSQL and MongoDB
maintenance precautions, then explicitly confirm the maintenance window:

```bash
npm run storage-format:reconcile:runtime -- --apply --confirm-maintenance-window
```

Apply updates only rows still marked `unknown`. A second run sees no already
classified rows, making successful applications idempotent. The maintenance
confirmation is an operator acknowledgement; it does not stop writers itself.

The focused integration suite uses a throwaway real PostgreSQL database and a
MongoDB Memory Server process:

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:storage-format-reconcile
```

The test command also runs a database-independent argument guard suite.
