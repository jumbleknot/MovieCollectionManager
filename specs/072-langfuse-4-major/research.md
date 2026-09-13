# Phase 0 research — the Langfuse 4 gate

**Date**: 2026-09-13 · **Spec**: [spec.md](./spec.md) · **Tasks**: T001–T004 · **Backlog**: item #433

## T001 — the digests under test

```
langfuse/langfuse:4                  -> sha256:a5d8d2457702ab7e051bc0788d73871970caebd10aae6635e87cfb736e4067cd
langfuse/langfuse-worker:4           -> sha256:5e35e625a214dd868bb22adad90fc52e8f83cc856c3750e47f9a922622c207fb
clickhouse/clickhouse-server:25.12   -> sha256:8a790dd3468db22b1d4e7b18a176f378ff5ff6053b9c48dd4ea1fa71a24c5ba6
```

Resolved on **Docker Hub** per FR-006 — upstream's reference compose pulls `docker.langfuse.com`, which is a
preference rather than a requirement, and Docker Hub publishes the same tags (4.35.0 current).

ClickHouse is scanned alongside deliberately: the spec widens rather than splits, so 25.12 is part of this
change and a new blocking advisory there would block the feature just as surely as one in Langfuse.

## T002 — how they were scanned

```
trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed --scanners vuln
```

trivy **0.74.0**, the version pinned in `infra-image-scan.yml`.

> **INSTRUMENT — set BOTH mirrors.** `mirror.gcr.io` is unreachable from the dev container, and trivy exits
> **1** on a DB-download failure, which is indistinguishable from "findings were blocked" by exit code alone.
> A Java image additionally needs the **Java DB**, which `TRIVY_DB_REPOSITORY` does not cover — that bit the
> sibling feature 071 gate, where the first run "failed" having analysed no JARs at all. Use:
>
> ```
> TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2
> TRIVY_JAVA_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-java-db:1
> ```
>
> **A verdict is only readable from a run with zero `FATAL` lines.** All three runs below had zero.

## T003 — the measurement

| Image | exit | FATAL | Fixable CRITICAL |
|---|---|---|---|
| `langfuse/langfuse:4` | **0** | 0 | **none** |
| `langfuse/langfuse-worker:4` | **0** | 0 | **none** |
| `clickhouse/clickhouse-server:25.12` | **0** | 0 | **none** |

**CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4 is ABSENT from all three.**

And it is absent because it is **fixed**, not because trivy failed to look: the bundled package is

```
next: 16.3.3
```

which is exactly the fixed version the current allowlist justification names ("fixed in 15.5.24 / 16.3.3").
That distinction matters — an advisory missing from a scan and an advisory remediated in the artifact look
identical in a summary table, and only the second one justifies deleting a suppression.

**No new blocking advisory is introduced** by either the Langfuse major or the ClickHouse major (US-1 #4's
other branch) — including by ClickHouse 25.12, which is the half of this change with no security argument of
its own and therefore the one that could only ever cost.

## T004 — VERDICT: **PROCEED**

Both branches of US-1 #2 are satisfied: the advisory is absent from both Langfuse images, and the ClickHouse
major that Langfuse 4 requires introduces nothing blocking.

Proceed to Phase 1 — the Postgres tripwire (T005/T006) — **before** any image moves, per the task order.

---

# Phase 1–2 partial verification — 2026-09-13

## What was verified, and how

The dev observability stack was **running on 3.x with 36 hours of data**, and its compose file pins both
container names *and* volume names, so `docker compose -p <other>` cannot isolate a second copy. Rather
than destroy a running stack to test an upgrade, a throwaway project was derived from the real compose
file — same image digests, same environment, renamed containers/volumes, network aliases mapping the
original hostnames, and no published ports.

**Result — the data tier of this upgrade is sound on fresh volumes:**

| Service | Version under test | Result |
|---|---|---|
| `clickhouse-server` | **25.12** (the major Langfuse 4 drags in) | **healthy** on an empty volume |
| `postgres` | **16-alpine** — unchanged, per FR-005 | **healthy** |
| `redis` | `7-alpine` — unchanged | **healthy** |

That ClickHouse 25.12 initialises cleanly from empty is the single most load-bearing assumption in this
spec ("Assumptions": *ClickHouse 25.12 accepts an empty data directory*), and it is now measured rather
than assumed. Postgres staying healthy on **16** is FR-005's premise holding.

## Phase 1–2 completed against the REAL dev stack — 2026-09-13 (option 1)

The throwaway could not start MinIO (a uid artifact on a correctly-`chown`ed volume), so T008–T010 were
re-run against the real dev stack: the langfuse services only were removed, the **Postgres and ClickHouse
volumes deleted**, and the stack brought back up on `:4` / `25.12`.

`unleash-service`, `unleash-postgres`, `opa-service`, `otel-lgtm` and the agent gateway stayed up
throughout — FR-005's isolation demonstrated live, not merely asserted by the guard.

> **The MinIO volume was deliberately NOT recreated** (a deviation from T008). A fresh MinIO volume failed
> to initialise even when `chown`ed to `1000:1000`, so recreating it risked not getting the dev stack back.
> It holds blobs, not schema, and is irrelevant to whether Langfuse 4's migrations run. Recorded rather
> than quietly skipped.

### T008 — PASS

48 ClickHouse migrations applied cleanly against an empty **ClickHouse 25.12**, then
`▲ Next.js 16.3.3 / ✓ Ready`. All six services healthy. Postgres stayed on **16** and Unleash was untouched.

### T009 — PASS

```
/api/public/health                         -> 200
/api/public/projects  (seeded PK/SK)       -> [{"id":"movie-assistant","name":"movie-assistant"}]
```

The ten `LANGFUSE_INIT_*` keys re-seed org / project / user / API keys with **no operator UI step**. This
spec’s cheapest-path assumption is now measured.

### T010 — PASS on the write path, and it found a BREAKING CHANGE

Ingestion works, but **only over OTLP**, and the legacy read API is gone:

| Path | Result |
|---|---|
| `POST /api/public/otel/v1/traces` (langfuse SDK **4.15.1**, the version the gateway ships) | **200** |
| ClickHouse `events_core` / `events_full` | **3 rows each** — the data landed |
| `GET /api/public/v2/observations` | **200, 3 rows** — readable |
| `POST /api/public/ingestion` (legacy v3) | **rejected** — `events_only` mode, "these events were not stored" |
| `GET /api/public/traces` | **404 — the route no longer exists** |

## THE FINDING THAT INVALIDATES PART OF THIS SPEC

`plan.md` states **"No application code changes."** That is **FALSE**, and this is why the local run
mattered:

- `agents/movie-assistant/tests/integration/test_observability_sc008.py` polls the **traces** API
  ("Poll the LangFuse API until the session's traces are ingested") and asserts each turn's cost and
  latency. That endpoint now **404s**. SC-008's guarantee — per-turn cost/latency visible — has to be
  re-read from `/api/public/v2/observations`.
- Anything still using the legacy `/api/public/ingestion` path silently stops being stored. The gateway is
  **not** affected: it ships langfuse SDK **4.15.1**, which ingests over OTLP and returned 200.
  `src/observability.py`'s docstring still says "the **v3** langchain `CallbackHandler`" — stale prose,
  not a stale dependency, but it will mislead the next reader.

Upstream names a bridge — `LANGFUSE_MIGRATION_V4_WRITE_MODE=dual` on web **and** worker — which restores
legacy ingestion. It does **not** bring back `GET /api/public/traces`, so it does not rescue the SC-008
read path.

**Consequence: this feature cannot land as specified.** Its scope now includes a change under `agents/`,
which is SDD-gated, and the decision of whether to widen this spec or split the test migration into its own
feature has not been taken.

**Do not merge PR #440 on the strength of the green gate above.** The prod cutover would leave SC-008's
integration test asserting against a 404.

---

# Phase 2b — the read-path migration, and the trap inside it (2026-09-13)

## T025–T027

A guard was written first (`langfuse-v4-read-path.guard.test.mjs`) and its RED was **honest**: it caught the
real defect at `test_observability_sc008.py:89`, not a planted one. `_fetch_turns` then moved to
`observations.get_many(session_id=…, is_root_observation=True)`, and `src/observability.py`'s stale
"**v3** langchain CallbackHandler" docstring was corrected (FR-014).

## T028 — the first run FAILED, and that is the point

| | |
|---|---|
| turns read back | **5** — the v4 read path works |
| `latency_ms` | **490 / 452 / 774** — real |
| `cost_usd` | **None on every turn** ❌ |

**v4's observations API uses SPARSE FIELDSETS, and `usage` is not in the default set.** The migration was
syntactically correct and returned real turns with real latency, while silently dropping the one thing
SC-008 exists to prove. The cost was in ClickHouse the entire time:

```
events_full.provided_model_name = claude-haiku-4-5-20251001
events_full.usage_details       = {input:14, output:4, total:18}
events_full.total_cost          = 0.000034
```

The failure mode is nastier than a 404: `cost_usd=None` reads as *"the model wasn't priced"* — a plausible,
wrong diagnosis pointing at `_register_model_price` — rather than *"the field wasn't requested"*.

Fixed by requesting the fieldsets explicitly:

```python
fields="core,basic,metrics,usage"   # usage -> totalCost; metrics -> latency; basic -> sessionId
```

**The guard could not have caught this.** It checks that no *removed* API is referenced, and
`observations.get_many` satisfies it with or without `fields`. Only running the real test against real
Claude turns surfaced it — which is what T028 is for, and why SC-008 asserts on cost rather than merely on
"turns came back".

## T028 — final result: PASS

```
3 passed, 1 skipped, 114 deselected
SKIPPED [1] test_observability_sc008.py:211: needs Vault :8200 and VAULT_DEV_ROOT_TOKEN_ID
```

The skip is an **unrelated, pre-existing Vault test**, not SC-008. SC-008 passed with real non-zero cost and
real latency against Langfuse 4, so SC-006 holds.

## What is STILL open before PR #440 can merge

**The production volumes.** `plan.md` Phase 2 says "redeploy onto **recreated** volumes", but Komodo
reconciles the existing stack — merging alone does **not** recreate anything. Prod would start Langfuse 4
against the live 3.x Postgres schema and ClickHouse 25.12 against a **24.3 data directory**, which is the
in-place multi-major jump this spec avoids by recreating.

Everything verified above was verified **on fresh volumes**. Nothing here says an in-place upgrade works.
T013 therefore needs an operator step at cutover — recreate the prod volumes — or a deliberate decision to
attempt the in-place path, which would preserve the trace history ADR-0002 §4 was willing to discard.
