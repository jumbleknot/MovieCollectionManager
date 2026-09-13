# Implementation Plan: Langfuse 3 → 4, and the ClickHouse major it brings with it

**Spec**: [spec.md](./spec.md) · **Decision**: [ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md)
· **Sibling**: `specs/071-opensearch-3-major/` · **Backlog**: item #433 (and the residual from item #412)

**Primary dependencies**: `langfuse/langfuse:4`, `langfuse/langfuse-worker:4`,
`clickhouse/clickhouse-server:25.12` (all upstream, pulled);
`infrastructure-as-code/docker/observability/compose{,.prod}.yaml`; the Komodo `prod-observability` stack;
`renovate.json` packageRule 20; `security/infra-images/allowlist.yaml`.

**~~No application code changes.~~ FALSIFIED 2026-09-13 — see [research.md](./research.md).** The gateway's
*ingestion* is unaffected (it ships langfuse SDK 4.15.1 and writes over OTLP — measured 200), but Langfuse 4
**removes `GET /api/public/traces` (404)**, and
`agents/movie-assistant/tests/integration/test_observability_sc008.py` reads exactly that endpoint to assert
per-turn cost and latency. This feature therefore DOES touch `agents/`, which is SDD-gated, and whether to
widen this spec or split the test migration into its own feature is an open decision.

## Approach

Same shape as feature 071 — **a gate, then a narrow change** — with one difference that is the whole story
of this feature: it moves **two** majors at once, because it has to.

```
Phase 0  GATE    scan langfuse:4 + langfuse-worker:4 → is the Next.js advisory gone?
                   │
         ┌─────────┴──────────┐
       cleared            still present
         │                    │
Phase 1  local: BOTH majors   ADR-0002 §6 fallback: re-date both entries naming the
Phase 2  prod cutover         scanned digests, keep allowedVersions "<4". STOP.
Phase 3  rollback drill
Phase 4  lift ceiling, delete entries
```

## Why two majors in one branch is the correct batching here

[PR batching](../../openwiki/process/pull-request-batching.md) says to split when a red would be ambiguous.
That rule does not bite here, because the two cannot be separated: **Langfuse 4 requires ClickHouse 25**
(upstream's own reference compose), so a branch moving only one produces a combination upstream does not
ship. A red is therefore never ambiguous between them — there is only one change.

ADR-0002 §6 anticipated this and left the split-or-widen call open. It is answered *widen*, and the reason
it is safe rather than merely necessary is ADR-0002 §4: with the trace store not preserved, ClickHouse
24 → 25 is a container swap plus a volume recreate. **There is no version-skipping risk because there is no
data to carry** — which is the one thing that would otherwise make a 24 → 25 jump a multi-step migration.

## The decision NOT to move Postgres, and why it belongs in the plan

Upstream declares `postgres:${POSTGRES_VERSION:-17}`. It is tempting to follow.

`postgres:16-alpine` is **shared with `unleash-postgres`** — the identical pinned digest, in both compose
files. Unleash's data is *not* covered by ADR-0002 §4's disposability ratification, which names the Langfuse
trace store and the OpenSearch audit store and nothing else. Moving Postgres would therefore pull a third
stateful service with real data into a feature with no mandate for it, and it would do so invisibly, because
the shared digest means one edit moves both.

`${POSTGRES_VERSION:-17}` is a default, not a floor. So Postgres stays at 16 (FR-005), and if Langfuse 4
turns out to require 17, that is a separate feature scoped to include Unleash — not a task appended here.

## Sequencing

**Phase 0 — the gate.** Resolve both `:4` tags to digests; scan with `--severity CRITICAL --ignore-unfixed`;
record per-image whether CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4 is present, plus the bundled Next.js version,
because that is what the current justification asserts. Also record any *new* blocking Critical 4.x
introduces — a finding, not an automatic abandon (US-1 #4).

> **Instrument, before the result is believed.** If this is run locally, set
> `TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2`. `mirror.gcr.io` is unreachable from the dev
> container and Trivy exits **1** on a DB-download failure — indistinguishable from "3 criticals found" if
> only the exit code is read. That mistake was made and caught on 2026-09-13 (item #436), and it would read
> here as "the gate failed, abandon the feature".

**Phase 1 — local, on recreated volumes.** Move all three images in `compose.yaml`. Recreate
`langfuse-postgres`, `langfuse-clickhouse` and the MinIO volume. Bring the stack up and check the three
things a healthcheck does not cover: Langfuse's migrations complete; the ten `LANGFUSE_INIT_*` keys re-seed
org/project/user/API keys with no UI step (US-2 #2 — the property the whole migration's cheapness rests on);
and a real gateway turn produces a visible trace, proving the existing credentials still authenticate.

**Phase 2 — production.** Move `compose.prod.yaml`, redeploy `prod-observability` onto recreated volumes.
Verified by an **actual trace from a real turn** (SC-002), not by container health — a healthy Langfuse that
rejects the gateway's credentials is exactly the failure this stack would hide.

**Phase 3 — the rollback drill.** Revert all three digests, recreate the volumes, confirm a healthy 3.x/24.3
stack (FR-010). After cutover, so it exercises the real path.

**Phase 4 — the ceiling and the deletions.** Lift packageRule 20's `allowedVersions: "<4"`, rewriting its
description to record the outcome (FR-007). Delete both `langfuse/*` entries (FR-009). Re-key or drop any
allowlist entry naming `24.3` (FR-008) — an entry must not outlive the image it describes. Last, because CI
proves it: editing `security/infra-images/**` forces a real sweep.

## Testing strategy

No unit-testable logic; the artifacts are compose files, a config rule and a YAML allowlist. Verification is
existing gates plus two guards that do not yet exist:

| What | How |
|---|---|
| The advisory is actually gone | The infra-image gate on a forced real sweep (Phase 4) |
| No entry left matching nothing | `--check-expiring`, whose execution is now itself observable (item #418) |
| All three images moved together | `infra-image-scan.test.mjs` (412) — every third-party ref digest-pinned |
| **Postgres did not move** | **New guard**: `langfuse-postgres` and `unleash-postgres` reference the *same* digest, and it is a `16-` tag. This is the FR-005 tripwire and the one most likely to be violated by accident, because a single find-and-replace moves both |
| The ceiling was lifted deliberately | `renovate-workflow.guard.test.mjs` — packageRule 20 either holds `<4` or names a scanned digest |
| The gateway can still authenticate | A real turn producing a real trace — asserted in the agent E2E tier, not by a container healthcheck |

The Postgres guard is written **RED first against the current tree**: it must fail if either reference moves
off 16 or if the two stop agreeing, and both mutations are checked before it is trusted.

## Risks

- **The gate passes but 4.x introduces a different blocking Critical.** US-1 #4 makes this a recorded
  finding rather than a silent allowlist entry.
- **Langfuse 4 requires Postgres 17 after all.** Then FR-005 forces a stop, not a workaround: the feature
  pauses and a Postgres/Unleash feature is specified. Discovering this in Phase 1 is cheap; discovering it
  in Phase 2 is not, which is why the local bring-up asserts the Postgres version explicitly.
- **ClickHouse 25.12 changes a setting Langfuse's migrations depend on.** Contained by the recreated volume —
  there is no existing schema to be incompatible with.
- **The two entries expire 2026-10-01 mid-flight.** Nine allowlist entries share that date and enter the
  14-day warning window from the **2026-09-18** sweep, so the weekly check goes red before this feature can
  plausibly land. That red is correct and is item #406's to triage — it is **not** a reason to rush this
  feature, and re-dating there does not weaken the case for the major.
- **Someone "corrects" the registry to `docker.langfuse.com`.** FR-006 and the spec's own section exist
  because upstream's compose invites exactly that.
