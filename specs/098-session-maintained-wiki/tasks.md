# Tasks: Session-Maintained Wiki Summaries (098)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: REQUIRED by the constitution (TDD, NON-NEGOTIABLE). Every test task gives a **Verify RED**
command and its expected failure. Every paired implementation task gives a **Verify GREEN** command
and its expected output (format: `docs/templates/feature-test-tasks-template.md`).

**Where to run**: the worktree `/home/coder/worktrees/098-wiki`, never `/workspaces/mcm`.

**`node --test` rule**: node's flags go BEFORE the path. `node --test <file> --test-name-pattern x`
silently runs everything (CLAUDE.md). Watch the **skip count** too, not only failures.

**One PR**: the whole feature lands as a single PR, because V17 and the cut-over must merge together.
Between T005 and T026 the real tree fails V17 by design. Only the PR head has to be green.

**Done-when rule for T005–T025**: wherever a task checks `node scripts/check-openwiki-okf.mjs` on the
real tree, "passes" means **no finding other than V17**. Never weaken or skip V17 to get a 0 before
T026.

## Format: `- [ ] [ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Record the baseline in `specs/098-session-maintained-wiki/EVIDENCE.md`:
  - the exit codes of `node scripts/check-openwiki-okf.mjs`, `node scripts/check-openwiki-governance.mjs` and both with `--selftest`;
  - pass/fail/skip counts of `node --test 'scripts/__tests__/wiki-*.test.mjs' 'scripts/__tests__/*openwiki*.test.mjs'`;
  - the V12 drift list, which should be the 12 pages in research R8.
  - **Done when**: all are recorded and every gate exits 0 on the untouched tree.

---

## Phase 2: Foundational (blocks US1, US2, US5)

- [X] T002 Write `scripts/__tests__/openwiki-fingerprint.test.mjs` against fixture bundles built in `mkdtemp`. Covers US1-AC1/AC4, US2-AC1 and the spec's edge cases.
  - **Hashing**: `sourceFingerprint(path)` equals SHA-256 of the bytes with CRLF normalised to LF. An LF file and its CRLF copy hash equal.
  - **`staleDerivedPages({root})` reports, in this precedence order:**
    - nothing for a fresh page;
    - `source changed` after a byte edit;
    - `no fingerprint` when `resource-sha256` is missing;
    - `no fingerprint` when it is not 64 lowercase hex;
    - `resource missing` for a deleted resource;
    - `forbidden field: sources` and `forbidden field: verified`.
  - **Also**: it ignores a page with no `resource` (canonical), and names all three pages that share one resource.
  - **Verify RED**: `node --test scripts/__tests__/openwiki-fingerprint.test.mjs`
  - **Expected RED**: fails with `ERR_MODULE_NOT_FOUND … openwiki-fingerprint.mjs`.
- [X] T003 Implement `scripts/openwiki-fingerprint.mjs`, exporting `sourceFingerprint`, `staleDerivedPages` and `recordSourceFingerprint(pagePath, {now})`.
  - It reuses the front-matter reader the OKF gate already uses; do not write a second parser.
  - `recordSourceFingerprint` rewrites only the front-matter keys `resource-sha256` and `timestamp`, removes `sources` and `verified`, and leaves the body byte-identical.
  - Add a one-line provenance comment citing FR-001/FR-002/FR-009.
  - **Verify GREEN**: the T002 command passes, with 0 failures and 0 skips.

---

## Phase 3: User Story 1 — A stale summary blocks the PR (P1) 🎯 MVP

**Goal**: rule V17 in the required `okf` gate. **Independent test**: quickstart §1 and §2.

- [X] T004 [US1] Add self-test scenarios to `scripts/check-openwiki-okf.mjs` (`--selftest`), per `contracts/okf-v17.md`. Covers US1-AC1..AC4.
  - Scenarios: `v17-fresh` passes, `v17-stale` fails naming the page, `v17-missing` fails, `v17-malformed` fails, `v17-crlf` passes, `v17-canonical-ignored` passes, `v17-sources-field` fails, `v17-resource-missing` fails with the re-point/retire message.
  - **Verify RED**: `node scripts/check-openwiki-okf.mjs --selftest`
  - **Expected RED**: exit 1; the scenarios that expect `rule: 'V17'` fail as "expected V17, got none".
- [X] T005 [US1] Implement V17 in `scripts/check-openwiki-okf.mjs`. It calls `staleDerivedPages` and uses the exact messages from `contracts/okf-v17.md`, including the `wiki-refresh` hint.
  - **Verify GREEN**: `node scripts/check-openwiki-okf.mjs --selftest` exits 0 and its summary line now lists V17.
  - **Expected on the real tree**: `node scripts/check-openwiki-okf.mjs` now exits 1 with about 50 `no fingerprint` lines. This is by design until T026.

---

## Phase 4: User Story 2 — A session refreshes cheaply and honestly (P1)

**Goal**: the refresh CLI, the skill, and the instructions. **Independent test**: quickstart §1.

- [ ] T006 [P] [US2] Write `scripts/__tests__/wiki-refresh.test.mjs` per `contracts/wiki-refresh-cli.md`, using a fixture repo made with `git init` in `mkdtemp`. Covers US2-AC1..AC3.
  - **`--stale`**: output equals `staleDerivedPages`; exit 1 when stale, 0 when clean. `--stale --json` has the documented shape.
  - **`--diff <page>`**:
    - shows only the change since the commit whose bytes match the recorded hash;
    - **with no fingerprint**, diffs from the newest `resource` commit at or before the page's stamp, and labels that base;
    - falls back to the whole file, with a notice, only when neither base exists.
  - **`--record <page>`**:
    - the front-matter diff is exactly `resource-sha256` and `timestamp`;
    - `sources`/`verified` are removed;
    - the body is byte-identical;
    - exit 2 for a canonical or non-existent page.
  - **`--record --all-fresh`**: refuses (exit 1, listing the pages) when any page's resource commit is newer than its stamp.
  - **Arguments**: an unknown flag exits 2 and writes nothing. `--help` exits 0 and writes nothing.
  - **Verify RED**: `node --test scripts/__tests__/wiki-refresh.test.mjs`
  - **Expected RED**: fails, because `scripts/wiki-refresh.mjs` is missing.
- [ ] T007 [US2] Implement `scripts/wiki-refresh.mjs`.
  - Arguments go through `scripts/lib/argv-contract.mjs` (`partitionArgs`, `wantsHelp`, `dieOnArgvError`).
  - Staleness and recording come from `openwiki-fingerprint.mjs`.
  - `--all-fresh` uses `sourceCommitAfterStamp` from `scripts/openwiki-drift.mjs`. That module is removed in T027.
  - **Verify GREEN**: the T006 command passes, with 0 failures and 0 skips.
- [ ] T008 [P] [US2] Write the skill `.claude/skills/wiki-refresh/SKILL.md`. Covers FR-010.
  - **When to use**: you changed a file that is some page's `resource`, or the `okf` check said V17.
  - **Steps**:
    1. `--stale`;
    2. per page, `--diff`;
    3. edit only what the diff invalidates, following `openwiki/INSTRUCTIONS.md`;
    4. `--record`;
    5. commit in the same PR.
  - **Also state**: a fingerprint-only refresh is correct when the diff changes nothing the page says; three pages share `docs/MCM-Architecture.md`; never hand-type a hash.
  - **Done when**: the file exists and the CLI flags it names match the contract.
- [ ] T009 [US2] Update the instructions. Covers FR-011 and US2-AC4.
  - **`CLAUDE.md`**: add **one** gate line under "Gates that run before you act". It says that changing a file that is an `openwiki/` page's `resource` means refreshing that page in the same PR, and links to the skill and to runbook §refresh.
  - **`CLAUDE.md:28`**, in "Where a new learning goes": change "write the learning into the **cited source**, not the concept" to "write it into the cited source **and refresh the concept in the same PR**", keeping the link. This is index text, not prose, so it stays one line.
  - **`AGENTS.md`**: rewrite the "Knowledge wiki (OKF)" notes. Remove "Do not hand-edit pages under `openwiki/` that carry a `resource`" and describe the refresh duty and the manual rebuild.
  - **`AGENTS.md:39`**: this line sits inside the openwiki-generated `OPENWIKI:START` block, which says "Do not hand-edit generated OpenWiki pages". **Do not edit inside the block**, because a rebuild rewrites it. Add an entry to AGENTS.md's existing "corrections to the generated block above" list stating that the no-hand-edit line does not apply here, and why (ADR-0004).
  - **Done when**: `node scripts/check-openwiki-governance.mjs` exits 0. CLAUDE.md is index-only and the gate rejects prose beyond one line.

---

## Phase 5: User Story 3 — The bundle carries only what helps the assistant (P2)

**Goal**: retire Claims bookkeeping, widen the writer policy, and add G14 and ADR-0004. **Independent test**: quickstart §3.

- [ ] T010 [P] [US3] Add self-test scenarios to `scripts/check-openwiki-governance.mjs` (`--selftest`). Covers US3-AC3 and FR-006/FR-007/FR-015.
  - **Accepted**: `actor: [agent, generator]` on `openwiki/**`.
  - **Rejected**:
    - `actor: [generator]` on `docs/**`, which still fails G3;
    - `actor: [agent, robot]`, which fails G2;
    - a derived page with `resource: some/dir/`, which fails G14;
    - `resource: infrastructure-as-code/docker/bff/.env.deploy`, which fails G14;
    - a `resource` matching a `customManagers` `managerFilePatterns` regex from a fixture `renovate.json`, which fails G14.
  - **Removed**: the existing G13 scenarios.
  - **Verify RED**: `node scripts/check-openwiki-governance.mjs --selftest`
  - **Expected RED**: exit 1. The list-actor scenario fails G2 today, and the G14 scenarios report "expected G14, got none".
- [ ] T011 [US3] Implement the governance changes.
  - `scripts/openwiki-policy.mjs`: `actor` may be a string or an array. Add a membership check, and `mayWrite(policy, path, actor)` returns true if `actor` is a member.
  - `scripts/check-openwiki-governance.mjs`:
    - G2/G3 iterate the actor members;
    - add G14, which reads `renovate.json` `customManagers[*].managerFilePatterns` plus the fixed deny-list in research R4;
    - delete G13 and its message.
  - **Verify GREEN**: `node scripts/check-openwiki-governance.mjs --selftest` exits 0, and `node --test scripts/__tests__/check-openwiki-governance.test.mjs` passes.
- [ ] T012 [P] [US3] Extend `scripts/__tests__/openwiki-stamp.test.mjs` (research R2).
  - New case: `conceptStamp` ignores `verified.at`.
  - Existing `verified` cases are changed to assert that it is ignored.
  - **Verify RED**: `node --test scripts/__tests__/openwiki-stamp.test.mjs`
  - **Expected RED**: the new case fails, because `verified.at` is still picked as the newest.
- [ ] T013 [US3] Implement `scripts/openwiki-stamp.mjs`: set `EVENT_FIELDS = ['generated']` and update the header comment's rationale.
  - **Verify GREEN**: the T012 command passes. Then `node scripts/check-openwiki-okf.mjs --selftest` still exits 0.
- [ ] T014 [US3] Update `openwiki/policy.yaml`.
  - `openwiki/**` becomes `actor: [agent, generator]`, with a rationale citing ADR-0004.
  - Delete the `openwiki/.claims/**` and `openwiki/.page-manifest.json` entries.
  - Add `event-driven` entries for `openwiki/process/spec-driven-development.md` (events: `[process-changed]`) and `openwiki/architecture/data-model.md` (events: `[domain-model-changed]`), so that G12 holds once they are canonical.
  - **Done when**: `node scripts/check-openwiki-governance.mjs` exits 0.
- [ ] T015 [US3] Make `process/spec-driven-development.md` and `architecture/data-model.md` canonical (research R3).
  - Remove `resource`, `sources` and `verified` from both.
  - Add both under `authoritative:` in `openwiki/protected.yaml`, each with at least one fingerprinted passage, following the existing entries' form.
  - **Done when**: `node scripts/check-openwiki-governance.mjs` exits 0. `node scripts/check-openwiki-okf.mjs` reports **no** finding on either page; the only findings left on the real tree are V17 `no fingerprint` lines, expected until T026.
- [ ] T016 [US3] Retire Claims bookkeeping.
  - `git rm -r openwiki/.claims openwiki/.page-manifest.json openwiki/.last-update.json`.
  - Add those three paths and `openwiki/.maintenance-state.json` to `.gitignore`.
  - Remove V16, its self-test scenarios, and its import of `scripts/openwiki-claims.mjs` from `scripts/check-openwiki-okf.mjs`.
  - Delete `scripts/openwiki-claims.mjs`, `scripts/wiki-claims-audit.mjs`, and their tests `openwiki-claims.test.mjs` and `wiki-claims-audit.test.mjs`.
  - Delete `scripts/__tests__/openwiki-ignore-claims.guard.test.mjs` together with the `.openwikiignore` lines it guarded, if they existed only for Claims (check first and keep anything else).
  - **Done when**: `git ls-files openwiki/.claims openwiki/.page-manifest.json openwiki/.last-update.json` prints nothing; `git check-ignore` matches all four paths; `node scripts/check-openwiki-okf.mjs --selftest` exits 0; `grep -rn "openwiki-claims\|wiki-claims-audit" scripts .forgejo` finds nothing.
- [ ] T017 [P] [US3] Write `docs/decisions/ADR-0004-session-maintained-wiki.md` and update ADR-0003.
  - **ADR-0004 structure**: Status Accepted, Date 2026-11-10, Deciders Steven Watson. Sections:
    1. decision;
    2. the dated progression table from the proposal's §7, with the measured driver of each step (043 → 044 → Fireworks → deadline → low-effort escalation → #707 → 082 → R19/R20 → US7 → run 5104);
    3. why session-maintained;
    4. what is retired, and the supersession of ADR-0003's Claims half;
    5. the writer-policy change;
    6. revisit conditions.
  - **ADR-0003**: set its status to "Superseded in part by ADR-0004 (Claims on derived pages)" and add a link.
  - **Done when**: `node scripts/check-openwiki-governance.mjs` exits 0, and `node scripts/check-openwiki-okf.mjs` reports nothing beyond the expected V17 `no fingerprint` lines (until T026). `docs/decisions/**` is `event-driven: decision-reached`, so this is the event.

---

## Phase 6: User Story 4 — Manual rebuild of named pages (P3)

**Goal**: dispatch-only `--pages`, with the unattended machinery deleted. **Independent test**: quickstart §5. The paid dispatch is operator-only.

- [ ] T018 [P] [US4] Write the new `--pages` tests in `scripts/__tests__/wiki-maintain.test.mjs`. Covers US4-AC1/AC2 and FR-018/FR-019.
  - **Slicing**: `--pages runbooks/a.md,runbooks/b.md,projects/c.md` builds two slices grouped by area, with the run message from `renderRunMessage`.
  - **Refused with exit 2, before any spend**: a canonical page, an unknown page, an empty list, and `--since`.
  - **Post-step**: each landed page gets a current `resource-sha256` and no `sources`/`verified`, via `recordSourceFingerprint`.
  - **Exit codes**: 0 when all landed, 1 when any named page failed.
  - **Report**: lists `landed:` and `not landed:`.
  - **No state**: no file under `openwiki/.maintenance-state.json` is written.
  - Delete the test cases for range planning, backlog, escalation, cooldowns, drift selection, `--merge-record` and `--claims-audit`. Keep the cases for invocation, `revertUnrequested`, verification and proposal, adapted to `--pages`.
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.test.mjs`
  - **Expected RED**: the new `--pages` cases fail with "unknown argument --pages", exit 2.
- [ ] T019 [P] [US4] Update `scripts/__tests__/wiki-maintain.guard.test.mjs` (FR-017).
  - Keep the dispatch-only assertion.
  - Assert a required `pages` input, and no `max-slices`/`since` inputs.
  - Assert that no step runs `wiki-quiet.mjs`, that no step references `.maintenance-state.json`, and that there is no marker-advance commit step.
  - Remove the assertions about the quiet step, the marker and the cooldown.
  - **Verify RED**: `node --test scripts/__tests__/wiki-maintain.guard.test.mjs`
  - **Expected RED**: the `pages`-input assertion and the no-`wiki-quiet` assertion fail.
- [ ] T020 [US4] Implement `--pages` in `scripts/wiki-maintain.mjs` (research R7).
  - **Add**: slice-building from the named pages, the post-step stamp/strip, and the landed/not-landed report.
  - **Delete**:
    - `computePlan`/`planSlices` range planning, `selectDrift`, `cooledPages`;
    - backlog, escalation and `parked` handling;
    - the run-record functions (`writeRunRecord`, `mergeRunRecords`, `assertRecordShape`);
    - `--plan`/`--since`/`--max-slices`/`--merge-record`/`--claims-audit`;
    - the marker-advance;
    - exit code 3.
  - **Delete with their tests**: `scripts/wiki-quiet.mjs`, `scripts/wiki-escalation.mjs`, `wiki-quiet.test.mjs`, `wiki-escalation.test.mjs`, `wiki-cooldown.test.mjs` and `wiki-drift-plan.test.mjs`.
  - **Verify GREEN**: `node --test scripts/__tests__/wiki-maintain.test.mjs` passes, and `node scripts/wiki-maintain.mjs --selftest` exits 0.
- [ ] T021 [US4] Update `.forgejo/workflows/wiki-maintain.yml`.
  - Add a required `pages` input (a comma-separated `area/page.md` list, validated by the same character-class guard the old inputs used).
  - Remove the `max-slices`/`since` inputs, the "Is anything uncovered?" (`wiki-quiet`) step and its `if:` conditions, and the marker-advance/record-merge step.
  - Pass `--pages "$INPUT_PAGES"`.
  - Rewrite the header comment to describe the manual rebuild.
  - **Verify GREEN**: `node --test scripts/__tests__/wiki-maintain.guard.test.mjs` passes, and `grep -n "wiki-quiet\|maintenance-state\|max-slices" .forgejo/workflows/wiki-maintain.yml` finds nothing.

---

## Phase 7: User Story 5 — The switch-over leaves `main` green (P1, final)

**Goal**: every derived page is fresh and recorded, V17 is live, and V12 is gone. **Independent test**: quickstart §6. Depends on T003, T005, T007, T015 and T016.

- [ ] T022 [US5] Refresh the three pages built on `docs/MCM-Architecture.md`: `openwiki/architecture/system-overview.md`, `openwiki/projects/mc-service.md` and `openwiki/projects/mcp-servers.md`.
  - For each page: run `node scripts/wiki-refresh.mjs --diff <page>`, update only what the source change invalidates, then `--record <page>`.
  - **Done when**: none of the three appears in `--stale`.
- [ ] T023 [P] [US5] Refresh `openwiki/projects/repository.md` (from `README.md`), `openwiki/runbooks/devcontainer.md` and `openwiki/runbooks/wiki-maintenance.md`, using the same procedure.
  - `wiki-maintenance.md`'s source is rewritten in T028; refresh it again after T028.
- [ ] T024 [P] [US5] Refresh the five code-sourced gotcha pages, using the same procedure:
  - `openwiki/gotchas/expo-router-and-transport-traps.md` (`server.js`)
  - `external-id-url-opening.md` (`movie-detail.tsx`)
  - `keycloak-service-account.md` (`keycloak.ts`)
  - `playwright-testid-mapping.md` (`playwright.config.ts`)
  - `session-lifecycle-and-eviction.md` (`session-manager.ts`)
- [ ] T025 [US5] Run `node scripts/wiki-refresh.mjs --record --all-fresh` for every remaining derived page.
  - **Done when**: `node scripts/wiki-refresh.mjs --stale` prints nothing and exits 0, and `grep -rlE "^(sources|verified):" openwiki --include=*.md` finds nothing.
- [ ] T026 [US5] Confirm V17 is live on the real tree (SC-002).
  - **Verify GREEN**: `node scripts/check-openwiki-okf.mjs` exits 0. It exited 1 at T005.
  - Record the before/after in `EVIDENCE.md`, plus the V17 timing, which must be under 5 s (SC-006): `time node scripts/check-openwiki-okf.mjs`.
- [ ] T027 [US5] Retire V12 and the drift module.
  - Remove V12 and its self-test scenarios from `scripts/check-openwiki-okf.mjs`.
  - Delete `scripts/openwiki-drift.mjs` and `scripts/__tests__/openwiki-drift.test.mjs`.
  - Remove `--all-fresh` from `scripts/wiki-refresh.mjs`, its tests, and `contracts/wiki-refresh-cli.md`.
  - **Verify GREEN**: `node scripts/check-openwiki-okf.mjs --selftest`, `node scripts/check-openwiki-okf.mjs` and `node --test scripts/__tests__/wiki-refresh.test.mjs` all pass; `grep -rn "openwiki-drift" scripts .forgejo` finds nothing.

---

## Phase 8: Polish & cross-cutting

- [ ] T028 Rewrite `docs/runbooks/wiki-maintenance.md` and `openwiki/INSTRUCTIONS.md` for the new model. Covers FR-021.
  - **Runbook**:
    - a lead section on the session refresh duty (the "§refresh" anchor that the CLAUDE.md line links to);
    - V17/G14;
    - the manual `pages` dispatch;
    - what was retired, with a link to ADR-0004;
    - delete the sections on cooldowns, escalation, drift, the quiet-trigger, the run record and the 078 US7 schedule.
  - **`INSTRUCTIONS.md`**: in "Where a new learning goes", a derived page's learning goes into its source **and** the summary is refreshed in the same PR. Remove the Claims-citation rules (§9 lockfile/digest bans), which have no subject now.
  - Then re-run T023's refresh of `openwiki/runbooks/wiki-maintenance.md` (and of any page whose resource is `openwiki/INSTRUCTIONS.md`), and `--record` it.
  - **Done when**: `--stale` is empty and both gates exit 0.
- [ ] T029 [P] Mark the superseded specs. Covers FR-020.
  - `specs/078-wiki-generator-cost/spec.md`: US6, US7 and FR-024..FR-029 are superseded by 098.
  - `specs/082-wiki-drift-replanning/spec.md`: superseded.
  - `specs/044-openwiki-automation-migration/spec.md`: the automated maintenance FRs are superseded.
  - Each gets a one-paragraph header note with a link. No rewrites.
- [ ] T030 Run the tiers this diff touches (CLAUDE.md: run what the diff touches) and record the counts in `EVIDENCE.md`.
  - **Gates**: both gates, plain and `--selftest`.
  - **Wiki tests**: `node --test 'scripts/__tests__/wiki-*.test.mjs' 'scripts/__tests__/*openwiki*.test.mjs'`.
  - **Full scripts suite**: `node --test 'scripts/__tests__/*.test.mjs'`, to catch an importer of a deleted module.
  - **Lint/format**: in the worktree, run `CI=true pnpm install --frozen-lockfile` once, then `pnpm nx affected -t lint test --base=origin/main`.
  - **Expected**: 0 failures, and a skip count no higher than the T001 baseline.
- [ ] T031 Push the branch and open the PR.
  - Push with `git push origin HEAD:098-session-maintained-wiki`, then `POST /pulls` using the `git credential fill` token.
  - The PR body states the before/after spend, the 11 refreshed pages, and the retired files.
  - Run `node scripts/ci-status.mjs watch --pr <n> --required-only`.
  - **Done when**: the verdict is mergeable. The operator merges.
- [ ] T032 After merge, run `node scripts/check-openwiki-okf.mjs` on `main` and confirm exit 0.
  - Close backlog item #977 as superseded (the schedule it scores no longer exists) and item #739 as resolved (the page is canonical), each with a comment via `--body-file`.
  - File a 4-week follow-up item to score SC-001/SC-003/SC-004, replaying V17 across first-parent merges since the switch-over.

---

## Dependencies & execution order

```
T001 → T002 → T003 ─┬─▶ T004 → T005 (US1)
                    ├─▶ T006 → T007 (US2) ─▶ T008, T009
                    └─▶ T010 → T011, T012 → T013 → T014 → T015 → T016 → T017 (US3)
T011 (mayWrite) ─▶ T018/T019 → T020 → T021 (US4)
T005 + T007 + T015 + T016 ─▶ T022, T023, T024 → T025 → T026 → T027 (US5)
T020/T021 + T027 ─▶ T028 → T029 → T030 → T031 → T032
```

- **US1 and US2** share the foundational module only, and can proceed in parallel after T003.
- **US3's governance work** (T010–T011) is independent of US1/US2.
- **US4 needs** `mayWrite` (T011) and `recordSourceFingerprint` (T003).
- **US5 is last among the stories:** it needs the check, the tool, the canonical pages and the retirement done.

## Parallel opportunities

- After T003: T004, T006, T010 and T012 are separate files, so they can run in parallel.
- In US3: T017 (ADR) runs alongside T014–T016.
- In US4: T018 and T019 can run in parallel.
- In US5: T023 and T024 can run in parallel once T022 is done.
- In Polish: T029 runs alongside T028.

## Implementation strategy

- **MVP**: US1 + US2 + US5, which together deliver the blocking guarantee. US5 is required with US1, because V17 cannot merge against a stale tree.
- **US3** goes in the same PR, because V16 forbids the very edits US2 makes.
- **US4** is the smallest-value story, but it deletes the largest amount of code. It goes last before the cut-over so that the deletions are reviewed with the rebuild path that replaces them.
- **Total: 32 tasks.** Setup 1 · Foundational 2 · US1 2 · US2 4 · US3 8 · US4 4 · US5 6 · Polish 5.
