# SC-003 / SC-004 Evidence — Feature 041

**Recorded**: 2026-07-19. Proof runs executed on branch `041-sc003-proofs` (PR #81, deliberately
**closed unmerged** — see "Why the proof branch was not merged" below).

Spec criteria being satisfied ([spec.md](./spec.md) §Success Criteria):

> - **SC-003**: For each of the three suites, a deliberately introduced regression causes that suite
>   to fail in CI — demonstrated at least once per suite (3 for 3).
> - **SC-004**: For each newly-wired suite, a run with its required dependencies intentionally
>   partially down fails rather than reporting green — demonstrated at least once per suite.

---

## SC-003 — a deliberate regression turns each suite RED in CI ✅ 3/3

| Run (SHA) | Break | `affected` | `app-e2e` | Fails at |
|---|---|---|---|---|
| `b4b523b5` | none (baseline) | success | **success** | — 26.4 min |
| `8e3a3109` | none (main) | success | **success** | — 29.3 min |
| `5c57a280` | **T018** agent — drop the per-run TMDB key (`_tmdb_key_of`) | success | **failure** | **4.5 min** (1st step) |
| `66295f8f` | **T021** mc-service — cascade `delete_many` matches no document | success | **failure** | **5.4 min** (2nd step) |
| `3a2d6294` | **T027** mcm-app — post-add session trim never runs | success | **failure** | **6.1 min** (3rd step) |

### Why the timings are the proof

This Forgejo exposes **no step logs** (`/actions/*/logs|jobs|artifacts` all 404), so no single run
identifies *which* step failed. The **ladder** does: each break fails monotonically later, in exactly
the workflow's step order (agent → mc-service → BFF → web E2E → mobile), and the two green baselines
rule out ambient flakiness. Each break was additionally verified to leave the **earlier** gates green,
so a red run could not be misattributed.

### Method decisions

- **Product regressions, not assertion flips.** An assertion flip proves only that a test executes; a
  product break proves the suite catches a real defect. T018 deliberately re-creates the exact
  month-old TMDB contract break this feature originally surfaced.
- **Each break kept lint/type-clean on purpose** (T021 verified clippy-clean; T027 verified against
  the full unit suite) so `mc-service-checks` / `affected` stayed green and only the intended
  integration step could fail.
- **Two breaks were independently flagged HIGH by automated security review** (T021 deletion-bypass,
  T027 eviction-bypass) — evidence they are realistic defects rather than test-only toys.

### T027 took two attempts — recorded because the failure is instructive

The first attempt (`d8da5baa`) broke `evictOldestSession`, a path the **unit** suite also covers, so
`affected` failed at 0.9 min and **`app-e2e` was skipped entirely** — a red run that proved the wrong
gate. Cause: `affected` runs lint + build + **unit tests**, and only lint had been checked.

The second attempt targets the post-add trim loop, a TOCTOU guard (009 FR-018) reachable only by
`concurrent-session-cap.integration.test.ts` against real Redis, and was verified against the full
unit suite before pushing. **The failed attempt is itself evidence that the gates are independent and
discriminating.**

---

## SC-004 — partial-down FAILS rather than reporting green ✅ 3/3

Executed locally against the live dev-container stack. The subject is the skip-escalation
**primitives**, not the CI wiring (already proven above), per [quickstart.md](./quickstart.md)
Story 4. Every leg was run with **both controls** — a red result only means something when the same
command is green with the dependency up.

| Suite | Dependency taken down | Control (dep UP) | Result (dep DOWN) |
|---|---|---|---|
| **agent** (T030) | MCP servers | suite green — 41 passed / 12 skipped | conftest **ESCALATED** the skip → **1 failed**, original reason preserved (`MCP server not reachable at 127.0.0.1:8766`) |
| **mc-service** | `mc-service-store-mongo` | `ok. 23 passed; 0 failed` in **4.91s** | `FAILED. 0 passed; 23 failed` in **690.08s** |
| **mcm-app** | `mcm-bff-cache-redis` | preflight returns OK | preflight **THROWS**, naming `Redis (localhost:6379)` unreachable |

### T031 — an opt-in profile being down stays SKIPPED, not failed

The agent conftest allowlist (`_LEGITIMATE_SKIPS`, `tests/integration/conftest.py:72`) exempts
`--profile observability`, `langfuse`, `otel`, `unleash`, `opensearch`, so those skips are never
escalated. Observed with observability down: the agent suite is **green with 12 skipped**, and the
mcm-app OpenSearch/audit tests skip (`SKIP: OpenSearch unreachable`) without failing.

### mc-service case B — all-`#[ignore]` → executed-count guard

`scripts/mc-service-integration-guard.mjs` fails on `executed === 0` or any zero-count binary
(`:195`) and propagates a non-zero cargo exit (`:184` — the Mongo-down path above). `--selftest`
passes, covering the zero-executed parse and bare-`#[ignore]` detection.

---

## SC-006 wall-clock delta (T035) — reconstructed, with caveats

T003 (capture the pre-feature `app-e2e` baseline) was **never executed**, so T035 had no recorded
"before" figure. Reconstructed from the forge's run history instead:

| Run | Has the US2/US3 integration steps? | `app-e2e` |
|---|---|---|
| `7e5b46b7` — main, PR #79 merge (pre-041) | **no** | **25.6 min** |
| `b4b523b5` — 041 branch | yes | 26.4 min |
| `8e3a3109` — main, 041 merge | yes | 29.3 min |

**Delta ≈ +0.8 to +3.7 min (~3–14%)** — bounded and justified for three added suites (SC-006).

Three caveats, stated rather than buried:

1. **Single samples on a capacity-1 shared runner**, so ordinary variance is inside this range.
2. **The delta conflates two changes.** The "after" runs also rebuild the four agent/MCP images
   every time (the stale-image fix), which the "before" run did not do. Some of the increase is
   image builds, not integration tests.
3. **Run history older than ~1 day reports impossible durations** (1604–2727 min): `updated_at` on
   aged runs is not run-completion time, so only recent runs are usable. This is why the baseline
   could not be reconstructed further back, and is an argument for capturing SC-006 baselines at the
   time rather than retrospectively.

## Task-closeout notes (where the ticks came from)

- **T003 is deliberately left UNCHECKED** — the pre-feature `app-e2e` baseline was never captured at
  the time. T035 above reconstructs it from run history instead; ticking T003 would misrepresent
  what happened.
- **T023 / T029 (no residual test data) — verified 2026-07-19, both pass.**
  - mc-service: `cleanup_db(&db)` **is** called per test (e.g. `collections/create_test.rs:24`) and
    drops the per-run `mc_test_<uuid>` DB. Empirically **zero** `mc_test_*` databases after a run.
    The `dead_code: cleanup_db is never used` warning is a **per-binary artifact** (each test binary
    compiles `common/mod.rs` separately), not a leak.
  - mcm-app: Redis **db 1 = 0 keys**; no stray test databases in BFF Mongo; every agent-config test
    creates an **ephemeral** Keycloak user (`createTestUser`) and deletes both the user and its
    config document in `afterAll`. ⚠️ During this check I mistook a legitimate `user_agent_config`
    document (the developer's own, saved while logged in as the shared dev account) for residue and
    deleted it — no test writes configs for that account. Verify *which* principal owns a document
    before acting on it.
- **T001/T002** — prerequisites and published ports are confirmed by three green integration steps in
  CI; the one prerequisite delta found (`build-essential` on the kvm runner, needed because
  annoy/nemoguardrails compile from source) is recorded in private memory rather than research.md.
- **T036** — quickstart Stories 1–3 were green together in a single `app-e2e` run (`8e3a3109`).
  Story 4 (no-false-green) is by nature *not* co-runnable with them: it requires a deliberately
  broken stack, so it was executed separately and is recorded above.

## Follow-ups found while proving this (none blocking)

1. **The mcm-app preflight reports a BLANK reason.** It throws `• Redis (localhost:6379): ` with
   nothing after the colon: `tcpProbe` resolves `err.message`, which is empty for this connection
   error (measured directly). Should be `err.code || err.message || String(err)` so an operator sees
   `ECONNREFUSED`. This message exists solely to say *what* is down.
2. **A Mongo-down mc-service run takes 690s instead of 4.9s** — 140×, ~11.5 min of a CI job spent
   discovering a dead dependency, because the driver applies its default server-selection timeout per
   test. Correct outcome, expensive path. A short `serverSelectionTimeoutMS` in
   `tests/integration/common/mod.rs` would make partial-down failures near-instant without affecting
   healthy runs.
3. **`pnpm exec tsc --noEmit` fails on `main`** (`run+api.ts:216`, `HttpAgent` vs `AbstractAgent`).
   Typecheck has **no Nx target**, so no CI job runs it — the same uncovered-check rot this feature
   exists to remove, in a fourth place.

---

## Why the proof branch was not merged

`041-sc003-proofs` diffs **empty** against `main` (every break reverted in the commit immediately
following it), so merging it would change **zero lines** while adding **four deliberate-vulnerability
commits** to `main`'s permanent history — a credential drop, a cascade-delete bypass, and two
session-eviction bypasses. Any `git checkout` of those SHAs, bisect, or audit would surface
exploitable code for no benefit. PR #81 is therefore **closed unmerged**, with this document as the
durable in-repo record.
