# Benzene — agent guide

> **One drive. Every computer. All your storage.**

Context for AI coding agents working in this repo. `CLAUDE.md` and `AGENTS.md`
are byte-identical and CI enforces that — edit one, copy it to the other.

## Project status — read this first

**Benzene is not fully complete, is not the architecture §105 commercial MVP,
and is not production-ready for real user data.** What is verified is a
device-first **local/LAN development slice**: the control plane, node agent and
web path can enroll devices, place and repair whole-file replicas, and upload
and download directly on a development LAN.

The commercial MVP still requires remote/HTTPS transfers, encryption and a key
recovery design, garbage collection, rebalancing, desktop and mobile clients,
and the other blockers listed in §9. Do not describe the application as
complete, MVP-complete or production-ready until those capabilities and the
open product decisions are resolved and verified.

---

## 1. What Benzene is

**Benzene is a distributed personal storage system.** A user installs an agent
on computers they already own; each contributes disk, and those combine into one
logical **Vault**. Files are placed across those devices automatically.

**S3 is optional.** It is a secondary durability tier ("Cloud Protection"), not
the primary store.

The single most common mistake in this repo is treating it as a cloud-storage
frontend. It used to be one. Plenty of code still carries assumptions from that
era. **If you find yourself writing `file == S3 object`, stop.**

Direction is defined by two documents the user maintains outside the repo:
`BENZENE_ARCHITECTURE.md` and `BENZENE_PRODUCT.md`. Section references below
(§21, §81, …) point at the architecture doc. Ask for them before proposing
storage-layer work.

### Core principles

1. Files are logical entities, not storage-provider objects.
2. File versions are immutable; changing a file creates a new version.
3. Content is addressed by SHA-256 of its bytes.
4. Replicas live on independent devices — never two on one failure domain.
5. Placement, repair and rebalancing are automatic and invisible.
6. Control-plane metadata is critical infrastructure. Bytes without metadata is
   a lost filesystem.
7. Device failure is normal, not exceptional.
8. Complexity stays hidden from the user.

---

## 2. Repository layout

| Path | What | Stack |
| --- | --- | --- |
| `benzene-control-plane/` | Vaults, devices, files, placement, protection | Node 20, Express 5, TypeScript (strict), **PostgreSQL** via Drizzle, plus Mongo for legacy file metadata |
| `benzene-node-agent/` | Runs on a user's computer; contributes storage | Node 20, Express 5, TypeScript (strict) |
| `benzene-auth-service/` | Email/password auth, JWT issuance | Node 20, Express 5, TypeScript, PostgreSQL |
| `nebula-gateway/` | Edge: verifies JWTs, injects identity headers, routes | **Java 21**, Spring Cloud Gateway |
| `nebulavault-frontend/` | Web app | Next.js 16.3.5, React/react-dom 19.3.0, TypeScript, Tailwind + DaisyUI; routing guard in `src/proxy.ts` |
| `nebulavault-user-service/` | User profiles, quota fields | Java 21, Spring Boot |
| `infrastructure/terraform/` | S3 bucket + least-privilege IAM | Terraform |
| `scripts/smoke-agent.mjs` | Cross-package end-to-end smoke test | Node |
| `scripts/smoke-protection.mjs` | Three-device Protected repair smoke test | Node |
| `scripts/smoke-auth-gateway.mjs` | Authenticated LAN web-route and topology acceptance | Node |
| `scripts/smoke-user-profile.mjs` | Authenticated user-profile bootstrap acceptance | Node |
| `YAGNI-CODE/` | Notes on removed code. Not built. | — |
| `simple-flask-server/` | Debug scratch. Not production. | — |

**Directory names still say `nebulavault-`.** The project renamed to Benzene;
renaming those touches CI path filters, imports and Dockerfiles, so it is
deliberately deferred as its own change. The GitHub repo is
`ankit013002/Benzene`.

---

## 3. Local development

### Ports

| Service | Port |
| --- | --- |
| Frontend | 3000 |
| Gateway | 8080 |
| Auth service | 4000 |
| Control plane | 5000 |
| User service | 8082 |
| Node agent transfer server | 7070 |

### Commands

```bash
# control plane
cd benzene-control-plane
npm install && npm run dev
npm test                 # needs TEST_DATABASE_URL
npm run db:generate      # after editing src/db/schema.ts
npm run db:migrate

# node agent
cd benzene-node-agent
npm install && npm run dev

# frontend
cd nebulavault-frontend
npm install && npm run dev
# Requires Node >=20.9. The former Next.js middleware request guard now lives
# in `src/proxy.ts`.

# gateway — see the JDK note below
cd nebula-gateway && ./mvnw test
```

### Cloning onto a new machine

Nothing secret needs copying between machines. Every connection string is
local, and every secret is regenerable — a fresh clone means fresh databases,
so old signing keys have nothing to be consistent with.

```bash
# macOS prerequisites
brew install node@20 postgresql@16 mongodb-community
brew install --cask temurin@21          # gateway and user service need Java 21
brew services start postgresql@16
brew services start mongodb-community

createdb benzene && createdb benzene_auth

# One .env per service, from the committed templates
for d in benzene-control-plane benzene-node-agent benzene-auth-service; do
  cp $d/.env.example $d/.env
done
cp nebulavault-frontend/.env.example nebulavault-frontend/.env.local

# Two secrets to generate
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# -> AUTH_SECRET, identical in the frontend, gateway and auth service

node -e "console.log(require('crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"
# -> TRANSFER_SIGNING_KEY in the control plane

cd benzene-control-plane && npm install && npm run db:migrate
```

The production control-plane image includes the committed Drizzle SQL and a
compiled migrator. Run `npm run db:migrate:runtime` as an explicit one-off
release step before starting the server; migrations are not run automatically
at startup.

The gateway reads `AUTH_SECRET` from the environment, not a file:

```bash
cd nebula-gateway && AUTH_SECRET=<same value> ./mvnw spring-boot:run
```

Notes:

- **First `npm test` in the control plane downloads a ~780 MB MongoDB binary**
  for `mongodb-memory-server`. One time, per machine.
- On macOS `JAVA_HOME` usually resolves correctly via `/usr/libexec/java_home`,
  so the JDK override above is Windows-specific — but check `java -version`
  reports 21 before blaming Maven.
- The committed Maven wrappers are executable; CI uses their checked-in mode and
  does not repair permissions.
- The agent's `advertisedUrl` defaults to the machine's LAN address. On a Mac
  that is generally right; override `BENZENE_ADVERTISED_URL` if it picks a
  VPN or virtual interface.

### The JDK trap

`JAVA_HOME` on the primary dev machine points at **JDK 11**, but the gateway and
user service target **Java 21**. Maven fails confusingly without this:

```bash
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.11.10-hotspot"
export PATH="$JAVA_HOME/bin:$PATH"
```

### Environment

Control plane:

```ini
DATABASE_URL=postgres://…        # required — control-plane graph
MONGOOSE_URI=mongodb://…         # required — legacy file metadata
STORAGE_DRIVER=local|s3          # default local
TRANSFER_SIGNING_KEY=<base64 PKCS8 Ed25519>   # required for device uploads
AUTH_SECRET=<≥32 chars>
```

Node agent:

```ini
BENZENE_CONTROL_PLANE_URL=http://localhost:8080
BENZENE_ALLOCATED_BYTES=53687091200
BENZENE_DATA_DIR=~/.benzene
BENZENE_ADVERTISED_URL=http://192.168.x.x:7070   # defaults to LAN address
```

Gateway and auth service both need the **same** `AUTH_SECRET`, ≥32 chars. Both
fail fast without it — deliberately, since a weak shared key silently
undermines every downstream identity claim.

---

## 4. Architecture

### Control plane vs data plane

The separation is fundamental.

- **Control plane** answers *who, what and where*: identity, vault membership,
  which devices are online, which devices hold which object, whether protection
  is satisfied. It stores metadata and **never carries file bytes**.
- **Data plane** moves bytes: browser ↔ device, device ↔ device. Direct
  transfers, never relayed through the control plane if avoidable.

If you find yourself streaming file content through the control plane, you have
almost certainly taken a wrong turn.

### Domain model

```
User → Vault → Device → StorageAllocation
            → Replica (object hash ↔ device)
            → StoragePolicy
```

Files belong to a **vault**, not a user — so household/family vaults later need
no reshaping.

Chunking and manifests are described in the architecture doc but are **not
implemented yet**. Immutable whole-file versions are implemented; device-upload
completion records and promotes them. Whole-file placement first, deliberately
(§107).

### The upload path

```
1. Browser hashes the file (SHA-256)
2. POST /files/uploads/device       → control plane decides + reserves + signs grants
3. Browser PUTs bytes straight to each reachable device
4. Device reports possession using its Ed25519 identity
5. POST /files/uploads/device/complete → version committed when a healthy replica exists
```

Bytes never pass through Next.js, the gateway or the control plane.

---

## 5. Security model

Three distinct authentication mechanisms. Do not confuse them.

| Who | How | Where |
| --- | --- | --- |
| **User → gateway** | HS256 JWT in an `httpOnly` cookie | `nebula-gateway` |
| **Device → control plane** | Ed25519 signature per request | `/agent/**` |
| **Browser/peer → device** | Ed25519 transfer grant | agent transfer server |

### Identity headers

The gateway verifies the JWT and injects `X-User-Id` / `X-User-AuthSub` /
`X-User-Email`, **stripping any client-supplied `X-User-*` first**. Downstream
services trust those headers because only the gateway can set them — which is
why the control plane must never be publicly exposed.

`requireUser` refuses a request with no `X-User-Id` rather than defaulting to an
unowned tenant.

### Device request signatures

A device signs `METHOD\npath\ntimestamp\nsha256(body)`. Covering all four means
a captured signature cannot be replayed onto another endpoint or with altered
content.

### Transfer grants

Scoped to **one object, one device, one operation, ~5 minutes** (§81). The
expected object and operation come from the *route*, never from the grant, so a
grant for one object cannot be replayed to reach another and a read grant cannot
authorise a write. The signature is verified **before** the payload is parsed.

Deliberately not a JWT — a fixed format has no `alg` field to negotiate down.

Pending device names and platforms are not globally listed; a user must enter
the short-lived code shown on that device to approve or reject it.

Device signatures receive one-shot PostgreSQL replay claims for the exact
method, path, timestamp and body request; an otherwise valid replay inside the
timestamp window is rejected. Refresh-token rotation is atomically single-use
in PostgreSQL, so concurrent uses of one token cannot both succeed.

Email-verification token replacement and consumption are also atomic in
PostgreSQL: concurrent resends leave one current token, concurrent verification
allows one consume, and a verified credential has no outstanding verification
tokens. Password-reset consumption similarly claims one token in a transaction,
updates the password, and revokes every refresh token together.

Unauthenticated enrollment creation is database-throttled per gateway-observed
client IP, defaulting to 10 attempts per 60 seconds. The gateway strips any
caller-supplied `X-Benzene-Client-Ip` and rewrites it from its observed peer;
direct development access falls back to the socket peer. The gateway currently
uses that direct socket peer and has no trusted-forwarded-header configuration,
so clients behind another proxy or load balancer may share that upstream peer's
bucket; trusted proxy resolution must be implemented and configured before
relying on per-origin buckets. Expired pending enrollments are cleaned in
bounded batches, and approval or rejection locks only the exact normalized code
row so competing decisions serialize.

Authenticated approve/reject attempts share a database-backed per-owner pairing
budget, defaulting to 10 attempts per 60 seconds; it is separate from
device-creation peer buckets.

### Storage accounting and repair safety

Capacity admission treats the latest heartbeat's `usedBytes` as a baseline,
then adds active `placing` reservations and replicas confirmed after the
allocation's `usageReportedAt` watermark. Placement, repair, drain preflight
and allocation changes use that same accounting while locking the allocation
row, so an exact-fit reservation cannot be over-issued between heartbeats.

Upload planning transactionally revalidates existing healthy holders while
locking devices, allocations and replicas; if a concurrent drain invalidates
the snapshot, it retries once so a leaving device cannot satisfy protection.

Legacy and device-backed completion paths serialize promotion per file and always
promote the highest committed immutable version, so a late lower completion
cannot overwrite current metadata. A process crash between demotion and
promotion can temporarily leave no current version until completion is retried
after the lease expires; stored immutable versions remain intact.

Repair assignments bind a target reservation to one healthy source and a
persisted one-shot assignment id. A signed source-failure report must name
both values and arrive before the same Unix-second grant boundary; consuming
the report clears the binding so replayed or unrelated reports cannot
quarantine another replica.

Possession confirmation and repair/source-failure transitions serialize on the
replica row, so stale device possession cannot resurrect a failed repair
reservation.

Vault online-device counts and online capacity use the same last-heartbeat
liveness cutoff as device views. Raw capacity remains owned capacity, even when
a device is stale or offline.

Outage classification uses 120 seconds as the offline default and 24 hours as
the extended-offline default. Suspected-loss classification is disabled unless
`DEVICE_SUSPECTED_LOST_AFTER_SECONDS` is explicitly configured and strictly
later than the extended-offline threshold. Classification is opportunistic from
active repair and user-facing paths, not a standalone scheduler. Offline and
extended-offline replicas remain durable healthy protection, but cannot serve
downloads or repair while their device is not online. Suspected-lost devices
are quarantined and excluded from protection counts while their replica metadata
is preserved. A signed heartbeat alone does not restore a suspected-lost device.

When a presumed-lost device returns, it must complete a fresh usage heartbeat
and then submit one complete, locally hash-verified inventory. The MVP accepts
at most 8,000 whole-file objects in one authenticated request. Exact known
hash/size matches are restored; omissions and size mismatches become missing;
unknown hashes are ignored. The report is authenticated but is not independent
proof against a compromised device. Inventory reconciliation takes the same
allocation and per-object locking path as repair, so repair bindings,
reservations and capacity accounting remain safe while the device is released
from quarantine.

Availability is distinct from protection. Durable copies on offline devices can
keep protection healthy while the user-facing file state is `Waiting for
device`; an online healthy copy is `Available`, a reachable copy with active
repair is `Restoring protection`, and no durable healthy copy is `Unavailable`.

### The `/agent` prefix

Agent endpoints live under `/agent/**` and the gateway routes that prefix
**without** its session filter: a machine mid-enrollment holds no session.
User-facing device management lives under `/devices/**` **with** the filter.

**Never merge these prefixes.** Overlapping paths would force the gateway to
carve exceptions, and one mistake either locks devices out of enrollment or
exposes a user endpoint with no session check.

---

## 6. Cross-package contracts

The control plane and node agent are **separate deployables** that each hold
their own copy of two wire formats. If they drift, authentication breaks in a
way *neither package's own tests would catch* — each still passes against
itself.

Two byte-identical vector files pin them:

| Contract | Control plane | Agent |
| --- | --- | --- |
| Request signing | `src/modules/devices/protocolVectors.ts` | `src/protocolVectors.ts` |
| Transfer grants | `src/modules/placement/grantVectors.ts` | `src/grantVectors.ts` |

Both packages assert against them, **and CI diffs the files.** Ed25519 signing
is deterministic, so the vectors pin an exact signature, not merely a valid one.

**Never edit one copy alone.** Changing a wire format means regenerating the
vectors and updating both files in the same commit.

---

## 7. Testing

**Tests run against real infrastructure, not fakes.**

- Control-plane tests use a **real PostgreSQL**, one throwaway database per test
  file. The behaviour under test lives largely *in* the database — partial
  unique indexes, `for update` locking, aggregate filters — and a fake that
  disagrees with Postgres is worse than no test. Per-file databases keep each
  file isolated when the test runner runs files in parallel.
- The control-plane, node-agent and auth-service test suites use Vitest
  **4.1.11**, which preserves Node 20 compatibility and resolves the prior
  Vitest advisory.
- Frontend transfer-helper tests use Node's built-in `node:test` and
  `node:assert` through `tsx`; eight deterministic tests (five upload and three
  download) cover reservation hashing, direct Protected PUTs and grants,
  completion gating, pending and shortfall errors, download fallback,
  unresponsive-holder timeout/fallback, and safe browser download cleanup.
- `scripts/smoke-agent.mjs` runs the **real agent against the real control
  plane** over HTTP: enrollment, approval, signed heartbeat, presumed-lost
  inventory recovery, upload to device, download back, authentication
  rejection and device removal. Needs both packages built and a reachable
  Postgres.
- `scripts/smoke-protection.mjs` runs a three-device local protection smoke:
  it uploads to devices A and B, marks A presumed lost, repairs directly from
  B to C, verifies restored two-copy health, and reads the bytes back from C to
  prove they are identical. It does not test remote access, encryption,
  garbage collection, or frontend/gateway behavior.
- `scripts/smoke-auth-gateway.mjs` is the authenticated LAN acceptance: it
  starts the real auth service, control plane, Java gateway, Next server and
  two real node agents. Agents enroll through gateway `/agent`, pairing codes
  are approved through Next `/api/devices/enrollments`, and heartbeats pass
  through the gateway. It signs up through Next, captures and follows the
  verification email through loopback SMTP, renders the pending prompt, proves
  resend invalidation and replacement verification, then authenticated Next
  web routes reserve a default Protected two-device upload, expose
  completion/list/protection/read-plan results, and return direct agent URLs;
  the smoke PUTs to those URLs and verifies byte-identical reads from both
  agents. It also covers password-recovery requests and reset completion,
  one-shot token rejection, old-password rejection and new-password login. It
  is an HTTP route/topology harness, not a browser-runtime test: frontend
  helper execution, CORS, mixed-content and other browser enforcement are not
  covered. Remote/TLS transfer, encryption and garbage collection are outside
  this 60-assertion LAN smoke. The user service has a separate acceptance. It
  also checks gateway identity header stripping and anonymous rejection.

The separate `scripts/smoke-user-profile.mjs` acceptance starts the real auth
service, gateway, user service and Next frontend. It covers real signup/session,
SMTP delivery, pre-bootstrap 404, profile bootstrap and reads through the
gateway and Next bridge, persisted default profile/quota fields, Next anonymous
redirect and gateway anonymous 401 in exactly 12 `ok` assertions. It was green
in CI run `34768007763` at commit `090c7eb`.

```bash
# control plane
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm test

# end to end
node scripts/smoke-agent.mjs
node scripts/smoke-protection.mjs
node scripts/smoke-auth-gateway.mjs
node scripts/smoke-user-profile.mjs
```

Current counts: control plane **346**, agent **115**, auth **78** when its
real-Postgres concurrency tests are enabled, gateway **18**, frontend
transfer-helper **8** (five upload, three download), user-profile acceptance
**12 `ok` assertions**. The frontend suite has **18 tests** total. The core
cross-package smoke has **63 checks**; the
three-device Protected repair smoke has **40 checks**. These smoke milestones
were verified by CI run
`34719594345` at commit `41462e8`.
The integrated authenticated LAN acceptance has exactly **60 `ok` assertions**
and was green in CI run `34788300450`. Default Turbopack
and Webpack production builds pass, and a live browser check verified that the
landing page renders without an overlay and navigates to sign-in; that check
also caught and fixed CSS import ordering and a missing base selector.
The separate user-profile acceptance has exactly **12 `ok` assertions** and was
green in CI run `34768007763` at commit `090c7eb`.

CI run `34790007104` is fully green and verifies exactly **346/346
control-plane tests**, including concurrent legacy/device-backed version
reservation, reverse-order completion, and directory-listing protection
batching regressions. The versioning regressions prove that each reservation
receives a distinct immutable version number and that completing versions in
reverse order leaves the highest committed version current with matching node
metadata.

CI run `34788722098` is fully green and verifies exactly **78/78 auth tests**,
including real-Postgres concurrency regressions for refresh-token rotation,
password-reset consumption, email-verification replacement, and legacy-token
consumption.

The frontend, auth-service, gateway, control-plane and user-service production
runtime images run as dedicated non-root `benzene` users. The node agent remains
a host/LAN process. The frontend Docker context
excludes local `.env*` files while allowing the committed `.env.example`; its
runtime stage contains only `public`, Next standalone, and `.next/static`
artifacts. Full `npm audit` reports 0 vulnerabilities for the frontend,
node-agent and auth-service; the frontend's production-only
(`npm audit --omit=dev`) audit also reports 0, and the control-plane's
production-only audit reports 0. The control-plane full audit still reports
four moderate, dev-only `esbuild` findings through `drizzle-kit`; the only
offered forced fix is a breaking downgrade, so these package-specific results
must not be summarized as a repository-wide zero. Logout clears browser
credentials even when upstream revocation is unavailable; the protected client
leaves the session UI and keeps that revocation failure observable. File and
folder removal asks for confirmation, and folder removal explicitly warns that
descendants are included.

### Testing conventions

- Test names state the behaviour, not the method: *"refuses to shrink below what
  the device already stores"*, not *"setAllocation works"*.
- Comment the *why* on tests encoding a non-obvious decision.
- When fixing a bug, assert the **persisted state**, not just the thrown error.
  A real bug here — expiry recorded inside a transaction that then threw, rolling
  back the very update — was only caught because a test checked the row.

---

## 8. Working conventions

### Verification

**Do not report work as done without running it.** Typecheck, test, and build.
Where the change is visible, open it in a browser and look.

Two things caught only by looking, both after the code "passed":

- The login page still said **Nebula Vault** after the rebrand — the wordmark
  was split across two elements, so grep matched neither.
- The marketing hero renders invisible until Framer Motion animates it in. In a
  hidden browser pane rAF is throttled, so it never appears. Preview artifact,
  not a product bug — but worth knowing before chasing it.

### Git

- Trunk-based, short-lived branches, PR into `master`.
- Prefixes: `feature/`, `fix/`, `refactor/`, `chore/`, `docs/`, `test/`.
- `master` requires 1 approving review. A solo maintainer cannot satisfy that
  and merges are done with `--admin`, which **bypasses the rule**. Say so when
  you do it.
- Commit messages explain *why*, not what. State the problem, then the fix.

### Code style

- **Strict TypeScript.** No `any`, no non-null assertions to silence the checker.
- Comments explain **why**, never what. Do not narrate the code.
- Validate at the edges with zod; keep the interior typed.
- Prefer pure functions for decisions (see `placement.ts`) so they are testable
  without infrastructure.
- Match the surrounding file's idiom.

### Honesty

State limits plainly in code comments, PR bodies and summaries. If something is
unverified, say it is unverified. The Terraform README says "validated, not
applied" because no `plan` has ever run against an account — that phrasing is
the standard to match.

---

## 9. Current state

### Works

- Self-contained email/password auth; gateway JWT verification and header
  injection
- Signup verification links route through the Next server bridge to a public,
  token-free result page. The authenticated LAN smoke signs up through Next,
  captures the loopback SMTP message, renders the pending prompt, resends
  through the same-origin bridge, proves the original link is invalidated,
  verifies the replacement link and checks persisted verification. The bridge
  itself was verified by CI run `34766377357` at commit `cbaa8df`; the extended
  journey is green in CI run `34788300450` with exactly 60 `ok` assertions,
  including the already-verified resend response.
- Browser password-recovery pages and same-origin request bridges now exist;
  the same acceptance covers reset requests, reset completion, one-shot token
  rejection, old-password rejection and new-password login.
- Authenticated LAN web-route and topology acceptance through Next.js, the
  Java gateway, auth/control plane and two real node agents: enrollment and
  approval, heartbeats, a default Protected two-device upload, completion,
  listing, protection/read planning and byte-identical reads from both agents
  are verified in CI. This is not browser-runtime coverage; frontend helper
  execution, CORS/mixed-content/browser enforcement, remote/TLS transfer,
  encryption and garbage collection remain outside it. The user service has a
  separate acceptance described above.
  Gateway identity-header stripping and anonymous rejection are also covered.
- Vaults, device enrollment (pairing code, user-approved), presence/heartbeat,
  storage allocation
- Placement engine with protection policies (1/2/3 copies) and health reporting
- Presumed-lost inventory reconciliation: a fresh usage heartbeat followed by
  one locally hash-verified inventory restores known hash/size matches, marks
  omissions and mismatches missing, ignores unknown hashes, and safely updates
  repair bindings and capacity accounting (maximum 8,000 objects per request)
- Automatic whole-file LAN repair fills recorded replica shortfalls via direct
  healthy-peer transfer, with hash verification before recording the new replica
  and serialized possession-versus-repair transitions that reject stale device
  confirmations
- Coordinated whole-file drain and safe final device removal: capacity is
  preflighted, draining replicas leave protection counts, repair may copy from
  the draining source, and a signed, retry-safe node handshake waits for
  protection to return before quiescing transfers, erasing only
  Benzene-managed entries, and removing the device from the Vault
- Node agent: identity, content-addressed store, allocation ceiling, integrity
  verification, LAN transfer server
- **Uploads route to devices end to end**, with downloads reading back
- Mongo-backed upload versioning is concurrency-safe for both legacy presign
  and device-backed reservations: concurrent requests receive distinct
  immutable version numbers, and reverse-order completion leaves the highest
  committed version current with matching node metadata.
- Directory listings batch protection for all distinct current file hashes:
  one outage classification, policy load and replica/device query replaces
  per-file N+1 work. Zero-replica hashes still receive summaries, while empty
  input returns without creating vault or policy state.
- Frontend transfer helpers have eight deterministic `node:test`/`tsx` tests
  (five upload and three download) for hashing and reservation, direct
  Protected uploads, completion gating, pending/shortfall errors, download
  fallback, unresponsive-holder timeout/fallback and safe DOM cleanup. Reduced
  protection messaging is based on authoritative completion state rather than
  the reservation plan. A live browser check also verifies the landing page
  renders without an overlay and can navigate to sign-in.
- The user-profile acceptance covers real signup/session, SMTP delivery,
  pre-bootstrap 404, bootstrap and reads through the gateway and Next bridge,
  persisted default profile/quota fields, Next anonymous redirect and gateway
  anonymous 401 in exactly 12 `ok` assertions.
- Devices screen and vault summary in the web app
- File and folder removal confirmation, including an explicit recursive-folder
  warning
- Terraform for the S3 bucket (validated, never applied)
- Production Dockerfiles for the frontend, auth service, gateway, control plane
  and user service; the node agent remains a host/LAN process

### Not built

- **Outage scheduler and rebalancing** — opportunistic
  offline/extended-offline classification is implemented, and suspected-loss
  classification is opt-in via `DEVICE_SUSPECTED_LOST_AFTER_SECONDS`. Offline
  and extended-offline replicas remain durable healthy protection, but cannot
  serve downloads or repair while their device is not online; suspected-lost
  devices are quarantined, excluded from protection counts, and retain replica
  metadata. A signed heartbeat alone does not restore them: the returning node
  must complete a fresh usage heartbeat and locally hash-verified inventory
  reconciliation (one request, at most 8,000 whole-file objects). Known
  hash/size matches return to healthy, omissions and mismatches become missing,
  and unknown hashes are ignored; the authenticated report is not independent
  proof against a compromised device. Repair currently acts on recorded
  replica shortfalls and can use a draining source; final drain detach and
  device-row removal are implemented only after protection is restored and the
  node completes its signed removal handshake
- **Chunking and manifests** — whole-file placement only
- **Encryption at rest** — objects are stored as plaintext. The object format
  records `v` and `encryption: "none"` so encrypted objects can coexist later
  without a migration, but the key hierarchy and recovery story (§33) are
  undesigned. **Design this before real user data lands.**
- **Remote access / NAT traversal / relay** — LAN only
- **Garbage collection (GC)** for unreferenced stored objects
- Device removal deletes managed filesystem entries rather than securely
  overwriting media. The agent refuses unsafe roots and refuses nonempty
  legacy/unmarked store roots; use a new empty path or perform an explicit
  manual migration before enrolling such a store
- Desktop and mobile apps, filesystem mount, sharing, search, billing
- File metadata still in MongoDB, not yet migrated to Postgres

### Device-first MVP and commercial blockers

The architecture's earliest commercially testable MVP includes desktop, mobile
and web clients, with optional cloud protection. This branch validates the
control plane, node agent and web/LAN device-first slice; it is not yet that
commercial MVP. Desktop/mobile clients and filesystem mounts, remote/HTTPS
access, encryption and key recovery, cloud-protection policy and billing,
rebalancing, chunking, garbage collection, sharing and search remain blockers.
Availability, single-copy policy and key recovery remain open product
questions; this status does not resolve them.

### Known limits worth repeating

- **Browser-to-device works over the HTTP LAN development path.** CORS is
  configured for it, but an HTTPS-hosted app cannot PUT to `http://192.168.x.x`
  because of mixed content; production remote/HTTPS transfer support remains
  unfinished (§39).
- **The browser hashes whole files in memory.** `crypto.subtle` needs the full
  buffer; large files need the streaming hash chunking would bring.
- **The agent's private key is a `0600` file**, not Keychain/DPAPI/Keystore
  (§34).

### Open product questions — do not silently resolve these

1. **Availability.** The headline promise (travel, tap a file, it plays) needs a
   home device awake and reachable. Consumer desktops sleep. Cloud Protection
   covers the gap but costs money, which turns "cloud is optional" into "cloud is
   required for the headline feature".
2. **Replication factor 1.** "Maximum Capacity" is offered as a plain menu
   choice; one dead drive loses those files permanently. The engine flags
   `singleCopy` and the UI warns, but whether it should exist at all is unsettled.
3. **Key recovery.** Unsolved, and not retrofittable once devices hold real data.

If a feature depends on one of these, surface the assumption rather than picking.

---

## 10. Design language

Benzene is **monochrome** — near-black ink on paper in light, inverted in dark.

**Colour is spent only on state.** A coloured dot means a vault at risk, a
device draining, an error. Never decoration. Status colours are desaturated so
they read as information against greyscale.

Everything is token-driven in `nebulavault-frontend/src/app/globals.css`. Do not
hardcode hexes or Tailwind colour utilities (`blue-500`, `emerald-400`) —
components that did were permanently dark and ignored the theme. Use
`bg-card`, `text-muted-foreground`, `border-border`, `bg-success`, and so on.

Consumer language, never internal jargon: *Vault*, *Device*, *Protected*,
*Restoring protection*, *Being removed*. Never *replication factor*, *manifest*,
*chunk*, *NAT traversal*.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
