---

description: "Task list for 101 — doc-drift prevention"
---

# Tasks: Doc-Drift Prevention (doc-impact sweep + periodic drift audit)

**Input**: `specs/101-doc-drift-prevention/` — spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required. The guard is a gate script, so every failure code gets a test that is RED before
the code exists (constitution TDD and `docs/templates/feature-test-tasks-template.md`).

**Template note**: This feature creates the project override, so its own tasks were generated from
the **core** template (`TASKS_TEMPLATE` resolved to `.specify/templates/tasks-template.md`, since
`overrides/` did not exist yet). The sweep below is done by hand, as the override will make every
later feature do it.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [x] T001 **Doc-impact sweep** (dogfood, run 2026-11-15 while generating this file). Searched every `*.md` outside `specs/`, `docs/proposals/`, `docs/decisions/` and `.specify/templates/` with `git grep -n -E "<term>" -- '*.md' ':!specs/' ':!docs/proposals/' ':!docs/decisions/' ':!.specify/templates/'`.
  **Terms** (identifiers whose meaning this feature changes): `tasks-template` (the core template is no longer what task generation uses); `Documentation updates in docs` (the line being replaced); `TASKS_TEMPLATE`; `2.9.0` (constitution version); `templates/overrides`; `Resolve-Template`.
  **Results**:
  - `openwiki/process/constitution.md:4,21,92` (`v2.9.0`) → **T021** (refresh after the constitution bump).
  - `.github/agents/speckit.tasks.agent.md:76` reads `.specify/templates/tasks-template.md` directly, so the Copilot integration bypasses overrides. **No edit**: Spec Kit-owned (`copilot.manifest.json`), and an upgrade rewrites it. Recorded instead in the runbook (**T017**) as a known gap, covered by the constitution rule (**T013**).
  - `.claude/skills/speckit-constitution/SKILL.md:88`, `.github/agents/speckit.constitution.agent.md:48`: a constitution amendment checks the core tasks template for consistency. **No edit** (Spec Kit-owned). The runbook (**T017**) says to check the override too.
  - `.claude/skills/speckit-tasks/SKILL.md:59,78` (`TASKS_TEMPLATE`): already describes override resolution correctly. No change.
  - `.specify/memory/constitution.md:118`, `openwiki/invariants/feature-validation-checklist.md:13`, `openwiki/process/test-authoring-conventions.md:4,48,58`, `CLAUDE.md:110`, `openwiki/process/index.md:7`: refer to `docs/templates/feature-test-tasks-template.md`, a different file. No change.
  - `Documentation updates in docs`, `templates/overrides`, `Resolve-Template`: no hits outside the excluded records.
- [x] T002 Create `.specify/templates/overrides/` (empty directory placeholder lands with T008).

---

## Phase 2: Foundational

- [x] T003 Scaffold `scripts/check-speckit-overrides.mjs`: shebang, header comment (why: proposal §4, the shadowing risk), `partitionArgs` from `scripts/lib/argv-contract.mjs` accepting `--record`, `--selftest`, `--help` (mutually exclusive, no positionals, exit 2 on violation), exported stubs `checkSpeckitOverrides`, `recordForkPoint`, `parseForkPoint` that throw `not implemented`, and a `main` guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`.

**Checkpoint**: The tests in Phase 3 can import the module.

---

## Phase 3: User Story 2 — the fork guard (P1)

Built before US1's override, because the override's header is written by this story's `--record`
(FR-006: never hand-typed).

**Goal**: A required check fails on any of the four drift conditions, and `--record` resolves the first.
**Independent Test**: quickstart §1, §2, §4.

### T004 — Tests for fork-point parsing and every failure code

**Type**: Test | **Risk**: Low

**Spec reference**: spec.md User Story 2

**Scenarios covered**:
- US2-AC1: a core fingerprint mismatch fails and names both templates, with a diff or the history-unavailable note
- US2-AC2: a missing override, or one without the sweep, fails and says which
- US2-AC3: broken override-first resolution fails
- US2-AC4: `--record` rewrites the fork point from the core's current content, and the guard then passes

**File(s)**: `scripts/__tests__/check-speckit-overrides.test.mjs`

Each test builds a temp-dir fixture tree (`.specify/templates/tasks-template.md`,
`.specify/templates/overrides/tasks-template.md`, `.specify/scripts/powershell/common.ps1` with a
minimal `function Resolve-Template { … overrides/ … presets … }`,
`.specify/scripts/powershell/setup-tasks.ps1` with the `Resolve-Template -TemplateName 'tasks-template'`
line, `.specify/init-options.json`), then asserts on `checkSpeckitOverrides({ root })`:
- `parseForkPoint`: valid line → fields; wrong core path / short hash / missing comment → `null`
- clean fixture → `ok: true, failures: []`
- override deleted → `override-missing`
- first line not a header → `header-invalid`
- no `- [ ] … **Doc-impact sweep**` line → `sweep-missing` (a sweep mention that is not a task line does not count)
- core byte changed → `core-changed`, the message contains both paths and `history unavailable` (the fixture is not a git repo)
- core changed in a fixture that **is** a git repo (`git init`, commit the base, change core) → the message contains the unified diff line that was added
- `setup-tasks.ps1` without `Resolve-Template -TemplateName 'tasks-template'` → `resolution-broken`
- `common.ps1` with `presets` checked before `overrides/` → `resolution-broken`
- two faults at once → both codes reported
- `recordForkPoint` after a core change → returns previous ≠ current, header now matches, and the scan is clean
- `recordForkPoint` on an override with no sweep → throws (refuses to record)
- CLI: `--recrod` → exit 2 and the fixture's override bytes unchanged; `--help` → exit 0 and nothing written

**Verify RED**:
```bash
node --test scripts/__tests__/check-speckit-overrides.test.mjs
```
**Expected RED**: every test failing with `not implemented` (the stubs from T003), except the argv cases, which T003 already satisfies.

### T005 — Implement the guard

**Type**: Implementation | **Risk**: Low

**Prerequisite**: T004 verified RED.

In `scripts/check-speckit-overrides.mjs` implement, per `contracts/check-speckit-overrides.md` and `data-model.md`:
`parseForkPoint`; `checkSpeckitOverrides` (all five codes, all evaluated); the fork-base diff (research R5:
walk `git log --format=%H -- <core>`, SHA-256 each `git show <sha>:<core>`, `git diff <match> -- <core>`,
any git error → the "history unavailable" note, still a failure); `recordForkPoint` (refuses without the
sweep marker; writes line 1 from the core's current SHA-256 and `init-options.json` `speckit_version`);
output lines and the remediation line exactly as the contract states.

**Verify GREEN**:
```bash
node --test scripts/__tests__/check-speckit-overrides.test.mjs
```
**Expected GREEN**: 0 failures, 0 skipped.

### T006 — `--selftest`

**Type**: Implementation | **Risk**: None

Add `--selftest` in the same file: build each fixture from T004 in a temp dir and assert the expected
code (and the clean pass), printing `✓ speckit-overrides gate --selftest passed (…)`, matching the sibling gates.

**Verify GREEN**: `node scripts/check-speckit-overrides.mjs --selftest; echo $?` prints the ✓ line and `0`.

### T007 — Wire the guard into guardrails

**Type**: Config change | **Risk**: Low | **Spec reference**: FR-007

In `.forgejo/workflows/guardrails.yml`, after the override-consistency gate step, add
`- name: Spec Kit override gate (selftest + scan — the tasks-template fork and override-first resolution, feature 101)`
with a short comment (why: an upgrade otherwise silently drops or stales the sweep) and two lines
through `bash scripts/ci-log-step.sh naming-speckit-override-gate node scripts/check-speckit-overrides.mjs --selftest`
and the same without `--selftest`.

**Done when**: `node scripts/check-ci-digest-coverage.mjs` passes, and the YAML parses (`node -e "require('yaml')…"`).

**Checkpoint**: The guard exists and runs in CI. On `main` it would fail with `override-missing` until US1 lands, so US1 lands in the same PR.

---

## Phase 4: User Story 1 — the override with the sweep task (P1) 🎯 MVP

**Goal**: Every task list generated from now on carries the doc-impact sweep.
**Independent Test**: quickstart §3.

- [x] T008 [US1] Create `.specify/templates/overrides/tasks-template.md` as a byte copy of `.specify/templates/tasks-template.md`, preceded by a placeholder line 1 (`<!-- forked-from: .specify/templates/tasks-template.md sha256=0 spec-kit=0.11.2 -->`, rewritten by T010). Then make the two edits from research R2:
  (a) end of Phase 1: `- [ ] T00X **Doc-impact sweep** — …` carrying the proposal §3.1 text verbatim, plus: *run the searches now, while generating tasks.md; record the terms and each hit with its disposition in this task; emit one named doc task per hit in the Polish phase*, and the search command shape used in this file's T001;
  (b) Polish: replace `- [ ] TXXX [P] Documentation updates in docs/` with `- [ ] TXXX [P] One doc task per sweep hit (from the Doc-impact sweep task), each naming its file` and add `- [ ] TXXX **Close-out re-search**: re-run the sweep's searches for the OLD identifiers; every remaining hit in a doc stating current procedure is fixed or justified here`.
- [x] T009 [US1] Verify RED on the real tree: `node scripts/check-speckit-overrides.mjs; echo $?` reports `header-invalid` or `core-changed` (placeholder hash) and `1`.
- [x] T010 [US1] `node scripts/check-speckit-overrides.mjs --record`, then the scan → ✓ and `0` (Verify GREEN). Run `pwsh -NoProfile .specify/scripts/powershell/setup-tasks.ps1 -Json` → `TASKS_TEMPLATE` ends in `overrides/tasks-template.md`.
- [x] T011 [US1] Demonstrate SC-002 on the real tree (quickstart §2): append a line to the core template → scan fails `core-changed` with the diff → `--record` → passes; then restore both files with `git checkout --`. Paste both outputs into the PR body.
- [x] T012 [US1] Scratch `/speckit-tasks` run (done 2026-11-15: `setup-tasks.ps1` returned the override; the scratch tasks.md was written from it by the session, carrying a sweep that found 20 files for `gen-dev-env`) (quickstart §3): create an uncommitted `specs/999-scratch/` with a stub spec.md and plan.md (a one-story feature that renames one script), point `.specify/feature.json` at it, generate tasks, and confirm a `**Doc-impact sweep**` task with recorded terms and no `Documentation updates in docs/` line. Paste the sweep task into the PR body, then delete `specs/999-scratch/` and restore `.specify/feature.json`.

**Checkpoint**: US1 and US2 together form the MVP. The guard is green on the tree.

---

## Phase 5: User Story 3 — the rule (P2)

- [x] T013 [P] [US3] `.specify/memory/constitution.md`: append to the **Documentation** bullet under AI Assistant Constraints: *"Every feature MUST run the doc-impact sweep when its tasks are generated (list the identifiers it renames, removes or changes the meaning of, search every doc that states current procedure for each, and turn every hit into a named doc task or a one-line justification), record the terms and results in `tasks.md`, and re-run the searches for the old identifiers at close-out."* Add history line `v2.10.0` (2026-11-15, feature 101, item #1021; adds an obligation, no principle redefined) and mark it `[CURRENT]` (remove the marker from v2.9.0). Footer: `**Version**: 2.10.0 | … | **Last Amended**: 2026-11-15`.
- [x] T014 [P] [US3] `openwiki/invariants/feature-validation-checklist.md` (canonical, so the edit goes into the concept): add after the first item `- [ ] **Doc-impact close-out** — re-run the doc-impact sweep's searches (from tasks.md) for the OLD identifiers; every remaining hit in a doc that states current procedure is fixed, or justified in tasks.md`. This is outside the fingerprinted `Gotchas` passage, so `protected.yaml` is untouched.
- [x] T015 [US3] Confirm the governance gate still sees the checklist's protected passage intact: `node scripts/check-openwiki-governance.mjs`.

**Upgrade runbook section**: written as part of T017 (US4 owns the new runbook file).

---

## Phase 6: User Story 4 — the runbook and the audit chain (P3)

- [x] T016 [US4] Create `docs/runbooks/doc-drift.md`: purpose (docs-from-code, contrasted with V17's wiki-from-docs), the three layers in one table, and links to the proposal and this spec.
- [x] T017 [US4] In the same file, `## Upgrading Spec Kit`: run the upgrade (`specify` CLI per `docs/runbooks/dev-environment-setup.md`); expect `check-speckit-overrides` to fail `core-changed`; read the printed core diff; merge what is worth keeping into the override (keep the sweep and close-out tasks); `--record`; land all three in one PR. Also: if `resolution-broken` fires, override support changed and the guard must be re-evaluated, never deleted. **Known gaps from the T001 sweep**: the Copilot integration's tasks agent reads the core template directly (not covered, and the constitution rule applies), and `/speckit-constitution` checks the core template, so check the override too.
- [x] T018 [US4] In the same file, `## The quarterly drift audit` (FR-011): scope (`docs/runbooks/**`, `docs/MCM-Architecture.md`, project READMEs; not ADRs, `specs/`, proposals or dated records); claim types to verify (paths, commands, nx targets, flags, env vars, names, ports, workflow and job names, links); edit only what is proven wrong, with the smallest true edit; list unprovable suspicions in the PR; chunk by area; refresh affected wiki pages in the same PR (`wiki-refresh --stale`); record lines read, proven drift and the rate per 1,000 lines in a table compared with the previous audit (baseline 2026-11-14: 76 / ~16,800 = 4.5); check SM-3 (would a `describes:` link have caught it, on a feature whose sweep ran?) and, if so, file layer 2; **final step**: file the next audit with `node scripts/backlog.mjs create` (`type/chore`, `priority/p2`, title with the target month about 3 months on), then close the current item.
- [x] T019 [US4] Create `openwiki/runbooks/doc-drift.md` (derived: `resource: docs/runbooks/doc-drift.md`, front matter per `openwiki/INSTRUCTIONS.md`), add it to `openwiki/runbooks/index.md` and to the Runbooks list in `CLAUDE.md`, then `node scripts/wiki-refresh.mjs --record openwiki/runbooks/doc-drift.md` (check `--help` for the exact form first).
- [x] T020 [US4] File the next audit: `node scripts/backlog.mjs create` titled `Drift audit 2027-02 (quarterly, layer 3 of doc-drift prevention)` with acceptance criteria from T018's procedure, labels `type/chore` and `priority/p2`. Record the item number in the PR body and in the runbook's audit log table.

---

## Phase 7: Polish & close-out

- [x] T021 Refresh `openwiki/process/constitution.md` for v2.10.0 (sweep hit from T001): `node scripts/wiki-refresh.mjs --stale`, then `--diff`, edit the version/date lines and add the v2.10.0 paragraph, then `--record`.
- [x] T022 **Close-out re-search** (dogfood of T014): re-run T001's searches. Expect the only `2.9.0` hits to be history lines; record the result here.
  **Result (2026-11-15)**: `2.9.0` → `.specify/memory/constitution.md:27` (history line) and `openwiki/process/constitution.md:92` (its v2.9.0 history paragraph), both history. `Documentation updates in docs` → no hits. Clean.
- [x] T023 Run the touched gates: `node --test scripts/__tests__/*.test.mjs` (watch the skip count), `node scripts/check-speckit-overrides.mjs --selftest && node scripts/check-speckit-overrides.mjs`, `node scripts/check-ci-digest-coverage.mjs`, `node scripts/check-openwiki-okf.mjs`, `node scripts/check-openwiki-governance.mjs`, `node scripts/wiki-refresh.mjs --stale` (empty).
- [x] T024 Run quickstart.md end to end.
- [x] T025 Open the PR from branch `101-doc-drift-prevention` (a real branch, per `docs/runbooks/ci-diagnostics.md`), with the T011/T012 evidence, and comment on item #1021 with the acceptance criteria status.

Not applicable from the final validation checklist: mc-service, mcm-app, E2E and mobile items. This
feature changes no deployable unit and no client path (`scripts/`, `.specify/`, docs, and one
guardrails step only).

---

## Dependencies & Execution Order

- T001 (done) → T002, T003 → **US2** (T004 RED → T005 → T006 → T007) → **US1** (T008 → T009 → T010 → T011 → T012)
- **US3** (T013, T014 [P]) can run any time after T003. T015 follows T014.
- **US4** T016 → T017 → T018 → T019. T020 after T018.
- Polish after all. T021 after T013.
- US1 and US2 must land together (the guard fails `override-missing` without the override).

## Parallel Example

```text
T013 constitution  ‖  T014 checklist  ‖  T016–T018 runbook
```

## Implementation Strategy

MVP = US2 + US1 (the guard and the override), one PR with US3 and US4, because they are small and
none is ambiguous if red (`openwiki/process/pull-request-batching.md`).
