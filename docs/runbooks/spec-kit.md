# Spec Kit: this repository's customisations, and upgrading it

Spec-Driven Development (SDD) here runs on GitHub Spec Kit (the `specify` CLI and the
`/speckit-*` skills). This runbook is the **one list of every way the repository changes or adds
to Spec Kit**, and the procedure for upgrading Spec Kit without losing any of them.

- The SDD lifecycle itself (proposal → spec → plan → tasks → implementation, and its traps) is
  in [openwiki/process/spec-driven-development.md](../../openwiki/process/spec-driven-development.md).
- The rule that implementation needs a spec first is in [CLAUDE.md](../../CLAUDE.md) and the
  constitution.
- Installing the CLI is covered in [dev-environment-setup.md](dev-environment-setup.md).

`scripts/check-speckit-overrides.mjs`, a guardrails step, enforces this list: it fails if a
customisation below is lost, or if one of Spec Kit's own files is edited without being added here.

## Who owns which file

Spec Kit **owns** every file listed in `.specify/integrations/*.manifest.json`: the `/speckit-*`
skills under `.claude/skills/`, the Copilot agents under `.github/agents/`, the PowerShell scripts
under `.specify/scripts/powershell/`, and the core templates under `.specify/templates/`. An
upgrade (`specify integration upgrade <integration> --force`) rewrites each one with no warning
that a local edit is being lost.

The **project** owns everything else under `.specify/`: `overrides/`, `memory/constitution.md`,
`extensions.yml` and the extension configs. An upgrade leaves these alone.

So a change to Spec Kit's behaviour takes one of three forms, in order of preference:

1. **A project-owned file Spec Kit reads**: a template override, the constitution, or an extension
   hook. It survives every upgrade.
2. **A registered local edit to a Spec Kit-owned file**: used only when nothing Spec Kit reads can
   carry the change. The upgrade overwrites it, and the gate fails until it is put back.
3. **Never** an edit to a core template. Use an override instead.

## The customisations

| # | What it changes | Where it lives | Form | How Spec Kit picks it up | Guard (failure codes) |
| --- | --- | --- | --- | --- | --- |
| 1 | Every `tasks.md` carries a **Doc-impact sweep** task in Phase 1 and a **Close-out re-search** task in Polish (feature 101) | `.specify/templates/overrides/tasks-template.md` | Override (a fork of the core tasks template) | `Resolve-Template` / `Resolve-TemplateContent` in `common.ps1` check `overrides/` first | `override-missing`, `header-invalid`, `sweep-missing`, `core-changed`, `resolution-broken` |
| 2 | Tests are **required**, and every test task uses the **TDD checkpoint format**: scenarios covered, a **Verify RED** with the expected failure, and a paired implementation task with a **Verify GREEN** | Format and rules: `docs/templates/feature-test-tasks-template.md`. Mandated by the constitution ("Test-Driven Development", "TDD Checkpoint Format"). Shown in the User Story 1 sample of the override in row 1 | Override (in row 1's fork) plus the constitution | Same as row 1. The core template says tests are optional; the override replaces that | `tdd-format-missing` |
| 2a | The `/speckit-tasks` skill's own "Tests are OPTIONAL" rule is replaced with "Tests are REQUIRED" in the row 2 format. Without this edit the skill's instruction contradicts the override, and the agent reads both | `.claude/skills/speckit-tasks/SKILL.md` (Task Generation Rules) | Registered local edit to a Spec Kit-owned file | It is the skill itself | `local-edit-reverted`, `unregistered-edit`, `registry-stale` |
| 3 | `/speckit-taskstoissues` files tasks as **Forgejo backlog items** through `scripts/backlog.mjs`, with blocking edges and a milestone per feature, instead of GitHub issues through the GitHub MCP server (feature 049; dedupe step added from upstream 0.16.5) | `.claude/skills/speckit-taskstoissues/SKILL.md` | Registered local edit to a Spec Kit-owned file | It is the skill itself | `local-edit-reverted`, `unregistered-edit`, `registry-stale` |
| 4 | The governing principles every spec, plan and task list is checked against | `.specify/memory/constitution.md` | Project-owned | Every `/speckit-*` command reads it | none needed: upgrades do not touch it |
| 5 | Extension hooks: the `git` extension creates the feature branch before `/speckit-specify` and auto-commits around every command (`auto_execute_hooks: true`, so "optional" hooks still run); the `agent-context` extension rewrites the `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` region of `CLAUDE.md` (the "read the current plan" pointer) | `.specify/extensions.yml`, `.specify/extensions/*/` | Project-owned config | Spec Kit's hook runner | none needed |
| 6 | The CLI version the dev container and hosts install | `SPECKIT_VERSION` in `.devcontainer/toolchain.Dockerfile`; `speckit_version` in `.specify/init-options.json`; the install line in [dev-environment-setup.md](dev-environment-setup.md) | Pins | n/a | none: keep the three equal by hand in the upgrade PR |

Rows 1, 2, 2a and 3 are the ones an upgrade can break. The gate checks that this table names
`.specify/templates/overrides/tasks-template.md`, `docs/templates/feature-test-tasks-template.md`
and every file in its `LOCAL_EDITS` registry (`inventory-stale`).

### Known gaps

- **Copilot does not see rows 1 and 2.** The Copilot tasks agent
  (`.github/agents/speckit.tasks.agent.md`) reads the core template directly, not through
  `Resolve-Template`. A Copilot-generated `tasks.md` is covered only by the constitution's
  Documentation and TDD rules. Closing this would make that agent a registered local edit (row 3's
  form). It has not been done, because sessions here generate tasks through the Claude skills;
  tracked as backlog item #1031.
- **`/speckit-constitution` checks the core tasks template**, not the override, when it checks
  dependent templates after an amendment. When amending the constitution, check the override too.
- **The scripts are PowerShell only.** An environment without `pwsh` falls back to resolving the
  feature directory from `.specify/feature.json` by hand (see the SDD process page).

## Adding a customisation

1. **Prefer a project-owned file.** To change a template, copy it to
   `.specify/templates/overrides/<name>.md` and edit the copy. A new override is a new fork, and
   only the tasks template's fork is guarded today, so extend the gate in the same PR.
2. **If you must edit a Spec Kit-owned file**, make the edit, then in the same PR:
   - add an entry to `LOCAL_EDITS` in `scripts/check-speckit-overrides.mjs`, with a `marker` (a
     string the local version carries and upstream does not) and a `why`;
   - add a row to the table above.

   Until both are done the gate fails `unregistered-edit` or `inventory-stale`.
3. Run `node scripts/check-speckit-overrides.mjs` and
   `node --test scripts/__tests__/check-speckit-overrides.test.mjs`.

## Upgrading Spec Kit

The override in row 1 is a **fork** of the core tasks template. After an upgrade, the core template
may have improved while `/speckit-tasks` keeps using the old copy without saying so. The registered
local edits in row 3 are simply overwritten. The gate turns both into a red check. The override's
first line records the fork point:

```text
<!-- forked-from: .specify/templates/tasks-template.md sha256=<hash> spec-kit=<version> -->
```

The procedure, all in one PR, from a worktree:

1. **Run the upgrade.** Install the new CLI release as in
   [dev-environment-setup.md](dev-environment-setup.md), then run
   `specify integration upgrade claude --force`. It rewrites the files listed in
   `.specify/integrations/*.manifest.json`, but not `overrides/`, the constitution or `openwiki/`.
   Bump the three version pins in row 6 to the same release.
2. **Run the gate**: `node scripts/check-speckit-overrides.mjs`. Expect:
   - `local-edit-reverted` for each row-3 file the upgrade overwrote. Re-apply the edit from git
     (`git diff HEAD -- <file>` shows what was lost), merging in anything upstream added. In the
     0.11.2 → 0.16.5 upgrade that meant keeping the `backlog.mjs` fan-out and adopting upstream's
     new dedupe step. Row 2a is one paragraph: put the "Tests are REQUIRED" text back in place of
     upstream's "Tests are OPTIONAL".
   - `core-changed` if the upgrade touched the core tasks template. The failure prints the core
     template's diff since the fork base, found by hash in git history. In a shallow clone it says
     history is unavailable and still fails; compare the two files by hand.

   You no longer need to hunt for local edits before `--force`: the gate compares every managed
   file against its manifest hash, accepting both LF and CRLF, so a Windows checkout's line endings
   are not counted as edits.
3. **Merge the upstream change into the override.** Keep the **Doc-impact sweep** and
   **Close-out re-search** tasks, the User Story 1 test pair with its **Verify RED** /
   **Verify GREEN** fields and the pointer to `docs/templates/feature-test-tasks-template.md`, and
   the `EXCEPTION` note in the sample-task comment.
4. **Record**: `node scripts/check-speckit-overrides.mjs --record`. Never hand-type the hash. The
   gate refuses to record an override that has lost the sweep task or the TDD sample.
5. **Re-run the gate** (expect ✓) and its tests:
   `node --test scripts/__tests__/check-speckit-overrides.test.mjs`.
6. **Re-read the known gaps above.** An upgrade can close one, or open a new one.

### Failure codes

| Code | Meaning | Fix |
| --- | --- | --- |
| `core-changed` | The core tasks template no longer matches the override's fork point | Merge the change into the override, then `--record` |
| `override-missing` | The override file is gone | Restore it from git, then `--record` |
| `header-invalid` | Line 1 is not a fork point | `--record` rewrites it |
| `sweep-missing` | No task line carries `**Doc-impact sweep**` | Restore the task. `--record` refuses until you do |
| `tdd-format-missing` | The override lost `**Verify RED**`, `**Verify GREEN**` or its pointer to `docs/templates/feature-test-tasks-template.md` | Restore the User Story 1 test pair. `--record` refuses until you do |
| `resolution-broken` | `setup-tasks.ps1` no longer calls `Resolve-Template` (the path, `TASKS_TEMPLATE`) and `Resolve-TemplateContent` (the content, `TASKS_TEMPLATE_CONTENT`, which `/speckit-tasks` prefers since 0.16) for `tasks-template`, or either no longer checks `overrides/` first. A bare `return $null` before the check (template-name validation) is allowed | Spec Kit changed how it resolves templates. Re-evaluate where the override must live (a preset, or composition; proposal `PRD-DocDriftPrevention.md` §4.2), then update the guard at the cause. **Never delete the guard** to make it pass |
| `local-edit-reverted` | A registered local edit is gone: the file matches its upstream manifest hash again, or lost its marker | Re-apply the edit from git history |
| `unregistered-edit` | A Spec Kit-owned file differs from its manifest hash and is not in `LOCAL_EDITS` | Register it (see "Adding a customisation"), or restore the upstream file |
| `registry-stale` | A `LOCAL_EDITS` file is no longer listed in any manifest, so Spec Kit no longer manages it | Drop the entry from `LOCAL_EDITS` and its row from the table |
| `inventory-stale` | This runbook is missing, or does not name a guarded customisation | Add the row to the table above |
