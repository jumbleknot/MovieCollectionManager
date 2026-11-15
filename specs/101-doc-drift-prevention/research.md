# Research: Doc-Drift Prevention

Most design questions were settled in the proposal (§4, verified 2026-11-14). The items below are
the remaining decisions, each re-verified on 2026-11-15 against the tree.

## R1. Where the sweep lives: project override

- **Decision**: `.specify/templates/overrides/tasks-template.md`, a full copy of the core template.
- **Rationale**: `Resolve-Template` (`.specify/scripts/powershell/common.ps1:251`) returns
  `overrides/<name>.md` first (lines 259-261), before presets, extensions and core.
  `setup-tasks.ps1:46` resolves `tasks-template` through it and emits `TASKS_TEMPLATE`, which the
  `speckit-tasks` skill reads (SKILL.md step 4). Neither manifest lists `overrides/`, so an upgrade
  does not rewrite it.
- **Alternatives**: editing core (overwritten silently on upgrade); editing the skill (same);
  a preset with `append` (the setup script uses path resolution, not content composition, so a
  preset is a full replace with more machinery; proposal §4.2 option C).

## R2. Where the sweep task sits in the template

- **Decision**: Two edits to the copy.
  1. A **Doc-impact sweep** task at the end of Phase 1 (Setup). It carries the proposal §3.1 text
     and an instruction to the generator: run the searches while generating `tasks.md`, record the
     terms and the result in the task, and emit one named doc task per hit.
  2. In the Polish phase, the generic `Documentation updates in docs/` line becomes "doc tasks from
     the sweep, one per hit, each naming its file", plus a **close-out re-search** task for the old
     identifiers (mirrors the checklist item).
- **Rationale**: Discovery has to happen *before tasks are final* (proposal G1). A Polish-phase line
  alone is found too late, after the doc tasks were already decided. The close-out search is G2.
- **Alternatives**: one Polish-phase task only (the proposal's literal wording, which loses G1's
  timing); a plan-template sweep (§7 Q1 answered no).

## R3. Fork-point format and the sweep marker

- **Decision**: First line
  `<!-- forked-from: .specify/templates/tasks-template.md sha256=<64 hex> spec-kit=<version> -->`.
  The guard reads `speckit_version` from `.specify/init-options.json` for `--record`. The sweep's
  presence is detected by the literal marker `**Doc-impact sweep**` in a task line (`- [ ]`).
- **Rationale**: This is the same fingerprint idea as V17's `resource-sha256`. An HTML comment is
  invisible when the template is rendered, and harmless if copied into a `tasks.md`.
- **Alternatives**: a sidecar JSON (two files to keep in step); hashing the override itself (it
  would not detect an upstream change, which is what needs detecting).

## R4. Static check that override-first resolution still holds

- **Decision**: Text checks on the scripts' source.
  (a) `setup-tasks.ps1` contains `Resolve-Template -TemplateName 'tasks-template'`.
  (b) In `common.ps1`, the body of `function Resolve-Template` exists, and its first `return`
  is guarded by an `overrides/` path test. In other words, the `overrides/` reference precedes every
  `presets`/`extensions` reference in that body.
- **Rationale**: Running PowerShell in CI is not needed (pwsh is in the dev container but not
  guaranteed on the runner). An upgrade that renames or reorders resolution must fail loudly. A
  false positive after a harmless refactor is acceptable: the fix is a reviewed edit to the guard,
  per the "update a guard at the cause" rule.
- **Alternatives**: executing `setup-tasks.ps1 -Json` (needs pwsh plus a feature dir, so it is
  fragile in CI). The scratch `/speckit-tasks` run in quickstart covers the behaviour end to end,
  once.

## R5. Showing the upstream diff on mismatch

- **Decision**: Walk `git log --format=%H -- .specify/templates/tasks-template.md`, hash each
  revision's blob (`git show <sha>:<path>`), take the first whose SHA-256 equals the recorded one,
  and print `git diff <sha> -- <core path>`. If no revision matches, or git or history is
  unavailable (shallow clone), print "fork base not found in history; compare by hand" and **still
  fail**.
- **Rationale**: FR-005. The failure must never depend on history being present.

## R6. Where the procedures live

- **Decision**: New `docs/runbooks/doc-drift.md` with two sections, "Upgrading Spec Kit" and "The
  quarterly drift audit", plus a derived page `openwiki/runbooks/doc-drift.md` and index entries.
- **Rationale**: The proposal allowed "wiki-maintenance.md or a sibling runbook". The subject differs
  (docs-from-code, not wiki-from-docs), and a concurrent branch is editing `wiki-maintenance.md`.
  `docs/runbooks/**` is already classified by `policy.yaml`, so G1 is satisfied. AGENTS.md claims
  every runbook has a concept citing it, so the derived page keeps that true.

## R7. Audit cadence (§7 Q2)

- **Decision**: The procedure's final step files the next audit item (`type/chore`, `priority/p2`)
  with a target date about 3 months on, using `node scripts/backlog.mjs create`. This feature files
  the first one, for 2027-02.
- **Rationale**: The operator chose a chain over a scheduler. It needs no CI issue-write token.
