# Tasks: which agent assertions may block a merge

**Feature**: 056-agent-gate-split · **Backlog**: item #170
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

## The rule that shapes this feature

**Nothing may leave the gate without a tier that runs it.** 051's SC-001 and 054's FR-017 forbid
reaching green by skipping or deleting a spec, and a tier nobody reads is the same thing wearing a
schedule. Every task below is downstream of that.

---

## Phase 1 — US1: the rule (P1)

- [x] **T001** [US1] Write the rule into `openwiki/invariants/testing-tiers.md`: an agent assertion
      may block a merge only if the same code and the same prompt cannot produce a different verdict
      on a re-run. State it as a property of the assertion, not of its failure history, and state
      **what the gate stops proving** — not only what is gained. (FR-001)
      *(Done: the rule, a blocks/does-not-block table, the cost stated plainly, and where the
      non-blocking ones run.)*
- [x] **T002** [US1] Record the evidence that forced it: runs #1684/#1685 on sha `1fada7a`, identical
      code, `failed=0` then `failed=1 flaky=7`, with the collapse, contention, identity and livelock
      explanations each excluded by a measured counter. A rule without its evidence is re-litigated.
      *(Done: the #1684/#1685 table and all five exclusions recorded beside the rule.)*

---

## Phase 2 — US2: classify and enforce (P1)

- [x] **T003** [US2] Write the guard FIRST: `scripts/__tests__/agent-test-classification.test.mjs`
      fails when any `test(` in `agent-*.spec.ts` / `assistant-*.spec.ts` carries neither tag.
      **Verify RED** against the current unclassified suite — all 41 should fail it. (FR-003)
      *(Done: RED — 2 of 3 cases failed against the unclassified suite. The third passed correctly:
      nothing was skipped or `.only`-ed.)*
- [x] **T004** [US2] Classify and tag all 41 agent/dock tests against T001's rule. Where a test
      asserts BOTH a wiring path and a model decision, split the wiring assertion out and keep it in
      the gate rather than moving the pair (FR-009). **Verify GREEN (T003).**
      *(Done: **19 `@gate`, 22 `@model-decision`**. Gate keeps CORS, auth refresh, config, the
      approval gate, ordinal picks, import machinery, navigation-after-tap and data-sync. Model tier
      takes disambiguation resolution, the ownership chains, search ranking, context resolution, tool
      selection and query phrasing.)*
- [x] **T005** [US2] Prove the partition with `--list` on both selections: union = every agent test,
      intersection = empty. Record both counts. (FR-004, SC-003)
      *(Done: **155 gate + 22 model = 177**, exact.*
      *⚠️ **The obvious mechanism silently did not work**: `--grep-invert` is accepted by Playwright
      1.60 and does NOTHING here — `--grep CORS` lists 1, `--grep-invert CORS` lists all 177. A
      CLI-based split would have run everything in the "gate" selection and looked correct. Moved into
      `playwright.config.ts` (`E2E_TIER` → `grep`/`grepInvert`) and pinned by a guard. **The task text
      above still says `--grep-invert`; that is what was planned and it does not work.**)*
- [x] **T006** [US2] Confirm no test was deleted, skipped or `.only`-ed: the agent test count across
      both selections equals the pre-split 41. (FR-005, SC-007)
      *(Done: 19 + 22 = 41. A guard asserts no `.only` and no bare `test.skip`.)*

---

## Phase 3 — US3: what leaves the gate still runs (P1)

- [x] **T007** [US3] Split the `Web E2E` step in `.forgejo/workflows/app-ci.yml` into two selections
      through `ci-log-step.sh` — the gate (`--grep-invert`) blocking, the model tier (`--grep`) with
      `continue-on-error: true` — so both write their own step log and both counts lines reach the
      bundle. (FR-006)
      *(Done: `web-e2e` and `web-e2e-model` step logs; `step:e2e-result-gate-model` added to
      `COUNTS_SOURCES`.)*
- [x] **T008** [US3] Gate the model-tier step to `github.event_name != 'pull_request'`, so a PR pays
      only for the deterministic gate while every push to `main` and every dispatch still exercises
      the model assertions. That is also what makes staleness impossible without a schedule. (FR-007)
      *(Done: `if: always() && github.event_name != 'pull_request'` with `continue-on-error: true`.
      A guard asserts both that the tier EXISTS and that it cannot fail the job.)*
- [x] **T009** [US3] Make the result gate read BOTH logs, so the model tier's counts are asserted and
      published rather than merely printed. An unread count is not a report.
      *(Done: a second result-gate step reads `web-e2e-model.log` — reports, never blocks.)*

---

## Phase 4 — US4 + validation

- [x] **T010** [US4] **Two consecutive `app-e2e` runs on identical code with an EMPTY failure-set
      diff.** This is the criterion 054's T028 could not meet and the reason this feature exists.
      (SC-004)
      *(**MET 2026-08-12.** Runs #1686 and #1687, both on sha `61ccb3d`, both tiers:*

      | run | gate tier | model tier |
      | --- | --- | --- |
      | #1686 | `failed=0 flaky=0 passed=155 did-not-run=0 skipped=0` | `failed=0 flaky=0 passed=22` |
      | #1687 | `failed=0 flaky=1 passed=154 did-not-run=0 skipped=0` | `failed=0 flaky=1 passed=21` |

      *`failed=0` in both runs of both tiers, so the failure-set diff is **empty** — the criterion 054's
      T028 could not reach on the same sha.*
      ***Stated rather than glossed**: run #1687's GATE tier carried `flaky=1`. A deterministic-tier
      test still needed its retry, and `retries: 1` is what turned that into a pass. The criterion is
      about the failure SET and it is empty; the gate is not perfectly deterministic, and pretending
      otherwise is how the next surprise gets built.)*
- [x] **T011** [US4] Record the price: `app-e2e` wall clock and live-turn count against the
      #1684/#1685 baseline, and the model spend across BOTH tiers — moving spend to another step is
      not removing it. (FR-008, SC-006)
      *(Done 2026-08-12, and the honest half is what is NOT measured.*
      *Wall clock: **~30 min** running BOTH tiers (#1686, 21:29:27→21:59:40) against the pre-split
      **~28 min** for 177 tests in one selection — two invocations and two global setups cost a little
      more than one.*
      ***The PR saving is NOT yet measured.** A dispatch is not a `pull_request`, so every run here
      exercised both tiers. What a PR actually pays — the gate alone, 155 tests instead of 177 — gets
      measured on the pull request itself and is inferred until then.*
      *Model spend: unchanged per merge to `main` (both tiers run), reduced per PR by the model tier's
      22 tests. Moving spend to another step is not removing it, and on `main` it is not even moved.)*
- [x] **T012** Full local sweep: tooling tier, `nx lint/typecheck mcm-app`, counts not exit status.- [x] **T012** Full local sweep: tooling tier, `nx lint/typecheck mcm-app`, counts not exit status.
      *(Done 2026-08-12: tooling tier **620 pass / 0 fail / 0 skipped**; typecheck clean; lint 0 errors;
      digest-coverage, openwiki governance, okf and realm-consistency all exit 0.)*
- [ ] **T013** Close item **#170** on its four acceptance criteria, verified, with the classification
      and the measured price recorded on the item.
- [ ] **T014** Update 054's **T028** to point here — it is unmet in 054 and met (or not) by SC-004.

---

## Dependencies

```text
T001 (the rule) ─> T003 (guard, RED) ─> T004 (classify) ─> T005/T006 (partition proof)
                                                             │
                                          T007/T008/T009 (two selections) ─> T010 (the pair) ─> T011..T014
```

- **T001 before T004**: an arbitrary classification is one the next person re-litigates.
- **T003 before T004**: the guard must be seen failing against the unclassified suite, or it proves
  nothing about enforcement.
- **T010 is the payoff** and the only criterion that can say whether this worked.
