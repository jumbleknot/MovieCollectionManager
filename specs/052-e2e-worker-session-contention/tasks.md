---
description: "Task list for 052 — app-e2e worker/session contention: measure, then remedy, then prove"
---

# Tasks: `app-e2e` worker/session contention

**Input**: Design documents in `specs/052-e2e-worker-session-contention/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[contracts/contention-tally.md](./contracts/contention-tally.md)

**Backlog**: item **#164** (`type/bug`, `p1`, `status/needs-spec`) — blocks item **#158**.
Item **#150** (`type/bug`, `p3`) owns the seven `agent-*` defects and is **out of scope**.

**Tests**: MANDATORY. The constitution's TDD principle is non-negotiable. Both behaviours added here
are *silent* code paths — a session evicted with no trace, a refresh rejected with no trace — so a
change that is not RED-verified would be indistinguishable from no change at all. That is the exact
defect this feature exists to remove.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no dependency on an incomplete task
- **[Story]**: `[US1]`…`[US4]`; Setup / Measurement / Polish tasks carry no story label
- Every test task carries a **Verify RED**; every implementation task a **Verify GREEN**

> **A Verify RED showing 0 failures is a failed task, not a passed one.** Check the collected count as
> well as the failure count — a selector that matches nothing also reports no failures.

> **Judge by counts, never by exit status.** This applies to every CI task below. A green tick is the
> thing that was wrong before.

> **Phase 5 is expected to be RED.** The measurement run's job status is not its result; the tally line
> is. A green Phase-5 run is a sample from the known 33-vs-61 variance, not a success.

---

## Phase 1: Setup — baselines, so later claims have something to be measured against

- [X] T001 Record the local integration-tier baseline for `mcm-app`
  - **Type**: Verification | **Risk**: None
  - **Command**: `pnpm nx test:integration mcm-app`
  - **Expected**: green. Record exact collected/pass/fail/skip counts in this task.
  - **Why**: T009/T014's GREEN is judged against this delta, not against zero-in-the-abstract. A
    skipped test reads as a pass; watch the SKIP COUNT (`MCM_REQUIRE_LIVE_STACK=1` turns a skip into a
    failure — see [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md)).
  - **MEASURED (Linux dev container, 2026-08-09)**: **115 collected, 114 pass, 1 fail, 0 skipped**,
    30 suites, ~34 s. Skip count **0** — nothing is hiding behind a green.
  - **The 1 failure is env-gated, not a code failure**: `agent-config-probes.integration.test.ts`,
    the TMDB case — it needs host→TMDB egress, which this container's firewall blocks **by design**.
    [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md) names this suite as
    known-env-gated. Its sibling Ollama case now **passes** (the runbook lists 2 failures here; the
    nested `dev-ollama` container has since made `localhost:11434` real), so the documented count is
    one better than written.
  - **Env recipe needed to get here — the runbook's is now incomplete.** First attempt gave
    **84 failed / 31 passed** on `getaddrinfo ENOTFOUND keycloak-service`. Cause: `.env.local` on this
    path carries only the three secret lines `gen-dev-env.mjs` writes, so
    `tests/integration/setup/env.ts` falls through to `.env.docker`, whose URLs are Docker-internal.
    The runbook's §2 recipe predates that fallback (feature 041 T024) and exports neither `KEYCLOAK_URL`
    nor `MONGO_URL`. Working invocation — the same host-reachable overrides `app-e2e` applies:
    ```bash
    export KEYCLOAK_URL=http://localhost:8099 BFF_BASE_URL=http://localhost:8082 \
           MONGO_URL=mongodb://localhost:27018 REDIS_TEST_URL=redis://localhost:6379/1 \
           KEYCLOAK_SERVICE_CLIENT_SECRET=$(grep '^KEYCLOAK_SERVICE_CLIENT_SECRET=' \
             infrastructure-as-code/docker/stacks/auth.env | cut -d= -f2-) \
           AGENT_CONFIG_ENC_KEY=$(grep '^AGENT_CONFIG_ENC_KEY=' frontend/mcm-app/.env.docker | cut -d= -f2-)
    pnpm nx test:integration mcm-app
    ```
    Carried to **T032** — this is exactly the "it can't run in this environment" trap CLAUDE.md's
    fourth gate names, and it cost a cycle here. ✔

- [X] T002 [P] Record the script-suite baseline
  - **Type**: Verification | **Risk**: None
  - **Command**: `node --test "scripts/__tests__/*.test.mjs"`
  - **Expected**: green on Linux. Record exact counts — T017's GREEN is the delta from this.
  - **MEASURED (Linux dev container, 2026-08-09)**: **517 tests, 517 pass, 0 fail, 0 skipped**,
    exit 0, ~5.4 s. Matches the figure PRD §7 records for the 051 branch. ✔

- [X] T003 Confirm the local stack can reproduce the failing condition at all
  - **Type**: Verification | **Risk**: Medium — may prove infeasible, which is itself a result
  - **Steps**: bring the auth + mcm stacks up per
    [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md); run the web E2E against the
    dev-container BFF with `E2E_AGENT_PRODUCTION=1` and the local Ollama provider.
  - **Expected**: the suite runs with agent specs **executing** (skip count 0).
  - **Honesty note**: per [research.md §R7](./research.md), a local run is **not authoritative**.
    Worker count follows the host's core count and agent latency drives how many token-expiry
    boundaries a run crosses — the two variables the hypothesis turns on. A local null result refutes
    nothing. Record the observed worker count and duration; they are context for T020, not evidence.
  - **Before writing this off as "this environment can't do that"**: a credential-driven skip here is
    almost always a missing gitignored `.env.local`, not a missing capability
    ([docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md)). Name the missing file and check
    whether `gen-dev-env.mjs` supplies it before retiring anything to CI.
  - **Done when**: either a reproduction procedure is recorded, or the specific blocker is named.
  - **MEASURED (2026-08-09) — feasible.** The full local stack was already up: `keycloak-service`,
    `mcm-bff-cache-redis`, `mcm-bff-store-mongo`, `mc-service` + its replica-set Mongo,
    `mcm-bff-service-nonsecure` (dev-container BFF on :8082), `movie-assistant-gateway` + all three
    MCP servers, and `dev-ollama`.
  - **Plumbing verified end-to-end** with one cheap spec:
    `docker run --rm --network host … mcr.microsoft.com/playwright:v1.60.0-noble` running
    `agent-cors.spec.ts` with `E2E_AGENT_PRODUCTION=1 E2E_REQUIRE_AGENT_STACK=1` →
    `[global-setup] BFF request-path confirmed: X-BFF-Source=dev-container @ http://localhost:8082`,
    then **1 passed, 0 skipped**. The gate un-gates and the spec *executes* — it does not skip-to-green.
  - **The runbook's "Ollama nuance" is superseded.**
    [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md) records (2026-07-16) that
    `host.docker.internal:11434` is unreachable from the gateway, so `MODEL_PROVIDER=ollama` "cannot
    work in here". Re-measured from inside the container today: the gateway reaches it and lists
    `qwen2.5:latest`, `qwen2.5:0.5b`. The nested `dev-ollama` container closed that gap. Carried to
    **T032**.
  - **Checked before running anything**: no orphaned `mcr.microsoft.com/playwright:v1.60.0-noble`
    containers. The e2e-testing runbook records (measured today) that killing the shell does **not**
    kill a containerized run, and an abandoned one keeps competing for the same shared test user —
    which would silently corrupt exactly the measurement this feature exists to take.
  - **Deferred deliberately**: the *contention* condition needs the full parallel suite, and a full
    local run before the instrumentation exists would measure nothing. That run is **T020**, after
    T017. ✔

---

## Phase 2: Foundational — the readable channel, before anything writes to it

**⚠️ Blocking**: US1's events are unreadable without US2's channel, and US2's channel is untestable
without a known-shape event. Build the contract first so both sides agree.

- [ ] T004 Freeze the tally contract
  - **Type**: Design | **Risk**: None
  - **File**: [contracts/contention-tally.md](./contracts/contention-tally.md) (written)
  - **Done when**: the marker string, the three counter names, the `0`-vs-`unavailable` distinction and
    the always-exit-0 rule are settled and not re-litigated below.

**Checkpoint**: contract fixed — US1 and US2 can proceed in parallel.

---

## Phase 3: User Story 1 — the BFF says out loud when it drops a session (P1) 🎯

**Goal**: Two silent security-control activations become observable, with a denominator.

**Independent Test**: Drive the BFF past each threshold against real Redis and assert the event.

### Tests for User Story 1 ⚠️ Write FIRST, verify RED

- [ ] T005 [P] [US1] Assert an eviction event in
      `frontend/mcm-app/tests/integration/concurrent-session-cap.integration.test.ts`
  - **Type**: Test (integration, real Redis db 1 — no mocking, per Test Type Integrity)
  - **Assert**: creating sessions beyond `MAX_CONCURRENT_SESSIONS` for one user emits an event carrying
    the fixed marker and the `userId`.
  - **Verify RED**: `pnpm nx test:integration mcm-app` — this case FAILS (today `evictOldestSession`
    logs nothing). Record the failure count and confirm the case was actually **collected**.

- [ ] T006 [P] [US1] Assert a refresh-rejection event in
      `frontend/mcm-app/tests/integration/rate-limiter.integration.test.ts`
  - **Type**: Test (integration, real Redis db 1)
  - **Assert**: exceeding the 2-per-30 s refresh bucket for one `sessionId` emits a rejection event
    **before** `RateLimitError` is thrown, and the counter is asserted against the real Redis client
    directly — not inferred from the thrown error (Integration Test Real-Dependency Requirement).
  - **Verify RED**: FAILS today. Record counts.

- [ ] T007 [P] [US1] Assert a per-attempt refresh outcome event in
      `frontend/mcm-app/tests/integration/auth-refresh.integration.test.ts`
  - **Type**: Test (integration)
  - **Assert**: every refresh attempt emits an outcome event, for both the success and the rejected
    path — so `refresh_429` has a denominator.
  - **Verify RED**: FAILS today. Record counts.

- [ ] T008 [US1] Assert the redaction property
  - **Type**: Test (integration)
  - **Assert**: no emitted event contains token, cookie, password or raw session-id material. The
    evicted session must be logged under the key **`sessionId`** so the logger's existing
    `SENSITIVE_KEYS` redaction applies — a key like `evictedSessionId` would bypass the guard silently.
  - **Verify RED**: FAILS today (no events exist to inspect). Record counts.

### Implementation for User Story 1

- [ ] T009 [US1] Emit the eviction event in `frontend/mcm-app/src/bff-server/session-manager.ts`
  - **Type**: Implementation | **Risk**: Low | **Requirements**: FR-001, FR-004
  - **Where**: `evictOldestSession`, at the point the oldest session is deleted.
  - **Verify GREEN**: T005 passes; `pnpm nx test:integration mcm-app` collected count is **≥** T001's
    and fail count is 0.

- [ ] T010 [US1] Emit the rejection event in `frontend/mcm-app/src/bff-server/rate-limiter.ts`
  - **Type**: Implementation | **Risk**: Low | **Requirements**: FR-002, FR-004
  - **Where**: `checkRefreshRateLimit`, immediately before `RateLimitError` is thrown.
  - **Scope guard**: touch the refresh rule's rejection path only. Do **not** change any limit,
    window or `retryAfterSeconds` — FR-011 forbids relaxing a production control for the harness, and
    [research.md §R5](./research.md) records that rejection so it is not quietly re-proposed.
  - **Verify GREEN**: T006 passes.

- [ ] T011 [US1] Emit the per-attempt outcome in
      `frontend/mcm-app/src/app/bff-api/auth/refresh+api.ts`
  - **Type**: Implementation | **Risk**: Low | **Requirements**: FR-003, FR-004
  - **Verify GREEN**: T007 and T008 pass.

- [ ] T012 [US1] Confirm the instrumentation is not the perturbation
  - **Type**: Verification | **Risk**: Medium
  - **Check**: estimate emitted volume over the E2E window (8 workers × ~35 min × one refresh per
    5 min per context ≈ low hundreds of attempt events) and compare against what the BFF already logs
    per request. If it is not clearly inside existing per-request volume, demote the per-attempt event
    to `debug` and re-derive the denominator another way.
  - **Done when**: the estimate is written into this task with the comparison it was judged against.

**Checkpoint**: US1 delivers standalone value — the BFF gains permanent honest observability of two
security controls, useful well beyond this feature.

---

## Phase 4: User Story 2 — the measurement survives the trip back (P1) 🎯

**Goal**: The counts reach a channel a working session can read, on green runs as well as red.

### Tests for User Story 2 ⚠️ Write FIRST, verify RED

- [ ] T013 [P] [US2] Create `scripts/__tests__/e2e-contention-tally.test.mjs`
  - **Type**: Test (Node test runner) | **Requirements**: FR-005, FR-007
  - **Assert**: given a fixture log, the script prints exactly one line matching the contract's shape,
    with correct counts.
  - **Verify RED**: `node --test scripts/__tests__/e2e-contention-tally.test.mjs` FAILS — the script
    does not exist. Confirm the file was collected, not silently skipped.

- [ ] T014 [US2] Pin the zero-count trap
  - **Type**: Test | **Requirements**: FR-006
  - **Assert**: with a fixture log containing **no** matching events, the script prints `0` for each
    counter and exits **0**.
  - **Why this is its own task**: `grep -c` exits 1 on zero matches and `ci-log-step.sh` re-raises the
    wrapped exit code by design. Without this pin, the all-zeros measurement — the best possible news —
    fails the job.
  - **Verify RED**: FAILS.

- [ ] T015 [US2] Pin the unavailable-vs-zero distinction
  - **Type**: Test | **Requirements**: FR-005
  - **Assert**: with the container absent, the script prints `unavailable` (not `0`) for each counter
    plus a one-line reason, and still exits 0. `0` means "measured, nothing happened"; `unavailable`
    means "not measured". SC-001 is met only by the former, so conflating them would let a structural
    failure pass as a clean result.
  - **Verify RED**: FAILS.

- [ ] T016 [US2] Pin the step ordering in `.forgejo/workflows/app-ci.yml`
  - **Type**: Test (guard, alongside `scripts/__tests__/app-e2e-env.guard.test.mjs`)
  - **Assert**: the tally step exists, carries `if: always()`, appears **after** the Web E2E step and
    **before** `Tear down CI stacks (always)`, and is invoked through `ci-log-step.sh`.
  - **Why**: teardown removes the container the counts are read from. A step ordered after it reports
    zeros for a structural reason indistinguishable from a clean result.
  - **Verify RED**: FAILS — no such step yet.

### Implementation for User Story 2

- [ ] T017 [US2] Write `scripts/e2e-contention-tally.sh`
  - **Type**: Implementation | **Risk**: Low | **Requirements**: FR-005, FR-006
  - **Behaviour**: read the live `mcm-bff-service-nonsecure` container log, count the three markers,
    print the contract line, **always exit 0**.
  - **Verify GREEN**: T013–T015 pass; `node --test "scripts/__tests__/*.test.mjs"` collected count is
    **≥** T002's and fail count is 0.

- [ ] T018 [US2] Add the tally step to `.forgejo/workflows/app-ci.yml`
  - **Type**: Implementation | **Risk**: Medium — edits the merge-gate workflow
  - **Placement**: after `Web E2E (Playwright container; host network → dev BFF)`, before
    `Tear down CI stacks (always)`. `if: always()`. Invoked as
    `bash scripts/ci-log-step.sh e2e-contention-tally bash scripts/e2e-contention-tally.sh`.
  - **Verify GREEN**: T016 passes.

- [ ] T019 [US2] Confirm the digest actually carries it
  - **Type**: Verification | **Requirements**: FR-007, SC-007
  - **Check**: `selectSources` in `scripts/ci-failure-digest.mjs` ranks `step:` sources 0, and
    `DIGEST_MAX_SOURCES = 3` does not hold the tally back behind higher-ranked evidence.
  - **Done when**: verified against the real digest output in T020/T021 — **not** by reading the
    ranking code alone. Reading the code is what predicted this would work; the run is what shows it.

**Checkpoint**: a count emitted anywhere in the BFF now arrives where it can be read.

---

## Phase 5: Measurement — spend one run to answer a question that has been argued twice from config

- [ ] T020 Local probe (optional, cheap, non-authoritative)
  - **Type**: Measurement | **Risk**: Low
  - **Depends on**: T003, T017
  - **Run**: the local reproduction from T003 with the instrumentation in place; read the tally.
  - **Record**: the three counts, the worker count, the duration, the provider.
  - **Honesty**: a null result here refutes **nothing** ([research.md §R7](./research.md)). Say so in
    the record rather than letting a zero read as an answer.

- [ ] T021 Authoritative measurement run — `workflow_dispatch` of `app-ci` on this branch
  - **Type**: Measurement | **Risk**: Medium — may consume the full 75-minute budget and real
    Anthropic spend on both the first attempt and its `retries: 1` re-run
  - **Depends on**: T009–T011, T017, T018
  - **How**: dispatch, do **not** push — `guardrails` and `app-ci` scope `push:` to `main`, so a branch
    push runs almost nothing. Follow [docs/runbooks/ci-diagnostics.md](../../docs/runbooks/ci-diagnostics.md),
    including its three traps, each of which produces silence that reads as a result.
  - **FR-008 scope guard**: this run changes **no** worker count, retry count, spec selection, timeout
    or gate. It measures the failing condition; it does not treat it.
  - **Expected**: **RED**. That is a correct outcome for this task. The result is the tally line, not
    the job status.
  - **Record in this task**: `refresh_total`, `refresh_429`, `session_evicted`; the Playwright
    collected/passed/failed/flaky counts; the agent-spec executed and skipped counts; the duration.
  - **Done when**: all three counters have a **numeric** value (SC-001). `unavailable` does not close
    this task — it means the channel failed and T017/T018 need fixing first.

- [ ] T022 Apply the decision rule and record the verdict
  - **Type**: Decision | **Risk**: None
  - **Rule**: [research.md §R8](./research.md), fixed in advance so the remedy is selected by the
    number rather than by whichever story reads best afterwards.
  - **Requirements**: FR-013 — record the rejected candidates **with the number that rejected them**.
  - **If both counts are zero**: both candidates are **refuted**. Write that plainly, mark US3 blocked,
    and re-open diagnosis from the Playwright report and `trace: 'on-first-retry'`. Do **not**
    substitute a third untested mechanism and ship against it.
  - **Done when**: the chosen remedy is named, with the measurement that chose it.

**Checkpoint**: the mechanism is known by measurement for the first time. US3 can be scoped.

---

## Phase 6: User Story 3 — the contention is removed, not tuned around (P2)

**Goal**: Remove the coupling the measurement identified.

**⚠️ Deliberately underspecified until T022.** Pre-committing to a remedy is the failure mode this
feature was created to correct. The tasks below are the *frame*; T023 fills it.

- [ ] T023 [US3] Expand this phase into concrete tasks from T022's verdict
  - **Type**: Planning | **Risk**: None
  - **Must include**: a RED-verified test per behavioural change, the file paths touched, and the
    75-minute budget check from T027.
  - **Constraints that hold whatever is chosen**: FR-009 (agent-spec executed count must not fall,
    skip count stays 0), FR-010 (no skipping, deselecting, narrowing or gating), FR-011 (no production
    control relaxed).

- [ ] T024 [US3] Implement the selected remedy
  - **Type**: Implementation | **Risk**: To be assessed at T023
  - **If it is PRD §3.3** (separate Playwright project + identity for `agent-*.spec.ts`): the second
    seeded user must be added to `ci-realm.json` **and** kept in lockstep with `dev-realm.json` — the
    realm-consistency gate in `guardrails / naming` enforces this and fails loudly on drift.
  - **If it is PRD §3.1** (`workers`): treat it as an unblock, not an answer, and keep T027's budget
    check binding.
  - **Verify GREEN**: per T023's tasks.

- [ ] T025 [US3] Prove no spec was hidden to achieve the result
  - **Type**: Verification | **Requirements**: FR-009, FR-010, SC-003
  - **Check**: the `agent-*.spec.ts` executed count is **≥** T021's and the skip count is **0**.
    Compare test identities, not just totals — a narrowed selection can leave the total unchanged.
  - **Done when**: both counts are recorded against T021's.

---

## Phase 7: User Story 4 — proved twice, by count (P2)

- [ ] T026 [US4] First verification run — `workflow_dispatch` on this branch
  - **Type**: Measurement
  - **Record**: collected / passed / failed / flaky / skipped; the agent-spec executed and skip counts;
    the tally line; the duration; **and the full failing-test identity list** — T028 cannot diff what
    was not captured.

- [ ] T027 [US4] Second verification run, consecutive, same commit
  - **Type**: Measurement | **Requirements**: SC-002, SC-006
  - **Record**: the same set as T026.
  - **Budget check**: both durations must be inside `timeout-minutes: 75`. A remedy that serialises
    work lengthens the longest job on a capacity-1 runner; overrunning fails the job for a brand-new
    reason that looks exactly like the old one.

- [ ] T028 [US4] Diff the two failure sets by test identity
  - **Type**: Verification | **Requirements**: SC-004
  - **Expected**: **empty**.
  - **If non-empty**: the contention was **reduced, not removed**. Report it that way. Do not accept a
    shrinking-but-still-varying set as a fix — that is the outcome SC-004 exists to catch.

- [ ] T029 [US4] Triage every residual failure
  - **Type**: Verification | **Requirements**: SC-005, FR-012
  - **Expected**: exclusively the seven known `agent-*` defects from PRD §1.4.
  - **Action**: file each under backlog item **#150**. Do **not** fix them here — conflating them with
    the contention makes both unjudgeable.

- [ ] T030 [US4] Confirm the tally is present on the **passing** runs
  - **Type**: Verification | **Requirements**: SC-007
  - **Why**: a green run's counts are the evidence the contention is gone. If the tally only appears on
    red runs, FR-006 is unmet and the proof rests on the absence of failures rather than on a
    measurement.

---

## Phase 8: Polish and knowledge capture

- [ ] T031 [P] Record the outcome in the PRD
  - **File**: [docs/proposals/PRD-E2EWorkerSessionContention.md](../../docs/proposals/PRD-E2EWorkerSessionContention.md)
  - **Content**: move it off **Proposed**; answer §6's four open questions with the measured numbers;
    and state explicitly whether §1.2's mechanism held. If [research.md §R3](./research.md)'s
    prediction was wrong, say so there — a correction that is recorded stays checkable.

- [ ] T032 [P] Write the learning where a session would look for it
  - **Rule**: a concept citing a `resource` is a derived summary — write into the **cited source**, not
    the concept ([openwiki/INSTRUCTIONS.md](../../openwiki/INSTRUCTIONS.md)). Candidates:
    [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md) (shared-identity contention and
    how it presents) and [docs/runbooks/ci-diagnostics.md](../../docs/runbooks/ci-diagnostics.md) (the
    `step:`-source channel as the way to get a measurement out).
  - **Never** into `CLAUDE.md` — it is an index, and `check-openwiki-governance.mjs` fails on prose
    beyond the index and its three managed regions.

- [ ] T033 Close backlog item **#164** against its acceptance criteria
  - **Rule**: close when the criteria in the body are met and **verified** — not when a PR merges.
  - **Check first**: #158 is blocked by #164; a blocked item cannot be closed (412). Order matters.

- [ ] T034 Merge into `051-ci-diagnostics-closure`
  - **Path**: `052-…` → `051-…` → `main`, as one unit.
  - **⚠️ Do not merge 051 to `main` with the two `TEMPORARY(051)` commits present** (`fcb1975`,
    `b0dbb1d`). Feature 051's **T058** owns that revert. This feature must neither do it early nor
    leave it undone — check `git log` before claiming the branch is clean.
  - **Also still open on 051, and not this feature's to touch**: T034, T049, T056–T058, T061.

---

## Dependencies

```text
T001,T002,T003  →  T004  →  ┌── T005–T008 → T009–T012   (US1)
                            └── T013–T016 → T017–T019   (US2)
                                        ↓
                              T020 → T021 → T022        (measurement + decision)
                                        ↓
                              T023 → T024 → T025        (US3, scoped by T022)
                                        ↓
                              T026 → T027 → T028 → T029 → T030   (US4)
                                        ↓
                              T031–T034
```

US1 and US2 are parallelizable after T004. Everything from T021 onward is strictly sequential: each
step's scope is determined by the previous step's measurement.

## Parallel opportunities

- T001 / T002 / T003 — different tiers, no shared state
- T005 / T006 / T007 — different test files
- T013 / T014 / T015 — same file, so **not** parallel; T016 is a different file and is
- T031 / T032 — different documents
