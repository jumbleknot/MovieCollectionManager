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
- [x] **T002** Capture CURRENT baselines, so every later count is measured rather than assumed.
  **Measured 2026-08-07** in the dev container (all four stacks up, `dev-ollama` healthy):
  - `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → **41 passed, 0 skipped,
    0 failed**, 71 deselected, 0.54 s. Exit 0.
  - `pnpm nx test:integration spreadsheet-mcp` → **2 failed** in 0.35 s. Exit 1. *(as predicted)*
  - `pnpm nx test:integration movie-mcp` → **20 passed**, 0 skipped, 0.99 s. Exit 0. *(as predicted)*
  - live-model tests in `app-ci`'s agent-integration step → **9 collected** from
    `tests/integration/test_out_of_domain.py` (4 out-of-domain + 4 in-domain + 1 full-graph).
    *(as predicted)*

---

## Phase 2: Foundational (blocking — close the skip-to-green paths FIRST)

These land while the tests still run live, so "a missing cassette goes red" is demonstrable **before**
the cassettes exist. Doing this after the conversion would make it unfalsifiable.

### T003 — Assert a cassette miss propagates out of model construction ✅ *(done 2026-08-07)*

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

### T004 — Narrow the model-fixture exception handler ✅ *(done 2026-08-07)*

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

### T005 — Assert `invoke_or_skip` re-raises a cassette miss ✅ *(done 2026-08-07)*

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

### T006 — Classify the cassette case by type in `live_model.py` ✅ *(done 2026-08-07)*

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

- [x] **T007** *Measure before changing.* Count how many of the 41 existing golden pairs currently lack
  a cassette; record the number here. **If 0**, remove the `"no cassette"` entry from
  `tests/integration/conftest.py`'s `_LEGITIMATE_SKIPS`. **If not 0**, scope the entry to the
  `test_golden_pairs` dataset path only and record why. (Open item from plan.md.)

  **MEASURED 2026-08-07 — the answer is 0.** `dataset.json` has **41** pairs; `tests/golden/cassettes/`
  holds **41** files; **0 pairs lack a cassette and 0 cassettes are orphaned** (set-compared by
  `pair["id"]` ↔ `<id>.json`). Corroborated independently by the T002 baseline: the replay gate reports
  41 passed / **0 skipped**, which it could not do if any pair were hitting the `pytest.skip("no
  cassette …")` branch. **Scope does not widen** — the existing golden gate is fully covered, not
  partly decorative. The whitelist entry is therefore dead code that can only ever mask a future
  regression, and is removed outright rather than scoped.

### T008 — Prove a deleted cassette turns the golden gate red ✅ *(done 2026-08-07)*

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

### T009 — Assert a single cassette implementation exists ✅ *(done 2026-08-07)*

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

- [x] **T010** Record cassettes for all 8 parametrized prompts + the full-graph scenario against the
  **gate** model. *(done 2026-08-07)* → `tests/golden/cassettes/topic-confinement.claude-haiku-4-5.json`,
  model id **`claude-haiku-4-5`**, **9 entries**.
- [x] **T011** Record the same scenarios against the **runtime** model (strategy §5.6 — routing bugs are
  model-specific). *(done 2026-08-07)* → `topic-confinement.qwen2-5.json`, model id **`qwen2.5`**,
  **9 entries**.

  **Why both are load-bearing, not belt-and-braces**: `guardrails`' golden gate sets only
  `LLM_CASSETTE_MODE: replay` and leaves `MODEL_PROVIDER` unset, so `select_model_config` resolves the
  **Ollama** tier (`qwen2.5`) there — while the US2 pre-deploy gate runs **Anthropic**. Recording one
  model would leave the other environment with no cassette. Cassettes are one file per model id
  (`topic-confinement.<slug>.json`) so "both recorded" is visible in a directory listing.

  **9 entries, not 10**: 1 reachability smoke prompt + 4 out-of-domain + 4 in-domain. The full-graph
  scenario reuses the `"what's the weather in Paris today"` prompt, so it shares that key — all 8
  parametrized prompts plus the full-graph scenario are covered (FR-005). Both models independently
  produced identical decisions (4× `out_of_domain`; `add`/`enrich`/`query`/`organize` in-domain).

### T012 — Enrol the topic-confinement tests in the keyless replay gate ✅ *(done 2026-08-07)*

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

**MEASURED 2026-08-07**: `env -u ANTHROPIC_API_KEY LLM_CASSETTE_MODE=replay` → **51 passed, 0 skipped,
0 failed**, exit 0, in **0.44 s** (the same assertions took 38 s live). 51 = 41 baseline pairs + 10 from
this module: the **9** topic-confinement assertions **SC-001 counts**, plus the T003 harness guard,
which is keyless and belongs in the same gate. The marker is applied module-level (`pytestmark`) so a
test added here later cannot silently fall back into the live-key step.

- [x] **T013** Confirm the deselection. *(done 2026-08-07)* `pytest tests/integration -m "not golden"
  --collect-only` matches `test_out_of_domain` **0 times** — live-model count **9 → 0**, so the routine
  `app-ci` live-model total falls ~61 → ~52. **SC-003 met.** The two selectors were also confirmed
  complementary and exhaustive by measurement: `-m "not golden"` collects **62/113**, `-m golden`
  collects **51/113**, and 62 + 51 = 113.

### T014 — Prove the gate is sensitive, not merely present ✅ *(done 2026-08-07)*

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

**MEASURED 2026-08-07**: changing one word of the supervisor prompt (`MOVIE COLLECTION` → `FILM
LIBRARY`) produced **39 failed, 12 passed, exit 1**, every failure a `CassetteMissError` naming the
unmatched key. The blast radius spans the 41 existing golden pairs as well, because the intent pairs
share this prompt — correct, and further evidence the key really does bind to prompt text. Reverting
restored **51 passed, exit 0**. **US1-AC2 met.**

---

## Phase 4: User Story 2 — live model gate before deploy (P1)

**Must ship with US1.** Merging Phase 3 alone drops the live verification.

- [x] **T015** Add an Nx target for the live gate. *(done 2026-08-07)* `test:golden-live` in
  `agents/movie-assistant/project.json` runs
  `LLM_CASSETTE_MODE= MODEL_PROVIDER=anthropic MCM_REQUIRE_LIVE_MODEL=1 uv run pytest tests/integration -m golden`.
  `MODEL_PROVIDER=anthropic` matches production (`infrastructure-as-code/docker/agents/compose.prod.yaml:40`)
  — the gate must exercise the model that actually ships. `MCM_REQUIRE_LIVE_MODEL=1` is set *by the
  target*, so the gate can never be invoked without its fail-closed behaviour (T017).

### T016 — Assert the live gate fails without a credential ✅ *(done 2026-08-07)*

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

**MEASURED RED 2026-08-07**: `env -u ANTHROPIC_API_KEY pnpm nx test:golden-live movie-assistant` →
**1 passed, 50 skipped, exit 0**. The defect is sharper than "some tests fail": the gate reported
*success* having verified nothing, so it would have waved through every deploy. (The 1 pass is the
T003 harness guard, which is keyless by design.)

### T017 — Make the live gate fail closed on a missing credential ✅ *(done 2026-08-07)*

**Type**: Implementation | **Time**: 20m | **Risk**: Medium

**Spec reference**: same as T016

**Prerequisite**: T016 complete and verified RED.

**Verify GREEN**:
```bash
pnpm nx test:golden-live movie-assistant
```
**Expected GREEN**: 0 failures with a credential present; non-zero exit with it absent.

**MEASURED GREEN 2026-08-07**, both directions:
- **no credential** → **exit 1**, 41 failed + 9 errors, **0 skipped**. The message names the fix
  (`ANTHROPIC_API_CD_GOLDEN`), not just the fault.
- **with credential** → **51 passed, 0 skipped, exit 0** in 46.6 s against live Anthropic.

**Mechanism**: `live_model.require_live_credential()` + the `MCM_REQUIRE_LIVE_MODEL=1` flag, mirroring
the established `MCM_REQUIRE_LIVE_STACK=1` pattern. Escalation is opt-in by flag *because* the
constitution requires a credential-less checkout to stay green — the flag is set unconditionally by the
`test:golden-live` target, so the gate always has it while a local `nx test:integration` does not.
Three skip-to-green paths were closed, not one: the absent credential, `_supervisor_model()`'s
provider-unreachable skip, and `invoke_or_skip`'s capacity skip (T020). Pinned by 8 new unit tests in
`tests/unit/test_live_model_helpers.py` so this cannot silently regress.

- [x] **T018** Wire the gate into `.forgejo/workflows/cd-deploy.yml`. *(done 2026-08-07)*
  *Covers*: US2-AC1, US4-AC5.

  **Open item resolved — it is an IN-JOB STEP, not a `needs:` job.** Three reasons, in order of
  weight: (1) `build-deploy` is deliberately a single job because *the digest never leaves it* — the
  runner does not support `upload-artifact@v4` — so promotion cannot be gated from outside without a
  handoff that does not exist; (2) the toolchain the gate needs (pnpm, node, uv, `pnpm install`) is
  already installed three steps above, whereas a separate job would reinstall it on the repo's single
  runner; (3) `guardrails.yml` documents the same call explicitly — a new job incurs its own
  feature-042 failure-digest obligation for no benefit.

  **Placement**: step **7 of 16**, immediately after "Install dependencies" and *before* "Build images"
  (9), "Scan, push" (10), "Promote digest to git" (11) and "Fire signed Komodo redeploy webhook(s)"
  (12) — verified by parsing the workflow, not by reading it. Gating before the *build* rather than
  merely before the *promotion* is strictly stronger than US2-AC1 requires and makes a blocked deploy
  cost ~1 minute instead of a six-image build against a 120-minute timeout.

  **Credential**: `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_CD_GOLDEN }}` — the variable name is
  unchanged (FR-015), only the secret behind it. **No `schedule:` added** (FR-008).
- [~] **T019** Verify by result: force the gate to fail; confirm **no digest is promoted and no
  webhook fires**. *Covers*: US2-AC2. **This is SC-004.** — **structurally proven, end-to-end run is
  an owner action.**

  **Proven here (2026-08-07)** by parsing the workflow and evaluating every step guard *after* the
  gate. All six deploy-path steps — Install Trivy, Build images, Scan/push, **Promote digest**,
  **Fire Komodo webhook**, Post-deploy probe — carry no `if: always()`, no `if: failure()` and no
  `continue-on-error`, so a failed gate short-circuits every one of them. Exactly two steps survive a
  failure, and neither promotes or deploys: the feature-042 failure digest (`always()`,
  `continue-on-error: true`, by design), and the rollback — whose guard requires
  `steps.promote.outputs.changed == 'true'`, which **cannot** be set when `promote` never ran, so it
  is a no-op. No digest is promoted and no webhook fires.

  **NOT done here**: an actual dispatch. `cd-deploy` is the production deploy workflow
  (`workflow_dispatch` only); running it builds and pushes six images and commits a digest-promotion
  to the deployed branch. That is a production side effect, so it is left as an explicit owner action
  rather than taken unilaterally. The first real `cd-deploy` run confirms SC-004 end-to-end.
- [x] **T020** Confirm a provider 529 is still distinguishable from a genuine failure. *(done
  2026-08-07)* Two behaviours had to hold at once, and both are now pinned by unit test:
  **outside** the gate a mid-run 529 still only *skips* (the 2026-07-20 behaviour is unchanged);
  **inside** the gate it *fails*, because an unreachable provider means the model decision was never
  verified and the deploy must not proceed on an unverified gate. The failure text opens with
  `PROVIDER CAPACITY (infrastructure, NOT a classification defect)` so an on-call engineer is not sent
  hunting a prompt regression that never happened — that is what "distinguishable" has to mean in
  practice. *Covers*: US2-AC4.

### T021 — Assert no quality gate is scheduled ✅ *(done 2026-08-07)*

**Type**: Test | **Time**: 10m | **Risk**: None

**Spec reference**: [spec.md](./spec.md) FR-008 — product-owner hard constraint

**Scenarios covered**:
- US2-AC1: the gate runs on the deploy path; a timed run could only report damage already shipped

**Verify**:
```bash
grep -n "schedule:" .forgejo/workflows/cd-deploy.yml .forgejo/workflows/guardrails.yml
```
**Expected**: 0 matches.

**MEASURED 2026-08-07, after T018 landed**: **0 matches** in both files, and `cd-deploy.yml`'s only
trigger is `workflow_dispatch`. FR-008 holds — the live gate runs at deploy, never on a timer.

---

## Phase 5: User Story 3 — MCP integration tests correct and running (P2)

Independent of Phases 2–4; parallelizable with them.

### T022 — Derive the expected row count from the fixture ✅ *(done 2026-08-07)*

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

**MEASURED 2026-08-07**: RED **2 failed** (`assert 204 == 200` + the loop error) → after the change
**1 failed, 1 passed**, exactly as predicted. The count is derived with openpyxl by the *spec's*
definition of a data row (row 1 is the header; a row counts if any cell is non-blank), deliberately
re-derived rather than imported from `parser` — importing it would make the assertion tautological, so
a parser that miscounted would agree with itself.

### T023 — Reset the Redis singleton between tests ✅ *(done 2026-08-07)*

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

**MEASURED 2026-08-07**: **2 passed, 0 skipped**, exit 0 (whole project: 36 passed). **SC-005 met:
2 failed → 0 failed.** `src/store.py` is untouched, per FR-010. The autouse fixture nulls
`store._shared_client` before each test and closes the previous client *in that test's own event
loop* — the only loop it can be closed from, since closing across loops is the very error being
fixed.

### T024 — Prove both MCP fixes are sensitive ✅ *(done 2026-08-07)*

**Type**: Test | **Time**: 20m | **Risk**: None

**Spec reference**: [spec.md](./spec.md) User Story 3 — SC-006

**Scenarios covered**:
- US3-AC1, US3-AC2: each fix must fail when reverted

Revert T022, confirm red, restore. Revert T023, confirm red, restore.

**Expected**: 2 of 2 revert to red. A test that fails when you break it is sensitive — which is the
property being claimed. **This is SC-006.**

**MEASURED 2026-08-07 — 2 of 2, each failing with its OWN defect** (not merely "a failure"):
- restore the `== 200` literal → `FAILED … - assert 204 == 200`, exit 1;
- set the singleton-reset fixture `autouse=False` → `FAILED … - RuntimeError: Event loop is closed`,
  exit 1.

Both restored; the suite returns to 2 passed, exit 0. **SC-006 met.**

- [x] **T025** Add skip-escalation to the MCP integration suites (FR-012). *(done 2026-08-07)* An
  env-gated `pytest_runtest_makereport` hook mirroring the agent suite's, added to
  `spreadsheet-mcp/tests/integration/conftest.py` (new) and `movie-mcp/tests/integration/conftest.py`
  (existing). `_LEGITIMATE_SKIPS` is **empty by design** in both: every dependency these suites have
  is up in the job that will run them, so no skip is legitimate there — and adding one has to be a
  deliberate act, which is the whole point of the pattern. **Lands before T026.** *Covers*: US3-AC3.

  **Verified by result, all four states** (dependency pointed at a dead port):

  | Suite | flag UNSET | flag SET |
  |---|---|---|
  | spreadsheet-mcp | **2 skipped**, exit 0 | **2 failed**, exit 1, message names "BROKEN HARNESS" |
  | movie-mcp | **20 skipped**, exit 0 | exit 1 |

  And under the real CI condition — stack up **and** flag set — spreadsheet-mcp **2 passed** and
  movie-mcp **20 passed**, both with a **SKIP COUNT of 0**.

- [x] **T026** Enrol `movie-mcp` and `spreadsheet-mcp` `test:integration` in `app-ci.yml`.
  *(done 2026-08-07)* *Covers*: US3-AC4. **SC-007** — locally measured (20 + 2 passed, SKIP COUNT 0);
  the CI-side confirmation lands with the first `app-ci` run of this branch.

  One step in the **`app-e2e`** job, at index **18 of 26** — directly after the agent integration
  suite and before mc-service (19), BFF (20), Web E2E (21) and the emulator/APK legs. That job already
  stands up Keycloak + realm, mc-service, Mongo and Redis, so this costs seconds on a warm stack, and
  the placement means a failure costs ~2 minutes rather than burning 15+ minutes of emulator time
  first. `MCM_REQUIRE_LIVE_STACK: '1'` is set, so T025's escalation is active. `REDIS_URL` uses **db
  9**, keeping the single-use upload handles clear of the BFF integration suite's db 1.

  **`web-api-mcp` is NOT enrolled** (FR-013), with the reason recorded inline in the workflow: its
  tests reach TMDB and outbound egress from the runner is unconfirmed, and the credential question is
  unsettled (TMDB keys are per-user by design, so which key a CI run should spend has no answer yet).
  Enrolling it on an unconfirmed egress path would produce precisely the environmentally-flaky gate
  this feature exists to remove.

---

## Phase 5b: User Story 4 — per-surface credential attribution (P3)

Independent of every other phase — pure CI wiring, no code, no test-behaviour change. Can land first.

- [x] **T027 [P]** Repoint `app-ci.yml` (`app-e2e`) to `${{ secrets.ANTHROPIC_API_CI_E2E }}`.
  *(done 2026-08-07 — now line 261 after the comment block.)* *Covers*: US4-AC1.
- [x] **T028 [P]** Repoint `app-ci.yml` (`dast`) to `${{ secrets.ANTHROPIC_API_CI_DAST }}`.
  *(done 2026-08-07 — now line 761.)* *Covers*: US4-AC2.
- [x] **T029 [P]** Repoint `wiki-maintain.yml` to `${{ secrets.ANTHROPIC_API_WIKI_MAINTAIN }}`.
  *(done 2026-08-07 — now line 158.)* *Covers*: US4-AC3.
- [x] **T030** Confirm the consumers keyed on the **variable name** still read `ANTHROPIC_API_KEY`.
  *(done 2026-08-07 — all confirmed present and unchanged.)*
  - `app-ci.yml:556` — the `-e ANTHROPIC_API_KEY` docker passthrough ✅
  - `app-ci.yml:873` — the DAST leak check's `[ -n "$ANTHROPIC_API_KEY" ]` guard ✅ *(the one that
    fails open — US5/Phase 5c is what fixes that)*
  - `scripts/agent-stack.mjs:226/234/319` ✅ · `src/models.py::resolve_anthropic_key:125` ✅
  - *(also found, not in the original list)* `scripts/wiki-maintain.mjs:881/1692` ✅

- [x] **T031** *Verify by result*. *(done 2026-08-07)* `grep -rn "secrets.ANTHROPIC_API_KEY" .forgejo/`
  → **0 matches**, and the four Anthropic-consuming surfaces each hold a **distinct** secret:

  | File:line | Job | Secret |
  |---|---|---|
  | `app-ci.yml:261` | `app-e2e` | `ANTHROPIC_API_CI_E2E` |
  | `app-ci.yml:761` | `dast` | `ANTHROPIC_API_CI_DAST` |
  | `wiki-maintain.yml:158` | wiki generation | `ANTHROPIC_API_WIKI_MAINTAIN` |
  | `cd-deploy.yml:185` | live pre-deploy gate (T018) | `ANTHROPIC_API_CD_GOLDEN` |

  Repo-wide, the only remaining `secrets.ANTHROPIC_API_KEY` strings are prose in
  `docs/proposals/PRD-TestHarnessRemediation.md` and this feature's own spec artifacts. All four
  workflows re-parse as valid YAML. *Covers*: US4-AC4. **SC-008 met.**
- [ ] **T032** ⚠️ **OWNER ACTION — not done here.** Run `app-ci` and `wiki-maintain` once each; confirm
  in the Anthropic console that spend lands against **distinct keys**. A rename that didn't take looks
  identical in the diff but produces a single key's spend, so the console is the only real evidence.
  **This is SC-009**, and it needs console access this session does not have.
- [ ] **T033** ⚠️ **OWNER ACTION — not done here, and deliberately blocked on T032.** Delete
  `ANTHROPIC_API_KEY` from Forgejo Actions Secrets (FR-017). **Do not delete before T032 confirms the
  new keys carry the traffic** — deleting first converts a mistyped secret name from a diff into a
  production outage. The code side is ready: zero references remain (T031).

---

## Phase 5c: User Story 5 — the leak check fails closed (P2)

Independent of every other phase. Touches one step in `.forgejo/workflows/app-ci.yml`.

- [x] **T034** Extract the scan body into `scripts/dast-leak-scan.sh` (reports dir as `$1`); the
  workflow step becomes a single call. *(done 2026-08-07 — extraction only, no logic change; the
  fail-closed preconditions landed separately in T036/T039 so the RED in T035 was real.)*
  *Verified*: clean reports dir → exit 0; planted canary → exit 1, **before** any behaviour change.

  Secrets reach the script through the **environment, never argv** — an argument is visible in `ps`.

  **Enrolled in CI, which the task did not ask for but the feature's own thesis requires.** The
  existing `scripts/__tests__` gate globs `*.test.mjs`, so a `.test.sh` harness would have run in *no*
  workflow — shipping an unrun test harness is precisely the defect US3 exists to remove, and it is how
  `scripts/__tests__` itself rotted before feature 041. Added to `guardrails.yml`'s `naming` job as
  **"DAST leak-scan guard (048 — fail-closed + canary, keyless)"**, running `--all` (11 assertions,
  keyless, offline, ~1 s) — the same posture as every other gate in that job.

### T035 — Establish the fail-open defect by result ✅ *(done 2026-08-07)*

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

**MEASURED RED 2026-08-07**: `passed=1 failed=3` — **3 of 3 guarded secrets blank → 3 of 3 exit 0**,
each having skipped its scan and reported success. `--empty-dir` was RED too (2 of 2 exit 0).

### T036 — Make the leak scan fail closed ✅ *(done 2026-08-07)*

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

**MEASURED GREEN 2026-08-07**: **3 of 3 exit 1**, each `::error::` naming the variable and saying why
(it "would exit 0 having verified nothing"). **SC-010 met: 3 of 3 exit 0 → 3 of 3 non-zero.** The
preconditions are ADDED to the guarded greps, not a replacement — the `[ -n ... ]` guards still stop a
`grep -F ""` matching every line on a legitimately-absent value.

- [x] **T037** Confirm the fix did not over-tighten. *(done 2026-08-07)* `MODEL_PROVIDER=ollama` +
  empty `ANTHROPIC_API_KEY` + both other secrets set → **exit 0**. US5-AC3 holds and the documented
  provider override at `app-ci.yml:749` keeps working. The Anthropic requirement is conditional on
  `MODEL_PROVIDER` (FR-019); the other two are unconditional. This assertion lives in the harness, so
  a later "just fail if empty" simplification is caught rather than merely discouraged.

### T038 — Prove the scan catches a planted canary ✅ *(done 2026-08-07)*

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

**MEASURED 2026-08-07: 3 of 3 detected**, plus the JWT scan (which takes no variable and was never
fail-open) and a **negative control** — clean reports must exit 0, or a script that simply always
failed would have scored 4/4 and proved nothing. **SC-011 met.**

Worth recording: the canary passed **against the as-extracted script, before T036**. That is the
evidence that T034's extraction was faithful (byte-identical behaviour) and that the scans genuinely
fire when their secret is set. The defect was never that the scans did not work — it was that they
could be skipped.

### T039 — Fail when the reports directory is absent or empty ✅ *(done 2026-08-07)*

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

**MEASURED 2026-08-07**: RED 2 of 2 exit 0 → GREEN **2 of 2 exit 1**, both naming the directory —
missing dir and existing-but-empty dir are distinguished, with different messages.

---

## Phase 6: Polish & cross-cutting

- [x] **T040** Update [MCM-Testing-Strategy.md](../../docs/proposals/MCM-Testing-Strategy.md) §5.6 and
  §9. *(done 2026-08-07)* §5.6 now names `nx test:golden-live` and where it runs, carries a dated
  correction recording that the gate it previously described did not exist, and states the
  marker-not-directory mechanism. §9's checklist gains the two MCP suites (with
  `MCM_REQUIRE_LIVE_STACK=1`) and a "watch the SKIP COUNT, not the exit status" note naming all three
  escalation flags.
- [x] **T041** Correct `test_golden_pairs.py`'s docstring. *(done 2026-08-07)* The phantom "T063" is
  gone and it points at `nx test:golden-live`. It also no longer claims the suite "skips cleanly when
  neither a key nor a cassette is available" — half of that is now deliberately false, and the
  docstring says which half and why.
- [x] **T042** Add the knowledge entry. *(done 2026-08-07)* Written into
  `openwiki/invariants/testing-tiers.md` — that concept is **[canonical]**, so per CLAUDE.md's routing
  rule the learning goes in the concept itself rather than an upstream source. Adds a
  "The golden tier is a MARKER, not a directory" section (with the 62 + 51 = 113 measurement showing
  the selectors are complementary and exhaustive), a table of where each gate runs and on which
  credential, and three new gotchas. The governance gate correctly failed on the protected-passage
  fingerprint; it was updated in the same change, as the gate itself instructs.
- [x] **T043** Full-suite validation. *(run 2026-08-07 — results below, including what could NOT be
  run here and why.)*

  | Check | Result |
  |---|---|
  | `nx lint` — movie-assistant / movie-mcp / spreadsheet-mcp | **3 × exit 0** |
  | `nx test movie-assistant` (unit, incl. leak scan) | **1099 passed, 2 skipped** *(2 pre-existing)* |
  | `nx test movie-mcp` / `nx test spreadsheet-mcp` | **11 passed** / **34 passed** |
  | `nx test:golden movie-assistant` (replay, `ANTHROPIC_API_KEY` unset) | **51 passed, 0 skipped, 0 failed** |
  | `nx test:golden-live movie-assistant` (live Anthropic) | **51 passed, 0 skipped**, 46.6 s |
  | `nx test:integration movie-mcp` (`MCM_REQUIRE_LIVE_STACK=1`) | **20 passed, SKIP COUNT 0** |
  | `nx test:integration spreadsheet-mcp` (`MCM_REQUIRE_LIVE_STACK=1`) | **2 passed, SKIP COUNT 0** |
  | `node --test scripts/__tests__/*.test.mjs` | **393 tests, 392 passed, 0 failed**, 1 pre-existing skip |
  | `bash scripts/__tests__/dast-leak-scan.test.sh --all` | **11 passed, 0 failed** |
  | `node scripts/secret-scan.mjs` · `check-ci-digest-coverage.mjs` | exit 0 · exit 0 |
  | OpenWiki `okf` + `governance` gates (+ both selftests) | **4 × exit 0** |
  | **Web E2E regression** (Playwright container, dev-container BFF) | **135 passed, 0 failed**, 1.5 min |

  **A real regression was caught by an existing guard and fixed**, not worked around:
  `scripts/__tests__/wiki-maintain.guard.test.mjs` pins the set of secrets `wiki-maintain.yml` may
  reference, and T029 introduced `ANTHROPIC_API_WIKI_MAINTAIN`. The allowlist was updated
  deliberately, with the reason recorded inline, and **strengthened** — it now also asserts the
  retired `secrets.ANTHROPIC_API_KEY` does *not* reappear there (FR-017).

  **Web E2E skip count**: 135 passed / **42 skipped**. The skips are the `agent-*` / `assistant-*` and
  admin specs, which are gated by design and run in the separate `e2e:agents` leg — not a harness
  fault. This feature changes no product code path, so the web suite runs as the unchanged-behaviour
  regression the plan's Constitution Check recorded, and it is green.

  ⚠️ **NOT fully runnable in this dev container — `nx test:integration movie-assistant`.** With
  `MCM_REQUIRE_LIVE_STACK=1` it reports 13 passed / 38 errors, **every error the same cause**:
  `ROPC / service-account creds not set — needs the live stack`. Established as **environmental, not
  introduced**: `KEYCLOAK_SERVICE_CLIENT_SECRET` is absent from `frontend/mcm-app/.env.local` here
  (CI injects it from Actions secrets), `kc_admin.py` and every credential fixture are byte-identical
  to the base commit, the escalation hook is unchanged, and the only `_LEGITIMATE_SKIPS` edit was
  removing `"no cassette"` — which has never matched this reason. Without the flag the same suite is
  13 passed / 49 skipped, exit 0. **CI is where this leg is proven.**
- [x] **T044** `rtk gain`. **>80% NOT met at global scope — 23.1%** (969 commands, 247.6 K saved).
  Reported as measured rather than as the checklist wants it. The figure is a global average
  dominated by `rtk grep` (435 calls, 28.4%) and `rtk read` (104 calls, 23.4%). The **test-command**
  categories RTK exists to compress *are* above the bar — `uv run` at **97.6% / 90.7% / 89.6%** and
  `jest run` at **99.6%** — so the target holds for the traffic it was written about, and the
  checklist item as literally worded does not pass.

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
