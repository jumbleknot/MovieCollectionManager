# Tasks: Test-harness remediation (048)

**Input**: [spec.md](./spec.md) · [plan.md](./plan.md)

## Format

**Test tasks and their paired implementation tasks follow
[`docs/templates/feature-test-tasks-template.md`](../../docs/templates/feature-test-tasks-template.md)**,
as mandated by the constitution's TDD Checkpoint Format (constitution.md:112). Each carries
`Scenarios covered`, a fenced `Verify RED` with an `Expected RED`, and a paired implementation task
with `Verify GREEN` plus a touched-suite regression run.

Pure operational tasks (CI wiring, recording cassettes, docs) use the lighter checkbox form — they are
not test tasks and the template does not apply to them.

**Scenario IDs**: `US<n>-AC<m>` refers to acceptance scenario *m* of User Story *n* in spec.md.

> **Verify RED is mandatory.** A `Verify RED` showing 0 failures means the test is trivially passing
> and must be corrected before implementation begins.

---

## Phase 1: Setup

- [x] **T001** Create the branch `048-test-harness-remediation`. *(done 2026-08-07)*
- [ ] **T002** Capture CURRENT baselines, so every later count is measured rather than assumed. Record
  the results in this file:
  - `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → passed / skipped / failed
  - `pnpm nx test:integration spreadsheet-mcp` → expect **2 failed**
  - `pnpm nx test:integration movie-mcp` → expect **20 passed**
  - live-model tests in `app-ci`'s agent-integration step → expect **9**

---

## Phase 2: Foundational (blocking — close the skip-to-green paths FIRST)

These land while the tests still run live, so "a missing cassette goes red" is demonstrable **before**
the cassettes exist. Doing this after the conversion would make it unfalsifiable.

### T003 — Assert a cassette miss propagates out of model construction

**Type**: Test | **Time**: 30m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 1 — FR-003, FR-004

**Scenarios covered**:
- US1-AC2: a supervisor-prompt edit makes the assertions fail with `CassetteMissError` — never skip
- US1-AC3: a deleted cassette fails the run; a missing cassette MUST NOT be reported as a pass

**File(s)**: `agents/movie-assistant/tests/integration/test_out_of_domain.py`

Constructs the supervisor model under `LLM_CASSETTE_MODE=replay` with no matching cassette and asserts
`CassetteMissError` propagates to the caller rather than being converted to a skip by
`_supervisor_model()`'s blanket `except Exception`.

**Verify RED** (run before implementing — test must fail):
```bash
pnpm nx test:integration movie-assistant -- -k cassette_miss_propagates
```
**Expected RED**: 1 test failing — reports SKIPPED where a raised `CassetteMissError` was expected.

### T004 — Narrow the model-fixture exception handler

**Type**: Implementation | **Time**: 20m | **Risk**: Low

**Spec reference**: same as T003

**Prerequisite**: T003 complete and verified RED.

Narrow `_supervisor_model()`'s `except Exception` so `CassetteMissError` is re-raised; only genuine
build/connect failures skip.

**Verify GREEN**:
```bash
pnpm nx test:integration movie-assistant -- -k cassette_miss_propagates
```
**Expected GREEN**: 0 failures — "1 passed"

**Also run the touched suite**:
```bash
pnpm nx test:integration movie-assistant -- -k out_of_domain
```

### T005 — Assert `invoke_or_skip` re-raises a cassette miss

**Type**: Test | **Time**: 20m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 1 — FR-003

**Scenarios covered**:
- US1-AC2: drift must fail loudly rather than skip, on every path that can raise it

**File(s)**: `agents/movie-assistant/tests/unit/test_live_model_helpers.py` (new)

`invoke_or_skip` classifies failures by **substring** (`overloaded`, `529`, `rate_limit`, `429`). A
`CassetteMissError` whose text happened to contain one of those would be silently converted to a skip.
Asserts classification by exception **type** for the cassette case.

**Verify RED**:
```bash
pnpm nx test movie-assistant -- -k invoke_or_skip_cassette
```
**Expected RED**: 1 test failing — a `CassetteMissError` carrying a capacity keyword is skipped rather than raised.

### T006 — Classify the cassette case by type in `live_model.py`

**Type**: Implementation | **Time**: 15m | **Risk**: Low

**Spec reference**: same as T005

**Prerequisite**: T005 complete and verified RED.

**Verify GREEN**:
```bash
pnpm nx test movie-assistant -- -k invoke_or_skip_cassette
```
**Expected GREEN**: 0 failures — "1 passed"

**Also run the touched suite**:
```bash
pnpm nx test movie-assistant
```

- [ ] **T007** *Measure before changing.* Count how many of the 41 existing golden pairs currently lack
  a cassette; record the number here. **If 0**, remove the `"no cassette"` entry from
  `tests/integration/conftest.py`'s `_LEGITIMATE_SKIPS`. **If not 0**, scope the entry to the
  `test_golden_pairs` dataset path only and record why. (Open item from plan.md.)

### T008 — Prove a deleted cassette turns the golden gate red

**Type**: Test | **Time**: 20m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 1 — SC-002

**Scenarios covered**:
- US1-AC3: a deleted cassette fails the run; it MUST NOT be reported as a pass

Delete one cassette, run the gate, confirm red, restore it.

**Verify**:
```bash
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
```
**Expected**: non-zero exit; the failure names the missing cassette. **This is SC-002.**

### T009 — Assert a single cassette implementation exists

**Type**: Test | **Time**: 15m | **Risk**: None

**Spec reference**: [spec.md](./spec.md) FR-001

**Scenarios covered**:
- US1-AC1: the tests run through the existing seam; no second record/replay mechanism is introduced

**Verify**:
```bash
grep -rn "class .*\(Replay\|Recording\)ChatModel" agents/movie-assistant/src/
```
**Expected**: exactly 2 matches, both in `src/eval/cassette.py`. A third is a second mechanism (FR-001 violation).

---

## Phase 3: User Story 1 — keyless topic confinement at merge (P1) 🎯

- [ ] **T010** Record cassettes for all 8 parametrized prompts + the full-graph scenario against the
  **gate** model: `LLM_CASSETTE_MODE=record MODEL_PROVIDER=anthropic pnpm nx test:integration
  movie-assistant -- -k out_of_domain`. Commit the cassette JSON.
- [ ] **T011** Record the same scenarios against the **runtime** model (strategy §5.6 — routing bugs are
  model-specific). Record which model IDs were used.

### T012 — Enrol the topic-confinement tests in the keyless replay gate

**Type**: Implementation | **Time**: 15m | **Risk**: Medium

**Spec reference**: [spec.md](./spec.md) User Story 1 — FR-002, SC-001

**Scenarios covered**:
- US1-AC1: with no `ANTHROPIC_API_KEY` and `LLM_CASSETTE_MODE=replay`, all 9 assertions execute and pass, SKIP COUNT 0
- US1-AC4: the tests are no longer selected in `app-ci`'s live-key integration step

**Prerequisite**: T010 and T011 complete (cassettes must exist before the marker deselects the live path).

**File(s)**: `agents/movie-assistant/tests/integration/test_out_of_domain.py`

Add `@pytest.mark.golden`. This single change enrols the file in the keyless replay gate **and**
deselects it from `app-ci`'s live-key step, because the two CI selectors are complementary.
**Do not move the file to `tests/golden/`** — the runner globs `tests/integration`, so a relocated file
would run nowhere.

**Verify GREEN** (with `ANTHROPIC_API_KEY` unset):
```bash
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
```
**Expected GREEN**: T002's baseline pair count **+ 9 passed, 0 skipped, 0 failed**. **This is SC-001.**

- [ ] **T013** Confirm the deselection: `pnpm nx test:integration movie-assistant -- -m "not golden"` no
  longer collects the 9 tests. *Expected*: live-model count **9 → 0**. **This is SC-003.**

### T014 — Prove the gate is sensitive, not merely present

**Type**: Test | **Time**: 20m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 1

**Scenarios covered**:
- US1-AC2: a supervisor-prompt edit fails the gate with `CassetteMissError`

Edit the supervisor prompt, run the gate, confirm failure, revert.

**Verify**:
```bash
LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant
```
**Expected**: red with `CassetteMissError` — **not** a skip, and not green.

---

## Phase 4: User Story 2 — live model gate before deploy (P1)

**Must ship with US1.** Merging Phase 3 alone drops the live verification.

- [ ] **T015** Add an Nx target for the live gate that runs the `golden`-marked tests with
  `LLM_CASSETTE_MODE` **unset** (`off`) against the real provider. Expose it as an Nx target, not a bare
  CLI call (constitution: Nx as universal task runner).

### T016 — Assert the live gate fails without a credential

**Type**: Test | **Time**: 30m | **Risk**: Medium

**Spec reference**: [spec.md](./spec.md) User Story 2 — FR-007

**Scenarios covered**:
- US2-AC3: the gate FAILS when it cannot obtain a credential — it MUST NOT skip its way to green

**File(s)**: `agents/movie-assistant/tests/integration/test_golden_pairs.py`

**Verify RED**:
```bash
pnpm nx test:golden-live movie-assistant
```
**Expected RED**: 1+ tests failing — today a credential-less `off`-mode run skips ("ANTHROPIC_API_KEY not set").

### T017 — Make the live gate fail closed on a missing credential

**Type**: Implementation | **Time**: 20m | **Risk**: Medium

**Spec reference**: same as T016

**Prerequisite**: T016 complete and verified RED.

**Verify GREEN**:
```bash
pnpm nx test:golden-live movie-assistant
```
**Expected GREEN**: 0 failures with a credential present; non-zero exit with it absent.

- [ ] **T018** Wire the gate into `.forgejo/workflows/cd-deploy.yml` **before** the "Scan, push…" /
  "Promote digest" / "Fire signed Komodo redeploy webhook(s)" steps. Set
  `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_CD_GOLDEN }}` (created 2026-08-07) — **not**
  `ANTHROPIC_API_CI_E2E`, which would re-conflate two surfaces US4 separates. Record whether it is a
  `needs:` job or an in-job step. Add **no** `schedule:` trigger. *Covers*: US2-AC1, US4-AC5.
- [ ] **T019** Verify by result: force the gate to fail on a scratch branch; confirm **no digest is
  promoted and no webhook fires**. *Covers*: US2-AC2. **This is SC-004.**
- [ ] **T020** Confirm a provider 529 is still distinguishable from a genuine failure after T006.
  *Covers*: US2-AC4.

### T021 — Assert no quality gate is scheduled

**Type**: Test | **Time**: 10m | **Risk**: None

**Spec reference**: [spec.md](./spec.md) FR-008 — product-owner hard constraint

**Scenarios covered**:
- US2-AC1: the gate runs on the deploy path; a timed run could only report damage already shipped

**Verify**:
```bash
grep -n "schedule:" .forgejo/workflows/cd-deploy.yml .forgejo/workflows/guardrails.yml
```
**Expected**: 0 matches.

---

## Phase 5: User Story 3 — MCP integration tests correct and running (P2)

Independent of Phases 2–4; parallelizable with them.

### T022 — Derive the expected row count from the fixture

**Type**: Test refactor | **Time**: 30m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 3 — FR-009

**Scenarios covered**:
- US3-AC1: the asserted row count is derived from the fixture, so appending a row cannot silently break it

**File(s)**: `mcp-servers/spreadsheet-mcp/tests/integration/test_parse_store.py`

The workbook has **204 data rows** (205 incl. header) — verified 2026-08-06 with openpyxl. The parser's
`rowCount = len(data_rows)` is correct; the `== 200` literal is the defect.

**Verify RED** (before the change):
```bash
pnpm nx test:integration spreadsheet-mcp
```
**Expected RED**: 2 failing — `assert 204 == 200`, plus the event-loop failure.

**Verify GREEN** (after this task): 1 failing — the loop defect remains, fixed by T023.

### T023 — Reset the Redis singleton between tests

**Type**: Implementation | **Time**: 30m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 3 — FR-010

**Scenarios covered**:
- US3-AC2: the whole suite runs in one pytest session with no "Future attached to a different loop"

**File(s)**: `mcp-servers/spreadsheet-mcp/tests/integration/conftest.py` (new autouse fixture)

Reset `store._shared_client = None` between tests. **Do not modify `src/store.py`** — the process-wide
singleton is correct for the long-lived server and must not be changed to suit the tests.

**Verify GREEN**:
```bash
pnpm nx test:integration spreadsheet-mcp
```
**Expected GREEN**: 0 failed, non-zero executed. **This is SC-005.**

### T024 — Prove both MCP fixes are sensitive

**Type**: Test | **Time**: 20m | **Risk**: None

**Spec reference**: [spec.md](./spec.md) User Story 3 — SC-006

**Scenarios covered**:
- US3-AC1, US3-AC2: each fix must fail when reverted

Revert T022, confirm red, restore. Revert T023, confirm red, restore.

**Expected**: 2 of 2 revert to red. A test that fails when you break it is sensitive — which is the
property being claimed. **This is SC-006.**

- [ ] **T025** Add skip-escalation to the MCP integration suites (an env-gated
  `pytest_runtest_makereport` hook mirroring `MCM_REQUIRE_LIVE_STACK=1`) so an absent Redis fails rather
  than skipping (FR-012). **Lands before T026** — the suites must not be enrolable in a skip-to-green
  state. *Verify*: with Redis stopped and the flag set, the suite **fails**; with the flag unset, it
  skips. *Covers*: US3-AC3.
- [ ] **T026** Enrol `movie-mcp` and `spreadsheet-mcp` `test:integration` in
  `.forgejo/workflows/app-ci.yml` with the escalation flag set. Do **not** enrol `web-api-mcp` (FR-013);
  record the reason inline (unconfirmed TMDB egress + unsettled CI credential). *Verify*: CI shows both
  suites executed with **SKIP COUNT 0**. *Covers*: US3-AC4. **This is SC-007.**

---

## Phase 5b: User Story 4 — per-surface credential attribution (P3)

Independent of every other phase — pure CI wiring, no code, no test-behaviour change. Can land first.

- [ ] **T027 [P]** Repoint `.forgejo/workflows/app-ci.yml:255` (`app-e2e`) to
  `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_CI_E2E }}`. *Covers*: US4-AC1. **Secret source only — the env var name
  stays `ANTHROPIC_API_KEY`** (FR-015).
- [ ] **T028 [P]** Repoint `.forgejo/workflows/app-ci.yml:753` (`dast`) to
  `${{ secrets.ANTHROPIC_API_CI_DAST }}`, same rule. *Covers*: US4-AC2.
- [ ] **T029 [P]** Repoint `.forgejo/workflows/wiki-maintain.yml:156` to
  `${{ secrets.ANTHROPIC_API_WIKI_MAINTAIN }}`, same rule. *Covers*: US4-AC3.
- [ ] **T030** Confirm the four consumers keyed on the **variable name** still read `ANTHROPIC_API_KEY`:
  `app-ci.yml:550` (`-e ANTHROPIC_API_KEY` passthrough), `app-ci.yml:865` (DAST leak check),
  `scripts/agent-stack.mjs`, `src/models.py::resolve_anthropic_key`. A mistyped secret is caught loudly
  (`agent-stack.mjs` exits 1, `wiki-maintain.mjs` exits 2 on an empty key), so this is a cheap
  confirmation, not a gate. If a rename is ever done deliberately, the leak check's
  `[ -n "$ANTHROPIC_API_KEY" ]` guard is the one that fails open — update it last and assert it fires.
- [ ] **T031** *Verify by result*: `grep -rn "secrets.ANTHROPIC_API_KEY" .forgejo/` returns **0 matches**.
  *Covers*: US4-AC4. **This is SC-008.**
- [ ] **T032** Run `app-ci` and `wiki-maintain` once each; confirm in the Anthropic console that spend
  lands against **distinct keys**. A rename that didn't take would look identical in the diff but
  produce a single key's spend. **This is SC-009 — owner action (console access).**
- [ ] **T033** Once T031 and T032 pass, **delete** `ANTHROPIC_API_KEY` from Forgejo Actions Secrets
  (FR-017). Sequence matters: delete only after the console confirms the new keys carry the traffic, or
  a failed rename becomes an outage.

---

## Phase 5c: User Story 5 — the leak check fails closed (P2)

Independent of every other phase. Touches one step in `.forgejo/workflows/app-ci.yml`.

- [ ] **T034** Extract the scan body from `app-ci.yml`'s "Scan reports for secret leakage" step into
  `scripts/dast-leak-scan.sh`, taking the reports directory as `$1`; the workflow step becomes a single
  call. **Extraction only — behaviour byte-identical at this step, no logic change.** This is what makes
  T035–T038 runnable at all (the logic is otherwise inline YAML with no local entry point) and satisfies
  the Nx/scripted-invocation principle. *Verify*: clean reports dir → exit 0; planted canary → exit 1.

### T035 — Establish the fail-open defect by result

**Type**: Test | **Time**: 40m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 5 — FR-018, FR-021

**Scenarios covered**:
- US5-AC1: an empty `E2E_TEST_PASSWORD` / `E2E_ROPC_CLIENT_SECRET` must fail, not silently skip
- US5-AC2: an empty `ANTHROPIC_API_KEY` under `MODEL_PROVIDER=anthropic` must fail

**Prerequisite**: T034 complete.

**File(s)**: `scripts/__tests__/dast-leak-scan.test.sh` (new)

For each of the three guarded secrets in turn: blank the variable, plant a matching value in a scratch
reports directory, run the scan.

**Verify RED**:
```bash
bash scripts/__tests__/dast-leak-scan.test.sh
```
**Expected RED**: 3 of 3 cases exit **0** having scanned nothing — that is the bug.

### T036 — Make the leak scan fail closed

**Type**: Implementation | **Time**: 45m | **Risk**: Medium

**Spec reference**: same as T035 — FR-018, FR-019

**Prerequisite**: T035 complete and verified RED.

Add a preflight that fails with a message naming the variable when a guarded secret is **unexpectedly**
empty. `E2E_TEST_PASSWORD` and `E2E_ROPC_CLIENT_SECRET` are required unconditionally;
`ANTHROPIC_API_KEY` is required **only when `MODEL_PROVIDER` is `anthropic`** (FR-019) — a blanket check
would break the provider override at `app-ci.yml:749`. Keep the existing per-secret `grep` calls; this
adds a precondition, it does not replace them.

**Verify GREEN**:
```bash
bash scripts/__tests__/dast-leak-scan.test.sh
```
**Expected GREEN**: 3 of 3 exit non-zero, each naming the variable. **This is SC-010.**

- [ ] **T037** Confirm the fix did not over-tighten: `MODEL_PROVIDER=ollama`, empty
  `ANTHROPIC_API_KEY`, both other secrets set. *Expected*: passes — US5-AC3 holds.

### T038 — Prove the scan catches a planted canary

**Type**: Test | **Time**: 30m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 5 — FR-020

**Scenarios covered**:
- US5-AC4: a report containing a guarded secret fails the step and refuses to publish

Plant a canary matching each guarded secret into a scratch reports file in turn.

**Verify**:
```bash
bash scripts/__tests__/dast-leak-scan.test.sh --canary
```
**Expected**: 3 of 3 detected and blocked. **This is SC-011.** A fail-closed assertion nobody has
watched fail is the same unverified control in a new shape — this task is what makes US5 real.

### T039 — Fail when the reports directory is absent or empty

**Type**: Implementation | **Time**: 20m | **Risk**: Low

**Spec reference**: [spec.md](./spec.md) User Story 5 — FR-018

**Scenarios covered**:
- US5-AC5: the empty/missing-directory outcome is explicit, not an incidentally-passing grep miss

A missing or empty `security/zap/reports/` currently makes every grep miss and the step pass. The scan
cannot distinguish "nothing leaked" from "nothing was scanned", and by FR-018 the step fails closed —
so fail with a message naming the directory. If the ZAP step legitimately produced no reports, that is
itself a DAST failure and must surface there rather than be absorbed here.

**Verify GREEN**:
```bash
bash scripts/__tests__/dast-leak-scan.test.sh --empty-dir
```
**Expected GREEN**: non-zero exit naming the directory.

---

## Phase 6: Polish & cross-cutting

- [ ] **T040** Update [MCM-Testing-Strategy.md](../../docs/proposals/MCM-Testing-Strategy.md) §5.6 and §9
  so the documented pre-deploy gate matches reality — this feature closes the three-way docs↔reality gap.
- [ ] **T041** Correct `test_golden_pairs.py`'s docstring, which references a long-gone feature-012
  "T063" as the pre-deploy gate. Point it at the target built in T015.
- [ ] **T042** Add a knowledge entry recording the **marker-not-directory** mechanism: the golden tier is
  selected by `@pytest.mark.golden` within `tests/integration/`, and moving a test into `tests/golden/`
  would make it run nowhere. This is the trap most likely to bite the next person. Cross-reference
  constitution **v2.4.0**, which now records the sanctioned LLM-substitution exception.
- [ ] **T043** Full-suite validation per the
  [final validation checklist](../../openwiki/invariants/feature-validation-checklist.md), including the
  web E2E regression. Set `MCM_REQUIRE_LIVE_STACK=1` and `E2E_REQUIRE_AGENT_STACK=1` and **watch the
  SKIP COUNT** — a skip otherwise reads as a pass.
- [ ] **T044** `rtk gain` — confirm >80% compression.

---

## Dependencies & Execution Order

- **Phase 1** → **Phase 2** → Phases 3/4. **Phase 5** (US3), **5b** (US4) and **5c** (US5) are each
  independent of everything else and of one another.
- **T003–T009 block T010–T014.** Closing the skip paths first is what makes the conversion verifiable.
- **T010, T011 block T012** (cassettes must exist before the marker deselects the live path).
- **T012 blocks T013.**
- **US1 and US2 must merge together** — T012 without T018 drops the live verification entirely.
- **T022, T023 block T024**; **T025 blocks T026**.
- **T031 blocks T033** (never delete the old secret before the new ones are proven to carry traffic).
- **T034 blocks T035–T039** (extraction is what makes them runnable); **T035 blocks T036**;
  **T036 blocks T037 and T038**.
- **Phases 5b and 5c both edit `app-ci.yml`** — they touch different regions (job `env:` blocks vs the
  leak-scan step), so either order works; expect at most a trivial conflict.

### Parallel opportunities

- T027–T029 are one-line edits in different regions and can run together.
- Phases 5, 5b and 5c can proceed alongside Phases 2–4.

## Implementation Strategy

**MVP is Phases 2+3+4 together** — the golden conversion plus the live gate. Phases 5/5b/5c can follow
in the same PR or a subsequent one; a failure in any of them is unambiguously attributable, so
[batching](../../openwiki/process/pull-request-batching.md) is appropriate by default.

## Traps carried in from the 047 PR B session

- **Verify by RESULT, not exit status.** Watch the SKIP COUNT on every run above.
- **A test that fails when you break it is SENSITIVE, not CORRECT** — T014, T024 and T038 exist for this.
- **Both images are baked.** A client change needs `pnpm nx docker-build mcm-app`; an agent change needs
  `node scripts/agent-stack.mjs`. A stale image fails exactly like the bug you are hunting.
- **`pnpm nx e2e mcm-app` cannot run in the dev container, but Playwright can** — official image,
  `--network host`, `--user "$(id -u):$(id -g)" -e HOME=/tmp`. See
  [e2e-testing.md](../../docs/runbooks/e2e-testing.md).
- **Never use `rg -rn` / `rg -ril`** — `-r` is `--replace` and silently eats the pattern. Use `rg -n` or
  `grep -rn`, and treat an empty result as unconfirmed until checked a second way.
- **Opening the PR**: push a REAL branch (`git push origin HEAD:<branch>`) then `POST …/pulls` with the
  `git credential fill` credential. An AGit push runs CI with **no** Actions secrets.
