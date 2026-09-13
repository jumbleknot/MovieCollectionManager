# Feature Specification: Langfuse 3 → 4, and the ClickHouse major it brings with it

**Feature Branch**: `433-langfuse-4-major`

**Created**: 2026-09-13

**Status**: Draft

**Input**: Backlog item #433 — the deferred Langfuse half of
[ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md), which ratified *upgrade both,
OpenSearch first, as separate specs*. The OpenSearch half is `specs/071-opensearch-3-major/`. This spec also
closes the residual item #412 named: the two `langfuse/*:3` allowlist entries are keyed to a **floating
major** and so cannot be discharged by any upgrade.

## Why now

Two `langfuse/*:3` entries in `security/infra-images/allowlist.yaml` suppress
CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4 (Next.js 16.2.11, fixed in 15.5.24 / 16.3.3). `:3` already floats to the
newest 3.x build, so there is no 3.x bump to make — the only upstream remediation is the major. Both entries
expire **2026-10-01**, and the 14-day warning tier opens 2026-09-17, so they are inside the window from the
Friday 2026-09-18 sweep onward.

## The finding that shapes this work

**Langfuse 4 brings a ClickHouse major with it.** Measured 2026-09-13 from Langfuse's own reference
`docker-compose.yml` on `main`:

| Service | We run today | Langfuse 4 reference compose | Delta |
|---|---|---|---|
| `langfuse/langfuse`, `-worker` | `3` (digest-pinned) | `4` | **major** |
| `clickhouse/clickhouse-server` | **`24.3`** | **`25.12`** | **major — a second stateful store** |
| `postgres` | `16-alpine` | `${POSTGRES_VERSION:-17}` | a *default*, not a floor — see below |
| `redis` | `7-alpine` | `7` | none |
| MinIO | our own from-source image (features 069/070) | `cgr.dev/chainguard/minio` | not applicable — we build ours |

ADR-0002 §6 named this exact possibility in advance and said it "may split the Langfuse spec again rather
than widen it". **This spec widens rather than splits**, for one reason that is not a judgement call:
Langfuse 4 requires ClickHouse 25, so the two cannot land separately — a Langfuse 4 on ClickHouse 24 is not
a state this repository would ever deliberately run, and a ClickHouse 25 under Langfuse 3 is an unreviewed
combination upstream does not ship.

What makes widening *safe* rather than merely necessary is ADR-0002 §4: neither production dataset is
preserved. That collapses "ClickHouse 24 → 25, a stateful migration across many majors" into **a container
swap plus a volume recreate**. There is no version-skipping risk because there is no data to carry.

## Postgres stays on 16, and that is the decision that prevents a split

`postgres:16-alpine` is **shared**: `langfuse-postgres` *and* `unleash-postgres` reference the identical
pinned digest, in both `compose.yaml` and `compose.prod.yaml`.

Unleash's store is **not** covered by ADR-0002 §4's disposability ratification — that ratification is about
the Langfuse trace store and the OpenSearch audit store, and nothing else. So moving Postgres to 17 would
drag a third stateful service, with real data, into a feature that has no mandate for it.

Upstream's `${POSTGRES_VERSION:-17}` is a **default, not a floor** — it is parameterised precisely so a
deployment can pin its own. So: **stay on 16 unless Langfuse 4 is proven to require 17**, and if it is
proven, that is a separate feature covering Unleash too, not a task bolted onto this one.

## The registry stays Docker Hub — recorded so nobody "corrects" it

Langfuse's reference compose now pulls `docker.langfuse.com/langfuse/langfuse:4`. **That is a preference,
not a requirement**: Docker Hub still publishes `langfuse/langfuse:4` and `langfuse/langfuse-worker:4`
(4.35.0 current, measured 2026-09-13). Our refs stay on Docker Hub, because moving registry would change
the Renovate datasource, the infra-image-scan enumeration, and the allowlist keys all at once, for no
security benefit. Anyone reading upstream's compose will be tempted; this paragraph is why not.

## User scenarios

### US-1 — The premise is proven before anything moves (P1, GATE)

**As** the person deciding, **I want** `langfuse/langfuse:4` and `langfuse/langfuse-worker:4` scanned with
the gate's own criteria **so that** the upgrade is known to discharge the advisory it is being done for.

**Why this priority**: identical reasoning to feature 071's US-1, and the same precedent behind it —
feature 036 moved mongo on the assumption that newer meant fixed, and it cleared nothing.

**Independent Test**: scan both digests; read CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4 in the output.

**Acceptance Scenarios**:

1. **Given** the current `:4` digests, **When** they are scanned with `--severity CRITICAL
   --ignore-unfixed`, **Then** the result states, per image, whether the advisory is present.
2. **Given** it is absent from both, **When** the gate is evaluated, **Then** proceed to US-2.
3. **Given** it is still present, **When** the gate is evaluated, **Then** **abandon**: keep
   `allowedVersions: "<4"` on packageRule 20, re-date both entries to **2026-12-01** with a justification
   naming the scanned digest, and record the outcome in ADR-0002 §3.
4. **Given** the scan reports a *different* blocking Critical introduced by 4.x, **Then** that is a new
   finding recorded on this spec — not an automatic abandon, and not something to allowlist silently.

### US-2 — Langfuse 4 and ClickHouse 25 come up together in local dev (P1)

**As** a developer, **I want** the observability stack healthy on Langfuse 4 + ClickHouse 25 **so that**
the combination is exercised before production sees it.

**Why this priority**: it is the only place the two-major combination is cheap to get wrong.

**Independent Test**: bring the stack up on recreated volumes; the gateway emits a trace and it is visible.

**Acceptance Scenarios**:

1. **Given** recreated `langfuse-postgres`, `langfuse-clickhouse` and MinIO volumes, **When** the stack
   starts, **Then** every service reaches healthy and the Langfuse migrations complete.
2. **Given** a fresh start, **When** Langfuse initialises, **Then** the ten `LANGFUSE_INIT_*` keys re-seed
   org / project / user / API keys with **no operator UI step** — the property that makes a clean start
   cheap, so it is asserted rather than assumed.
3. **Given** a healthy stack, **When** the agent gateway handles a turn, **Then** the trace appears in
   Langfuse, proving the gateway's existing credentials still authenticate against 4.x.
4. **Given** the stack is up, **When** Postgres is inspected, **Then** it is still **16** and
   `unleash-postgres` is untouched.

### US-3 — Production cuts over, and the rollback is exercised (P1)

**As** the operator, **I want** the prod observability stack moved with a rollback that has been performed
**so that** "we can roll back" is a measurement.

**Independent Test**: cut over, confirm traces land, revert both digests on recreated volumes, confirm the
3.x stack is healthy again.

**Acceptance Scenarios**:

1. **Given** the prod stack on 3.x/24.3, **When** both digests move and the volumes are recreated,
   **Then** the stack comes up healthy and new traces land.
2. **Given** 4.x is live, **When** the rollback is exercised, **Then** reverting both digests and recreating
   the volumes returns a healthy 3.x stack — the data not returning is the ratified outcome (ADR-0002 §4),
   not a failure.
3. **Given** cutover has happened, **Then** the previous trace history is understood to be gone.

### US-4 — The suppressions are re-keyed, then deleted (P2)

**As** the person who has carried these entries, **I want** them **deleted** on 4.x **so that** a regression
re-blocks.

**Why this priority**: mechanically downstream of US-1–US-3 — but note the **re-keying half is already
done** and landed ahead of this feature (see below).

**Acceptance Scenarios**:

1. **Given** 4.x is deployed, **When** both `langfuse/*` entries are **deleted**, **Then** the gate passes
   and `--check-expiring` reports neither as UNMATCHED.
2. **Given** the entries are deleted, **When** the advisory reappears, **Then** the gate **blocks**.
3. **Given** the allowlist is edited, **When** CI runs, **Then** a **real** sweep runs, not a 2-second skip.

### US-5 — SC-008's cost/latency evidence survives the major (P1)

**As** the person who has to believe SC-008, **I want** the per-turn cost and p95-latency assertions reading
an API that still exists **so that** the guarantee is verified rather than assumed.

**Why this priority**: **WIDENED INTO THIS SPEC 2026-09-13, after T010 measured it.** This spec originally
claimed "no application code changes"; that was false. Langfuse 4 **removes `GET /api/public/traces`
(404)**, and `agents/movie-assistant/tests/integration/test_observability_sc008.py` polls exactly that
endpoint via `client.api.trace.list(session_id=…)`. Left alone, SC-008's verification asserts against a
dead route — the guarantee would not fail loudly, it would stop being checked.

ADR-0002 §6 said a second migration hiding inside the first "may split the spec again rather than widen
it". This one is widened by decision: it is the *same* upgrade's blast radius, it cannot land separately
(the test is red the moment the images move), and a red would be unambiguous.

**Independent Test**: run the SC-008 integration test against the Langfuse 4 stack; it must pass for the
same reasons it passed on 3.x — real cost, real latency, real breach detection.

**Acceptance Scenarios**:

1. **Given** the stack on 4.x, **When** the SC-008 test polls for a session's turns, **Then** it reads
   `observations.get_many(session_id=…, is_root_observation=True)` — the v4 path — and **not**
   `trace.list`, which 404s.
2. **Given** real Claude turns, **When** the turns are read back, **Then** each carries a non-zero
   `total_cost` and a `latency`, so the budget assertions mean what they meant on 3.x.
3. **Given** the ingestion path, **When** the gateway emits a turn, **Then** it still arrives — the gateway
   ships langfuse SDK 4.15.1 and writes over **OTLP**, measured 200, and is *not* affected by the legacy
   ingestion endpoint's `events_only` rejection.
4. **Given** someone reintroduces a legacy read, **When** the guard runs, **Then** it fails — a 404 read
   path must not be able to return silently.

## Requirements

- **FR-001** The US-1 scan MUST run against **digests**, not the floating `:4` tag, and the digests MUST be
  recorded in `research.md`.
- **FR-002** The scan MUST run where Trivy is authoritative. If run locally, `TRIVY_DB_REPOSITORY` MUST be
  set to a reachable mirror — `mirror.gcr.io` is **unreachable** from the dev container and Trivy exits **1**
  on a DB download failure, which is indistinguishable from "found findings" if only the exit code is read
  (measured 2026-09-13, item #436). `ghcr.io/aquasecurity/trivy-db:2` works.
- **FR-003** No compose file, `renovate.json` rule or allowlist entry may change before FR-001 has a recorded
  result.
- **FR-004** `langfuse/langfuse`, `langfuse/langfuse-worker` **and** `clickhouse/clickhouse-server` MUST move
  together, in both `compose.yaml` and `compose.prod.yaml`, version tag **plus digest**.
- **FR-005** `postgres` MUST stay at `16-alpine` unless Langfuse 4 is **proven** to require 17. If it is,
  that is a separate feature scoped to include `unleash-postgres`, which shares the identical pinned digest.
- **FR-006** The image references MUST stay on **Docker Hub**. Upstream's `docker.langfuse.com` is a
  preference; Docker Hub publishes the same tags.
- **FR-007** `renovate.json` packageRule 20's `allowedVersions: "<4"` MUST be removed in the same change that
  moves the images, and its `description` **rewritten to record the outcome**, not deleted.
- **FR-008** The ClickHouse move MUST also drop or re-key any allowlist entry whose key names `24.3`, so an
  entry cannot outlive the image it describes.
- **FR-009** Both `langfuse/*` entries MUST be **deleted**, never re-dated, once 4.x is deployed.
- **FR-010** The rollback MUST be **performed** once, not merely documented.
- **FR-012** The SC-008 integration test MUST read turns via `observations.get_many(session_id=…,
  is_root_observation=True)`. `client.api.trace.list` and `GET /api/public/traces` are **removed** in
  Langfuse 4 and MUST NOT be used.
- **FR-013** The gateway's ingestion path MUST NOT be changed. It ships langfuse SDK 4.15.1, which writes
  over OTLP; the legacy `POST /api/public/ingestion` rejection in `events_only` mode does not affect it.
  `LANGFUSE_MIGRATION_V4_WRITE_MODE=dual` MUST NOT be set — it is upstream's bridge for clients that cannot
  be upgraded, it restores only *ingestion*, and it would mask exactly the breakage this feature fixes.
- **FR-014** `src/observability.py`'s docstring MUST stop describing the handler as "v3". The dependency is
  already correct (`langfuse>=2.0,<5` resolving to 4.15.1); the prose is what is wrong, and it nearly
  produced the wrong diagnosis during T010.
- **FR-011** If the US-1 gate fails, the feature MUST end with the ADR-0002 §6 fallback and MUST NOT leave a
  half-moved stack or a lifted ceiling.

## Out of scope

- **Preserving Langfuse trace history.** Ratified against in ADR-0002 §4.
- **Postgres 17 and `unleash-postgres`.** Explicitly excluded by FR-005; it would need its own mandate.
- **Moving to `docker.langfuse.com`.** FR-006.
- **The OpenSearch major** — feature 071.
- **Migrating the gateway's INGESTION** — it is already v4-native (FR-013). Only the READ path moves.

## Success criteria

- **SC-001** A full infra-image sweep passes with both `langfuse/*` entries **absent** and no UNMATCHED
  report.
- **SC-002** The agent gateway's traces are visible in Langfuse 4 in production, verified by an actual turn.
- **SC-003** A rollback to 3.x/24.3 has been executed once and returned a healthy stack.
- **SC-004** `postgres` is still 16 and `unleash-postgres` is byte-identical to before the feature.
- **SC-006** The SC-008 integration test passes against Langfuse 4, asserting real cost and real
  latency — not skipped, not weakened.
- **SC-005** Either packageRule 20's ceiling is lifted, or it carries a re-dated justification naming a
  **scanned digest**.

## Assumptions

- The ten `LANGFUSE_INIT_*` keys already in compose are sufficient to seed a fresh 4.x instance. US-2 #2
  asserts this rather than assuming it, because the whole cheapness of the migration rests on it.
- ClickHouse 25.12 accepts an empty data directory and lets Langfuse's migrations create its schema — true
  by construction for a recreated volume, but stated because it is the step that replaces a data migration.
- Redis 7 remains compatible; upstream's reference compose still declares `7`.
