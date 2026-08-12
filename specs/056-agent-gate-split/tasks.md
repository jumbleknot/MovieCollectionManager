# Tasks: which agent assertions may block a merge

**Feature**: 056-agent-gate-split · **Backlog**: item #170
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

## The rule that shapes this feature

**Nothing may leave the gate without a tier that runs it.** 051's SC-001 and 054's FR-017 forbid
reaching green by skipping or deleting a spec, and a tier nobody reads is the same thing wearing a
schedule. Every task below is downstream of that.

---

## Phase 1 — US1: the rule (P1)

- [ ] **T001** [US1] Write the rule into `openwiki/invariants/testing-tiers.md`: an agent assertion
      may block a merge only if the same code and the same prompt cannot produce a different verdict
      on a re-run. State it as a property of the assertion, not of its failure history, and state
      **what the gate stops proving** — not only what is gained. (FR-001)
- [ ] **T002** [US1] Record the evidence that forced it: runs #1684/#1685 on sha `1fada7a`, identical
      code, `failed=0` then `failed=1 flaky=7`, with the collapse, contention, identity and livelock
      explanations each excluded by a measured counter. A rule without its evidence is re-litigated.

---

## Phase 2 — US2: classify and enforce (P1)

- [ ] **T003** [US2] Write the guard FIRST: `scripts/__tests__/agent-test-classification.test.mjs`
      fails when any `test(` in `agent-*.spec.ts` / `assistant-*.spec.ts` carries neither tag.
      **Verify RED** against the current unclassified suite — all 41 should fail it. (FR-003)
- [ ] **T004** [US2] Classify and tag all 41 agent/dock tests against T001's rule. Where a test
      asserts BOTH a wiring path and a model decision, split the wiring assertion out and keep it in
      the gate rather than moving the pair (FR-009). **Verify GREEN (T003).**
- [ ] **T005** [US2] Prove the partition with `--list` on both selections: union = every agent test,
      intersection = empty. Record both counts. (FR-004, SC-003)
- [ ] **T006** [US2] Confirm no test was deleted, skipped or `.only`-ed: the agent test count across
      both selections equals the pre-split 41. (FR-005, SC-007)

---

## Phase 3 — US3: what leaves the gate still runs (P1)

- [ ] **T007** [US3] Split the `Web E2E` step in `.forgejo/workflows/app-ci.yml` into two selections
      through `ci-log-step.sh` — the gate (`--grep-invert`) blocking, the model tier (`--grep`) with
      `continue-on-error: true` — so both write their own step log and both counts lines reach the
      bundle. (FR-006)
- [ ] **T008** [US3] Gate the model-tier step to `github.event_name != 'pull_request'`, so a PR pays
      only for the deterministic gate while every push to `main` and every dispatch still exercises
      the model assertions. That is also what makes staleness impossible without a schedule. (FR-007)
- [ ] **T009** [US3] Make the result gate read BOTH logs, so the model tier's counts are asserted and
      published rather than merely printed. An unread count is not a report.

---

## Phase 4 — US4 + validation

- [ ] **T010** [US4] **Two consecutive `app-e2e` runs on identical code with an EMPTY failure-set
      diff.** This is the criterion 054's T028 could not meet and the reason this feature exists.
      (SC-004)
- [ ] **T011** [US4] Record the price: `app-e2e` wall clock and live-turn count against the
      #1684/#1685 baseline, and the model spend across BOTH tiers — moving spend to another step is
      not removing it. (FR-008, SC-006)
- [ ] **T012** Full local sweep: tooling tier, `nx lint/typecheck mcm-app`, counts not exit status.
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
