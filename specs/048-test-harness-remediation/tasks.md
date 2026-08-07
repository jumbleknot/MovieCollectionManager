# Tasks: Test-harness remediation (048)

**Input**: [spec.md](./spec.md) · [plan.md](./plan.md)

Every task pair makes RED/GREEN explicit per
[test-authoring-conventions](../../openwiki/process/test-authoring-conventions.md). **If `Verify RED`
shows 0 failures the test is wrong — stop and fix it before implementing.**

## Format: `[ID] [P?] [Story] Description`

- `[P]` = parallelizable (different files, no shared state)
- `[US1]` / `[US2]` / `[US3]` = the user story the task serves

## Path Conventions

Agent: `agents/movie-assistant/` · MCP: `mcp-servers/<server>/` · CI: `.forgejo/workflows/`

---

## Phase 1: Setup

- [ ] **T001** Create the branch `048-test-harness-remediation` from `main`.
- [ ] **T002** Capture the CURRENT baselines, so every later count is measured rather than assumed.
  Record in this file:
  - `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → passed / skipped / failed
  - `pnpm nx test:integration spreadsheet-mcp` → expect **2 failed**
  - `pnpm nx test:integration movie-mcp` → expect **20 passed**
  - the number of live-model tests in `app-ci`'s agent-integration step → expect **9**

---

## Phase 2: Foundational (blocking — close the skip-to-green paths FIRST)

These land while the tests still run live, so the "a missing cassette goes red" property is
demonstrable **before** the cassettes exist. Doing this after the conversion would make it unfalsifiable.

- [ ] **T003 [US1]** Write a test asserting that a `CassetteMissError` raised inside model
  construction **propagates** rather than becoming a skip.
  *Verify RED*: `pnpm nx test:integration movie-assistant -- -k cassette_miss_propagates`
  *Expected*: **1 failure** (today the blanket `except Exception` swallows it).
- [ ] **T004 [US1]** Narrow `_supervisor_model()`'s `except Exception` in
  `tests/integration/test_out_of_domain.py` so `CassetteMissError` is never converted to a skip;
  pass T003.
  *Verify GREEN*: same command · *Expected*: **1 passed, 0 failed**.
- [ ] **T005 [US1]** Write a test asserting `invoke_or_skip` re-raises `CassetteMissError` (its
  substring classifier must not treat it as a capacity signal).
  *Verify RED*: `pnpm nx test movie-assistant -- -k invoke_or_skip_cassette`
  *Expected*: **1 failure**.
- [ ] **T006 [US1]** Fix `tests/integration/live_model.py` to classify by exception **type** for the
  cassette case; pass T005. *Verify GREEN* · *Expected*: **1 passed, 0 failed**.
- [ ] **T007 [US1]** Measure before changing `_LEGITIMATE_SKIPS`: count how many of the 41 existing
  golden pairs currently lack a cassette. Record the number here. **If it is 0**, remove the
  `"no cassette"` entry from `tests/integration/conftest.py`. **If it is not 0**, scope the entry to
  the `test_golden_pairs` dataset path only and record why. (Open item from plan.md.)
- [ ] **T008 [US1]** Verify T007 by deleting one cassette and confirming the golden gate goes **red**,
  then restore it. *Expected*: non-zero exit, failure names the missing cassette. **This is SC-002.**

---

## Phase 3: User Story 1 — keyless topic confinement at merge (P1) 🎯

- [ ] **T009 [US1]** Record cassettes for all 8 parametrized prompts + the full-graph scenario against
  the **gate** model: `LLM_CASSETTE_MODE=record MODEL_PROVIDER=anthropic pnpm nx test:integration
  movie-assistant -- -k out_of_domain`. Commit the cassette JSON.
- [ ] **T010 [US1]** Record the same scenarios against the **runtime** model (strategy §5.6 — routing
  bugs are model-specific). Record which model IDs were used.
- [ ] **T011 [US1]** Add `@pytest.mark.golden` to `test_out_of_domain.py`. This single change enrols it
  in the keyless replay gate **and** deselects it from `app-ci`'s live-key step.
  *Verify GREEN (keyless)*: with `ANTHROPIC_API_KEY` **unset**,
  `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`
  *Expected*: baseline pairs **+ 9 passed, 0 skipped, 0 failed**. **This is SC-001.**
- [ ] **T012 [US1]** Confirm the deselection: `pnpm nx test:integration movie-assistant -- -m "not
  golden"` no longer collects the 9 tests. *Expected*: live-model count **9 → 0**. **This is SC-003.**
- [ ] **T013 [US1]** Prove sensitivity, not just presence: edit the supervisor prompt, confirm the
  golden gate fails with `CassetteMissError`, then revert. *Expected*: **red**, not skip.

## Phase 4: User Story 2 — live model gate before deploy (P1)

**Must ship with US1.** Merging Phase 3 alone drops the live verification.

- [ ] **T014 [US2]** Add an Nx target for the live gate that runs the `golden`-marked tests with
  `LLM_CASSETTE_MODE` **unset** (`off`) against the real provider. Expose it as an Nx target, not a
  bare CLI call (constitution: Nx as universal task runner).
- [ ] **T015 [US2]** Write a test asserting the live gate **fails** when no credential is present.
  *Verify RED* · *Expected*: **1 failure** (a credential-less run currently skips). **FR-007.**
- [ ] **T016 [US2]** Implement fail-closed credential handling; pass T015. *Verify GREEN* ·
  *Expected*: **1 passed, 0 failed**.
- [ ] **T017 [US2]** Wire the gate into `.forgejo/workflows/cd-deploy.yml` **before** the
  "Scan, push…" / "Promote digest" / "Fire signed Komodo redeploy webhook(s)" steps. Decide and record
  whether it is a `needs:` job or an in-job step (open item from plan.md). Add **no** `schedule:`
  trigger — owner constraint.
  Set `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_CD_GOLDEN }}` on the gate (created 2026-08-07).
  Do **not** use `ANTHROPIC_API_CI_E2E` — that would re-conflate two of the surfaces US4 separates.
- [ ] **T018 [US2]** Verify by result: force the gate to fail on a scratch branch and confirm **no
  digest is promoted and no webhook fires**. **This is SC-004.**
- [ ] **T019 [US2]** Confirm a 529 is still distinguishable from a genuine failure after the T006
  change.

## Phase 5: User Story 3 — MCP integration tests correct and running (P2)

Independent of Phases 3–4; parallelizable with them.

- [ ] **T020 [P] [US3]** Fix the row-count assertion in
  `mcp-servers/spreadsheet-mcp/tests/integration/test_parse_store.py` to **derive** the expected count
  from the fixture workbook rather than hard-coding it (FR-009). The workbook has **204 data rows**
  (205 incl. header) — verified 2026-08-06; the parser is correct and `== 200` is the defect.
  *Verify RED (before)*: `pnpm nx test:integration spreadsheet-mcp` · *Expected*: **2 failed**.
  *Verify GREEN (after this task)*: **1 failed** (the loop defect remains).
- [ ] **T021 [P] [US3]** Add an autouse fixture in
  `mcp-servers/spreadsheet-mcp/tests/integration/conftest.py` resetting `store._shared_client = None`
  between tests. **Do not modify `src/store.py`** — the process-wide singleton is correct for the
  long-lived server (FR-010).
  *Verify GREEN*: `pnpm nx test:integration spreadsheet-mcp` · *Expected*: **0 failed**, non-zero
  executed. **This is SC-005.**
- [ ] **T022 [US3]** Prove sensitivity: revert T020, confirm red; restore. Revert T021, confirm red;
  restore. **This is SC-006** — a test that fails when you break it is sensitive, which is the property
  being claimed here.
- [ ] **T023 [US3]** Add skip-escalation to the MCP integration suites (an env-gated
  `pytest_runtest_makereport` hook mirroring `MCM_REQUIRE_LIVE_STACK=1`), so an absent Redis fails
  rather than skipping (FR-012). **Lands before T024** — the suites must not be enrolable in a
  skip-to-green state.
  *Verify*: with Redis stopped and the flag set, the suite **fails**; with the flag unset it skips.
- [ ] **T024 [US3]** Enrol `movie-mcp` and `spreadsheet-mcp` `test:integration` in
  `.forgejo/workflows/app-ci.yml`, with the escalation flag set. Do **not** enrol `web-api-mcp`
  (FR-013) and record the reason inline: unconfirmed TMDB egress + unsettled CI credential.
  *Verify*: CI run shows both suites executed with **SKIP COUNT 0**. **This is SC-007.**

## Phase 5b: User Story 4 — per-surface credential attribution (P3)

Independent of every other phase — pure CI wiring, no code, no test behaviour change. Can land first.

- [ ] **T024a [P] [US4]** Repoint `.forgejo/workflows/app-ci.yml:255` (`app-e2e`) to
  `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_CI_E2E }}`.
  **Change the secret source only — the env var name stays `ANTHROPIC_API_KEY`** (FR-015).
- [ ] **T024b [P] [US4]** Repoint `.forgejo/workflows/app-ci.yml:753` (`dast`) to
  `${{ secrets.ANTHROPIC_API_CI_DAST }}`, same rule.
- [ ] **T024c [P] [US4]** Repoint `.forgejo/workflows/wiki-maintain.yml:156` to
  `${{ secrets.ANTHROPIC_API_WIKI_MAINTAIN }}`, same rule.
- [ ] **T024d [US4]** Confirm the four consumers keyed on the **variable name** still read
  `ANTHROPIC_API_KEY` (they should — this change touches only the right-hand side):
  `app-ci.yml:550` (`-e ANTHROPIC_API_KEY` passthrough), `app-ci.yml:865` (DAST leak check),
  `scripts/agent-stack.mjs`, `src/models.py::resolve_anthropic_key`.
  A mistyped secret is caught loudly — `agent-stack.mjs` exits 1 and `wiki-maintain.mjs` exits 2 on an
  empty key — so this is a cheap confirmation, not a gate. If a rename is ever done deliberately, the
  leak check's `[ -n "$ANTHROPIC_API_KEY" ]` guard is the one that fails open, so update it last and
  assert it still fires.
- [ ] **T024e [US4]** *Verify by result*: `grep -rn "secrets.ANTHROPIC_API_KEY" .forgejo/` returns
  **0 matches**. **This is SC-008.**
- [ ] **T024f [US4]** Run `app-ci` and `wiki-maintain` once each, then confirm in the Anthropic console
  that spend lands against **distinct keys**. A rename that didn't actually take would look identical
  in the diff but produce a single key's spend. **This is SC-009 — owner action (console access).**
- [ ] **T024g [US4]** Once T024e and T024f pass, **delete** `ANTHROPIC_API_KEY` from Forgejo Actions
  Secrets (FR-017). Do not leave it configured-but-unreferenced. Sequence matters: delete only after
  the console confirms the new keys are actually carrying the traffic, or a failed rename becomes an
  outage.

## Phase 5c: User Story 5 — the leak check fails closed (P2)

Independent of every other phase. Touches one step in `.forgejo/workflows/app-ci.yml`.

- [ ] **T024h [US5]** *Verify RED — establish the defect by result, not by reading.* Run the leak-check
  step's script locally with `E2E_TEST_PASSWORD=""`, a report directory containing a planted copy of
  the password, and confirm it **exits 0** having scanned nothing. Repeat for `E2E_ROPC_CLIENT_SECRET`
  and `ANTHROPIC_API_KEY`. *Expected*: **3 of 3 exit 0** — that is the bug.
- [ ] **T024i [US5]** Add a preflight to the "Scan reports for secret leakage" step
  (`app-ci.yml:~856`) that fails with a message naming the variable when a guarded secret is
  **unexpectedly** empty (FR-018):
  - `E2E_TEST_PASSWORD`, `E2E_ROPC_CLIENT_SECRET` — required unconditionally
  - `ANTHROPIC_API_KEY` — required **only when `MODEL_PROVIDER` is `anthropic`** (FR-019). A blanket
    check breaks the provider override at `app-ci.yml:749`.
  Keep the existing per-secret `grep` calls; this adds a precondition, it does not replace them.
  *Verify GREEN*: re-run T024h's three cases · *Expected*: **3 of 3 now exit non-zero**, each naming the
  variable. **This is SC-010.**
- [ ] **T024j [US5]** Confirm the override path still works: `MODEL_PROVIDER=ollama` with an empty
  `ANTHROPIC_API_KEY` and both other secrets set. *Expected*: step passes — the conditional holds and
  T024i did not over-tighten.
- [ ] **T024k [US5]** *Prove the scan is sensitive, not merely present* (FR-020). Plant a canary value
  matching each guarded secret into a scratch `security/zap/reports/` file in turn and confirm the step
  **fails and refuses to publish**. *Expected*: **3 of 3 detected**. **This is SC-011.**
  A fail-closed assertion that has never been observed failing is the same unverified control in a new
  shape — this task is what makes US5 real.
- [ ] **T024l [US5]** Decide and record the empty/missing reports-directory behaviour (acceptance
  scenario 5): today a missing directory makes every `grep` miss and the step pass. State explicitly
  whether that is intended (nothing was produced, so nothing can leak) or should fail, and implement
  the recorded choice.

---

## Phase 6: Polish & cross-cutting

- [ ] **T025** Update [MCM-Testing-Strategy.md](../../docs/proposals/MCM-Testing-Strategy.md) §5.6 and
  §9 so the documented pre-deploy gate now matches reality — this feature closes the three-way
  docs↔reality gap the PRD identified.
- [ ] **T026** Correct `test_golden_pairs.py`'s docstring, which references a long-gone feature-012
  "T063" as the pre-deploy gate. Point it at the target built in T014.
- [ ] **T027** Add a knowledge entry recording the **marker-not-directory** mechanism: the golden tier
  is selected by `@pytest.mark.golden` within `tests/integration/`, and moving a test into
  `tests/golden/` would make it run nowhere. This is the trap most likely to bite the next person.
- [ ] **T028** Full-suite validation per the
  [final validation checklist](../../openwiki/invariants/feature-validation-checklist.md), including
  the web E2E regression. Set `MCM_REQUIRE_LIVE_STACK=1` and `E2E_REQUIRE_AGENT_STACK=1` and **watch
  the SKIP COUNT** — a skip otherwise reads as a pass.
- [ ] **T029** `rtk gain` — confirm >80% compression.

---

## Dependencies & Execution Order

- **Phase 1** → **Phase 2** → Phases 3/4; **Phase 5** is independent of 2–4; **Phases 5b (US4)** and
  **5c (US5)** are independent of everything and can land first.
- **T024a–c are parallel**; **T024e blocks T024g** (never delete the old secret before the new ones are
  proven to carry traffic).
- **T024h blocks T024i** (establish the defect before fixing it); **T024i blocks T024j and T024k**.
- **US4 and US5 both edit `app-ci.yml`** — sequence them or expect a trivial conflict. They touch
  different steps (job `env:` blocks vs the leak-scan step), so either order works.
- **T003–T008 block T009–T013.** Closing the skip paths first is what makes the conversion verifiable.
- **T009, T010 block T011** (cassettes must exist before the marker deselects the live path).
- **T011 blocks T012.**
- **US1 and US2 must merge together** — T011 without T017 drops the live verification entirely.
- **T020, T021 block T022**; **T023 blocks T024**.

### Parallel opportunities

- T020 and T021 touch different files and can run together.
- Phase 5 can proceed alongside Phases 2–4 (different projects, no shared state).

## Implementation Strategy

**MVP is Phases 2+3+4 together** — the golden conversion plus the live gate. Phase 5 can follow in
the same PR or a subsequent one; a failure in either is unambiguously attributable, so
[batching](../../openwiki/process/pull-request-batching.md) is appropriate by default.

## Traps carried in from the 047 PR B session

- **Verify by RESULT, not exit status.** Watch the SKIP COUNT on every run above.
- **A test that fails when you break it is SENSITIVE, not CORRECT** — T013 and T022 exist for this.
- **Both images are baked.** A client change needs `pnpm nx docker-build mcm-app`; an agent change
  needs `node scripts/agent-stack.mjs`. A stale image fails exactly like the bug you are hunting.
- **`pnpm nx e2e mcm-app` cannot run in the dev container, but Playwright can** — official image,
  `--network host`, `--user "$(id -u):$(id -g)" -e HOME=/tmp`. See
  [e2e-testing.md](../../docs/runbooks/e2e-testing.md).
- **Never use `rg -rn` / `rg -ril`** — `-r` is `--replace` and silently eats the pattern. Use `rg -n`
  or `grep -rn`, and treat an empty result as unconfirmed until checked a second way.
- **Opening the PR**: push a REAL branch (`git push origin HEAD:<branch>`) then `POST …/pulls` with the
  `git credential fill` credential. An AGit push runs CI with **no** Actions secrets.
