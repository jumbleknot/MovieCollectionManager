# Handoff — 047 Movie Assistant Enhancements

**Branch**: `047-movie-assistant-enhancements` (2 commits, clean tree) · **Date**: 2026-08-02
**Status**: spec → plan → tasks → analyze complete. **No implementation code written yet.**

Read [plan.md](./plan.md) first (CLAUDE.md's SPECKIT region already points there), then
[tasks.md](./tasks.md). This file holds only what those two cannot tell you — session state, traps,
and decisions whose *reasoning* matters more than their outcome.

---

## Start here

1. **PR A first** — US2 (import loop), US4 (ownership), US5 (search cancel). Ready to code now.
2. **PR B second** — US1 (navigate), US3 (large import). Both blocked on research tasks.
3. Within PR A, US2 alone is a meaningful stop point: it makes spreadsheet import usable again.

**Two research tasks gate PR B. Do not skip them.**

| Task | Question | Consequence of skipping |
|---|---|---|
| **T001** | What actually emits `"Sorry — I couldn't complete that just now."` for a navigate request? | You would fix a pagination defect that may not be the reported symptom. See below. |
| **T002** | Does `@copilotkit/react-native`'s `useAgent` expose agent state / `STATE_DELTA`? | T052a's client wiring differs entirely by answer; building the wrong one is a rewrite. If the state channel is unavailable, **FR-014a goes back to the product owner** — do not silently redefine "updates in place" as an appending line. |

---

## Environment traps

**PowerShell is not installed in this devcontainer.** Every Spec Kit script is `.ps1`
(`setup-plan.ps1`, `setup-tasks.ps1`, `check-prerequisites.ps1`) and there is no bash equivalent
under `.specify/scripts/`. Resolve the feature directory from `.specify/feature.json` instead —
it currently reads `specs/047-movie-assistant-enhancements`.

**Spec Kit git hooks auto-commit.** `.specify/extensions.yml` sets `auto_execute_hooks: true`, so
`after_*` hooks commit even when presented as optional. Expect commits you did not explicitly make.

**Task IDs are not all three digits.** Remediation added eight suffixed tasks — T044a–T044e, T052a,
T058a, T075a. A `T[0-9]{3}` scan silently misses them. 109 tasks total.

---

## Do not rebuild these — they already exist

The single largest wasted-work risk on this feature.

- **FR-019a (bulk-import rate allowance) is already implemented.** Feature 040 added
  `skip_rate_limit=True` to the import node's dedup reads and the approval gate's writes
  ([runtime_nodes.py:632](../../agents/movie-assistant/src/runtime_nodes.py#L632),
  [:647](../../agents/movie-assistant/src/runtime_nodes.py#L647),
  [:996](../../agents/movie-assistant/src/runtime_nodes.py#L996)), with a comment recording that a
  200-row import once applied only 30 rows. T047/T048 pin it with a regression test — **that is the
  whole task**. Do not build a new allowance.
- **The import approval payload is already compact.** `build_approval_request` previews an import as
  a tab-level summary, not per-item, so the HITL interrupt is *not* a large-import bottleneck.
- **mc-service already enforces the ownership cross-field rules.** `OwnedMediaWhenOwnedSpec` and
  `RipQualityWhenRippedSpec` reject formats on an unowned movie and qualities on an unripped one.
  FR-027 is validated in the domain layer — **the agent must not duplicate it**.
- **The adversarial test harness already exists.** `tests/fixtures/adversarial.py`,
  `test_resolvers_adversarial.py`, `test_resolvers_properties.py` (Hypothesis),
  `test_recorded_phrasing_resolves.py` (recorded-output bridge), `test_state_machine_transitions.py`.
  New resolvers **join** these; do not create parallel harnesses. A resolver not registered with the
  catalogue is not covered by it (013 Inc5 lesson).

---

## Proven vs. hypothesised

Keep these apart — one is safe to code against, the other is not.

**Proven by reading the code:**

- **US2's loop.** `_article_prompt` keeps the raw title *including its trailing space* as both the
  option label and the resolution key
  ([import_disambiguation.py:130](../../agents/movie-assistant/src/nodes/import_disambiguation.py#L130)),
  and `resolve_option` matches with `title in low`
  ([supervisor.py:78-81](../../agents/movie-assistant/src/nodes/supervisor.py#L78-L81)). A
  trailing-space label is *longer* than the trimmed reply, so the substring test can never match.
  Nothing resolves, nothing is recorded, the question re-fires forever with no repeat counter and no
  escape.
- **US1's pagination defect.** The navigator reads the *entire* target collection before it can
  navigate ([navigator.py:275](../../agents/movie-assistant/src/nodes/navigator.py#L275)), walking up
  to 200 keyset pages ([runtime_nodes.py:389-407](../../agents/movie-assistant/src/runtime_nodes.py#L389-L407)).
  A 2,500-movie collection is 50 calls against a 30-per-60 s cap the navigator is **not** exempt
  from. Call 31 returns `ok=False`, the loop `break`s, and the list is silently truncated.

**Hypothesised, and the reason T001 exists:** that the pagination defect is what produces the
*generic message the member reported*. It probably is not — the message is emitted in only four
places and **the navigator is not one of them** (it is pure code with no model call), and the string
does not exist anywhere in `frontend/`. The live candidates are an open circuit breaker
(`ErrorRateBreaker`, 0.5 failure rate over a 20-run window, 30 s cooldown — which would degrade
*every* intent, matching "it used to work") or a misclassification into a model-backed node. Fix the
pagination regardless; hold the FR-004/FR-005 message work until T001 says which path fires.

---

## Decisions whose reasoning matters

- **Media formats come from the domain, not the agent** ([RQ-4](./research.md#rq-4), product-owner
  decision). New mc-service endpoint → movie-mcp tool → organizer. The list must be derived by
  **exhaustive match** over `MediaFormat` so adding a variant fails to compile until published — a
  hand-written array reintroduces exactly the rot this decision rejected. If the metadata call
  fails, **skip** the format question and add with no formats; never fall back to a guessed list.
  The existing `filter-options` endpoint cannot serve this — it returns values *observed* in a
  collection, so an empty collection returns nothing.
- **Two PRs, not five.** The batching rule is O(N²) in CI runs, not linear. The boundary is
  readiness ∥ the one real ambiguity: US3 changes the **shared** approval gate (add, organize *and*
  import), so US3 beside US4 would make a red `agent-add-ownership.spec.ts` unattributable. Do not
  re-split; in particular, splitting US4's three layers would produce a PR whose story-level e2e
  cannot pass.
- **Concurrency bound is 8, derived not guessed.** At ~250 ms/write, sequential apply of 2,000 rows
  is ~500 s — inside SC-006's 10 min only if latency never slips. **Sequential already almost meets
  the target**; concurrency buys headroom and the 5,000-row case. If it looks risky in review,
  reverting to sequential is survivable for 2,000 rows.
- **T044e and T075a are characterisation guards with no RED state.** Do not manufacture a synthetic
  failure to satisfy the TDD rule — the exemption is written into tasks.md's header.

---

## Before opening either PR

- Golden suite must pass **without re-recording** (T092). Every changed resolver is pure code and no
  prompt or classification path is touched, so a needed re-record means something changed that the
  plan says should not have — investigate first.
- Rebuild and redeploy gateway / movie-mcp / mc-service **before** any E2E (T097). A container
  recreated from a non-rebuilt image silently runs old code (013 Inc5 lesson).
- PR head must be a **real branch**: `git push origin HEAD:<branch>` then `POST …/pulls` using the
  `git credential fill` credential. An AGit push (`HEAD:refs/for/main`) runs with **no Actions
  secrets** and fails as a bogus nx "Misconfigured remote cache endpoint".
- Run `pnpm nx preflight` before pushing — catches offline-knowable failures without a runner slot.
