# Implementation Plan: `app-e2e` worker/session contention

**Branch**: `052-e2e-worker-session-contention` | **Date**: 2026-08-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/052-e2e-worker-session-contention/spec.md`

## Summary

Make the web E2E suite survive its own agent specs, **without** re-hiding them. The work is sequenced
in three stages, and the sequencing is the design decision, not an implementation detail:

1. **Measure.** Give the BFF a voice on two silent security-control activations — concurrent-session
   eviction and per-session refresh-rate rejection — and get the counts back through a channel that a
   working session can actually read.
2. **Remedy**, selected by the number, against the decision rule fixed in advance in
   [research.md §R8](research.md).
3. **Prove**, across two consecutive runs judged by count, with an empty failure-set diff.

[research.md](research.md) establishes the technical basis: four of PRD §1.2's five configuration
claims hold; the fifth — "8 workers against a cap of 10" — conflates workers with sessions, because all
eight workers present the *same* `sessionId` from one shared `storageState`. A second candidate with a
capacity of **2 per 30 s** rather than 10 fits the measured evidence at least as well. Neither has been
observed. Stage 1 exists to stop that sentence being true.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 24.14.1 (BFF, Playwright config); Bash (CI steps); YAML
(Forgejo Actions)

**Primary Dependencies**: Playwright 1.60 (official `mcr.microsoft.com/playwright:v1.60.0-noble`
image), Redis (BFF session + rate-limit store), Keycloak (CI realm), Forgejo Actions on a
capacity-1 self-hosted `kvm` runner

**Storage**: Redis — sessions (`session-manager.ts` via `cache-service.ts`) and rate-limit counters
(`rate-limiter.ts`). No schema change.

**Testing**: Jest integration tier against **real** Redis (db 1) for the BFF instrumentation; Node test
runner for the CI script guards under `scripts/__tests__/`; Playwright for the E2E outcome itself

**Target Platform**: Linux (devcontainer for local repro; `kvm` self-hosted runner for authoritative
measurement)

**Project Type**: Web application — BFF + Expo/React Native Web frontend, plus CI workflow

**Performance Goals**: Not a goal. PRD §2 is explicit that determinism is the objective and speed is
not. The only timing requirement is a constraint (below).

**Constraints**:
- `app-e2e` must finish inside `timeout-minutes: 75`; it already runs ~35 min on a capacity-1 runner.
- The agent-spec executed count must not fall and the skip count must stay at zero (051 SC-001).
- No production security control may be relaxed to suit the harness (FR-011).
- Instrumentation must not become the perturbation it measures (spec Edge Cases).

**Scale/Scope**: 177 collected web E2E tests, 8 Playwright workers, 1 shared `E2E_TEST_USER`, ~16
`agent-*.spec.ts` files.

## Constitution Check

*GATE: passes before Phase 0 research; re-checked after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| **Test-Driven Development (NON-NEGOTIABLE)** | Every instrumentation task follows the tasks-template's Verify RED → Verify GREEN pairing. The RED is honest here: the eviction and refresh-rejection assertions fail against today's silent code paths, which is the whole point. |
| **Test Type Integrity (NON-NEGOTIABLE)** | The new BFF assertions live in `tests/integration/` and run against **real** Redis on db 1, alongside the existing `concurrent-session-cap.integration.test.ts` and `rate-limiter.integration.test.ts`. No mocking of the store. |
| **Integration Test Real-Dependency Requirement** | Rate-limit counters and session sets are asserted against the real Redis client, not inferred from an HTTP status. Test keys stay on the isolated db-1 namespace and are cleaned in `afterAll`. |
| **Behavior-Descriptive Identifiers** | No `FR-###`/`SC-###`/`T###` in identifiers. Requirement IDs appear only in provenance comments — the one sanctioned exception. |
| **Logging & Monitoring** | The two new events are structured JSON through the existing `logger`, which redacts by key name. Deliberate design point: the evicted session is logged under the key **`sessionId`** precisely so the existing `SENSITIVE_KEYS` redaction applies to it (see Phase 1 below). |
| **Security (NON-NEGOTIABLE)** | Nothing loosens. FR-011 forbids raising the refresh limit for CI, which is the tempting one-line unblock; it is rejected in [research.md §R5](research.md) on principle, and recorded there so it is not quietly re-proposed. |
| **Client Auth Model** | Untouched — the BFF remains the sole token holder; only logging is added around the existing paths. |
| **Nx as the universal task runner** | Integration tests run via `pnpm nx test:integration mcm-app`, as today. |
| **SDD gate** | This spec → plan → tasks set exists before any edit to `playwright.config.ts` or the BFF, which is why it is being written first. |

**No violations.** Complexity Tracking is therefore empty and omitted.

## Project Structure

### Documentation (this feature)

```text
specs/052-e2e-worker-session-contention/
├── spec.md          # what and why (written)
├── research.md      # Phase 0 — the two candidate mechanisms and the decision rule (written)
├── plan.md          # this file
├── contracts/
│   └── contention-tally.md   # the tally line's format and its route to the digest
└── tasks.md         # Phase 2 output
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── src/
│   ├── bff-server/
│   │   ├── session-manager.ts        # + eviction event (FR-001)
│   │   └── rate-limiter.ts           # + refresh-rejection event (FR-002)
│   └── app/bff-api/auth/
│       └── refresh+api.ts            # + per-attempt outcome event (FR-003)
├── tests/integration/
│   ├── concurrent-session-cap.integration.test.ts   # extended: assert the eviction event
│   └── rate-limiter.integration.test.ts             # extended: assert the rejection event
└── playwright.config.ts              # Phase 2 only, if the measurement selects a topology change

.forgejo/workflows/app-ci.yml         # + the always() tally step, before teardown
scripts/
├── e2e-contention-tally.sh           # reads the live BFF container, prints one line, never fails
└── __tests__/
    └── e2e-contention-tally.test.mjs # pins the zero-count and ordering traps
```

**Structure Decision**: The existing layout is kept. Instrumentation goes where the behaviour already
lives — eviction in `session-manager.ts`, rejection in `rate-limiter.ts` — rather than into a new
observability module, because a counter that lives away from the branch it counts drifts from it. The
tally is extracted into `scripts/e2e-contention-tally.sh` rather than inlined into the workflow so that
its two traps can be pinned by a test; the repository already treats CI logic as testable code
(`scripts/__tests__/ci-log-step.test.mjs`, `app-e2e-env.guard.test.mjs`).

## Phase 1 — Measurement (US1, US2)

### BFF instrumentation

Three events, all through the existing structured `logger`, all with a stable marker string so the
tally can count them without regex-guessing:

| Event | Where | Emitted when |
| --- | --- | --- |
| session evicted | `evictOldestSession` in `session-manager.ts` | a session is deleted because the cap was reached |
| refresh rejected | `checkRefreshRateLimit` in `rate-limiter.ts` | the 2-per-30 s bucket rejects, immediately before `RateLimitError` is thrown |
| refresh attempted | `refresh+api.ts` | every attempt completes, carrying its outcome |

The third is not decoration: a rejection count without a denominator cannot distinguish "the bucket
never filled" from "almost nothing refreshed at all", and those imply opposite remedies.

**Redaction is obtained rather than re-implemented.** `logger` redacts by key name and its
`SENSITIVE_KEYS` already contains `sessionId`. Logging the evicted session under exactly that key means
it is redacted for free; inventing `evictedSessionId` would silently bypass the guard. `userId` is not
sensitive (a Keycloak subject UUID) and is kept — the counts are per-user, and it is what distinguishes
the shared E2E identity from the throwaway users `auth.spec.ts` creates.

**Volume control.** Eight workers over ~35 minutes, with a refresh every five minutes per context,
puts the per-attempt event in the low hundreds. That is well inside what the BFF already logs per
request and does not risk becoming the perturbation. The eviction and rejection events are rarer still.

### Getting the counts out

`scripts/e2e-contention-tally.sh` reads the live BFF container's log and prints exactly one line:

```text
[e2e-contention] refresh_total=<N> refresh_429=<M> session_evicted=<K>
```

Invoked through `bash scripts/ci-log-step.sh e2e-contention-tally …`, so it lands as a `step:` source,
which `selectSources` in `ci-failure-digest.mjs` ranks **0** — above every container log. The contract
is written down in `contracts/contention-tally.md`.

Two traps, both pinned by `scripts/__tests__/e2e-contention-tally.test.mjs` rather than trusted:

- **`grep -c` exits 1 on zero matches.** `ci-log-step.sh` re-raises the wrapped exit code by design, so
  an all-zeros tally would fail the step and the job — a diagnostic that breaks the build when it has
  the *best* news to report. The script must exit 0 on any count, including zero, and must still print
  the line when the container is absent.
- **Ordering.** The step must sit after the Web E2E step and **before** `Tear down CI stacks (always)`,
  which removes the container the counts are read from. A step ordered after teardown reports zeros for
  a structural reason that is indistinguishable from a clean result.

The step runs `if: always()` (FR-006) — a passing run's counts are what prove the contention is gone,
so discarding them on green would defeat SC-007.

### What Phase 1 does not do

No change to worker count, retries, spec selection, timeouts or any gate (FR-008). The measurement run
is expected to be **red**, and that is a correct outcome, not a failure of the stage. A green Phase-1
run is a sample from the known variance and its counts still have to be read.

### Order of measurement

1. Devcontainer repro against local Ollama first — minutes, no Anthropic spend, and both candidates are
   BFF-internal. A null result here refutes nothing ([research.md §R7](research.md)).
2. One `workflow_dispatch` of `app-ci` on this branch. Authoritative. Per
   [docs/runbooks/ci-diagnostics.md](../../docs/runbooks/ci-diagnostics.md) — a branch **push** runs
   almost nothing, because `guardrails` and `app-ci` scope `push:` to `main`, and the three traps
   documented there each produce silence that reads as a result.

## Phase 2 — Remedy (US3)

Selected by [research.md §R8](research.md)'s table, not chosen here. The plan deliberately stops short
of pre-committing, because pre-committing is the failure mode this feature was created to correct.

What *is* fixed in advance:

- The remedy addresses the mechanism that was **observed to fire**, and the rejected candidates are
  recorded with the number that rejected them (FR-013).
- If the measurement selects PRD §3.3 (a separate Playwright project and identity for the agent specs),
  it needs a second seeded user in `ci-realm.json` kept in lockstep with `dev-realm.json` — the
  realm-consistency gate in `guardrails / naming` enforces that and fails loudly on drift.
- If both counts are zero, both candidates are reported as **refuted** and diagnosis re-opens from the
  Playwright report and `trace: 'on-first-retry'`. No third mechanism is adopted without measuring it.
- No remedy may skip, deselect, narrow or gate a spec (FR-010), and none may relax a production control
  (FR-011).

**Timing constraint carried into Phase 2**: any remedy that serialises work — lowering `workers` is the
obvious one — lengthens the longest job on a capacity-1 runner. The 75-minute budget must be checked
against the *measured* duration before merging, or the job fails for a brand-new reason that looks
exactly like the old one (spec Edge Cases; PRD §5).

## Phase 3 — Proof (US4)

Two consecutive `workflow_dispatch` runs on this branch. Judged by **count** — executed, skipped,
failed — never by exit status. The failure sets are diffed by test identity (file + title); the diff
must be empty (SC-004). A shrinking-but-still-varying set is reported as *reduced*, not accepted as
fixed. Residual failures must be exclusively the seven known `agent-*` defects, each filed under
backlog item **#150**.

## Out of scope, restated so it stays out

- The seven genuine `agent-*` defects (backlog item #150). Remediating them here would make both
  problems unjudgeable.
- Overall E2E runtime.
- Feature 051's instrumentation, gates and digest work — landed and CI-green.
- The two `TEMPORARY(051)` commits inherited by this branch. Feature 051's T058 owns the revert; it
  must happen before 051 reaches `main`, and this feature must not do it early or leave it undone.

## Merge path

`052-e2e-worker-session-contention` → `051-ci-diagnostics-closure` → `main`, as one unit. The fix
**cannot** be verified on a branch cut from `main`: `main` still skips every agent spec, so `app-e2e`
would go green there whatever this feature does — the exact false-green shape both this feature and
051 exist to remove.
