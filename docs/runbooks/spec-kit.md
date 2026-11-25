# Spec Kit: this repository's customisations, and upgrading it

Spec-Driven Development (SDD) here runs on GitHub Spec Kit (the `specify` CLI and the
`/speckit-*` skills). This runbook is the **one list of every way the repository changes or adds
to Spec Kit**, and the procedure for upgrading Spec Kit without losing any of them.

- The SDD lifecycle itself (proposal → spec → plan → tasks → implementation, and its traps) is
  in [openwiki/process/spec-driven-development.md](../../openwiki/process/spec-driven-development.md).
- The rule that implementation needs a spec first is in [AGENTS.md](../../AGENTS.md) and the
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
| 1 | Every `tasks.md` carries a **Doc-impact sweep** task in Phase 1 and a **Close-out re-search** task in Polish (feature 101), and ends with an **Open the PR** task that is ticked before CI runs: CI evidence goes in the PR and backlog-item closing comments, never in `tasks.md`, so recording it costs no extra CI run | `.specify/templates/overrides/tasks-template.md` | Override (a fork of the core tasks template) | `Resolve-Template` / `Resolve-TemplateContent` in `common.ps1` check `overrides/` first | `override-missing`, `header-invalid`, `sweep-missing`, `core-changed`, `resolution-broken` |
| 2 | Tests are **required**, and every test task uses the **TDD checkpoint format**: scenarios covered, a **Verify RED** with the expected failure, and a paired implementation task with a **Verify GREEN** | Format and rules: `docs/templates/feature-test-tasks-template.md`. Mandated by the constitution ("Test-Driven Development", "TDD Checkpoint Format"). Shown in the User Story 1 sample of the override in row 1 | Override (in row 1's fork) plus the constitution | Same as row 1. The core template says tests are optional; the override replaces that | `tdd-format-missing` |
| 2a | The `/speckit-tasks` skill's own "Tests are OPTIONAL" rule is replaced with "Tests are REQUIRED" in the row 2 format. Without this edit the skill's instruction contradicts the override, and the agent reads both | `.claude/skills/speckit-tasks/SKILL.md` (Task Generation Rules) | Registered local edit to a Spec Kit-owned file | It is the skill itself | `local-edit-reverted`, `unregistered-edit`, `registry-stale` |
| 2b | The Copilot tasks agent builds `tasks.md` from the **override** in row 1, not the core template, and its "Tests are OPTIONAL" rule is replaced with row 2a's "Tests are REQUIRED" text, so a Copilot-generated `tasks.md` carries the sweep, the close-out re-search and the RED/GREEN pairs (item #1031) | `.github/agents/speckit.tasks.agent.md` (Outline step 4, Task Generation Rules) | Registered local edit to a Spec Kit-owned file. Copilot is **not** an installed integration (`.specify/integration.json` lists only `claude`): `copilot.manifest.json` is left over from Spec Kit 0.5.0, so no upgrade rewrites these files, and `specify integration upgrade copilot` answers `Integration 'copilot' is not installed` | It is the agent itself | `local-edit-reverted`, `unregistered-edit`, `registry-stale` |
| 2c | `/speckit-converge` appends its **Convergence** tasks in the row 2 format: a test + implementation pair with **Verify RED** / **Verify GREEN** for any code gap, "Done when" for docs/config, and a **Doc-impact sweep** task for a gap that renames, moves or removes an identifier. Upstream writes one-line tasks that never see the override (item #1054) | `.claude/skills/speckit-converge/SKILL.md` (step 7, the append contract) | Registered local edit to a Spec Kit-owned file | It is the skill itself | `local-edit-reverted`, `unregistered-edit`, `registry-stale` |
| 3 | `/speckit-taskstoissues` files tasks as **Forgejo backlog items** through `scripts/backlog.mjs`, with blocking edges and a milestone per feature, instead of GitHub issues through the GitHub MCP server (feature 049; dedupe step added from upstream 0.16.5). **Project-owned since 1.4.2**: upstream moved `taskstoissues` out of core into the optional `github` extension (`speckit.github.taskstoissues`), and the upgrade deleted our skill as a stale managed file. We kept our skill rather than adopting that extension: the skill's whole content is the Forgejo fan-out, the `github` extension targets GitHub issues, and overriding an extension command would be a second fork to track (item #1066) | `.claude/skills/speckit-taskstoissues/SKILL.md` | Project-owned (a former Spec Kit file, in the gate's `PROJECT_OWNED` list) | It is a skill in `.claude/skills/`. No manifest lists it, so no upgrade rewrites it | `project-file-lost`, `project-file-managed` |
| 4 | The governing principles every spec, plan and task list is checked against | `.specify/memory/constitution.md` | Project-owned | Every `/speckit-*` command reads it | none needed: upgrades do not touch it |
| 5 | Extension hooks: the `git` extension creates the feature branch before `/speckit-specify` and auto-commits around every command (`auto_execute_hooks: true`, so "optional" hooks still run); the `agent-context` extension rewrites the `<!-- SPECKIT START -->` … `<!-- SPECKIT END -->` region of `AGENTS.md` (the "read the current plan" pointer). `before_converge` / `after_converge` hooks were added with the rest (item #1054), so converge runs inside the same commit trail; like every event, they commit only when `.specify/extensions/git/git-config.yml` enables them (all off today). Reinstalling the `git` extension rewrites the hook list from its own manifest, which has no converge events, so these two are re-added by hand after every reinstall | `.specify/extensions.yml`, `.specify/extensions/*/` | Project-owned config | Spec Kit's hook runner | none needed |
| 6 | The CLI version the dev container and hosts install | `SPECKIT_VERSION` in `.devcontainer/toolchain.Dockerfile`; `speckit_version` in `.specify/init-options.json`; the install line in [dev-environment-setup.md](dev-environment-setup.md) | Pins | n/a | none: keep the three equal by hand in the upgrade PR. `SPECKIT_VERSION` is deliberately excluded from Renovate (`.forgejo/version-pin-exclusions.json`, item #1128), so this procedure is the only way it moves |

Rows 1, 2, 2a, 2b, 2c, 3 and 5 are the ones an upgrade can break. The gate checks that this table
names `.specify/templates/overrides/tasks-template.md`, `docs/templates/feature-test-tasks-template.md`,
every file in its `LOCAL_EDITS` registry and every file in its `PROJECT_OWNED` list
(`inventory-stale`). Row 5's converge hooks are not guarded, so check them by hand (step 1 below).

### Known gaps

- **`/speckit-constitution` checks the core tasks template**, not the override, when it checks
  dependent templates after an amendment. When amending the constitution, check the override too.
- **The Copilot files are frozen.** Copilot is not an installed integration here, so its agents and
  prompts under `.github/` are 0.5.0-era copies that no upgrade refreshes. Reinstalling an extension
  registers its commands for Claude only and deletes the Copilot copies. The 1.4.2 upgrade restored
  them from git and repointed `speckit.git.feature.agent.md` at the renamed
  `create-new-feature-branch` scripts. Installing the Copilot integration properly
  (`specify integration install copilot`) would refresh them, and overwrite row 2b.
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

   A file Spec Kit has stopped managing goes in `PROJECT_OWNED` instead. The gate checks that it
   still exists, still carries its marker, and is not listed in a manifest again.

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
   It also **deletes** any file a previous manifest listed that the new one does not. Bump the three
   version pins in row 6 to the same release.

   Then bring the bundled extensions up to the release: `specify extension add git --force` and
   `specify extension add agent-context --force`. (`specify extension update` refuses whenever the
   catalog has a newer version than the CLI ships, which is the usual case.) The reinstall keeps
   `git-config.yml`, but rewrites `.specify/extensions.yml` and deletes the Copilot copies of the
   extension commands. After it:
   - re-add the `before_converge` / `after_converge` hooks of row 5 (compare with
     `git diff HEAD -- .specify/extensions.yml`);
   - restore the deleted Copilot files with `git checkout HEAD -- .github/agents .github/prompts`,
     then fix any script path in them that the new extension renamed.
2. **Run the gate**: `node scripts/check-speckit-overrides.mjs`. Expect:
   - `local-edit-reverted` for each row 2a, 2b or 2c file the upgrade overwrote. Re-apply the edit from git
     (`git diff HEAD -- <file>` shows what was lost), merging in anything upstream added. In the
     0.11.2 → 0.16.5 upgrade that meant keeping the `backlog.mjs` fan-out and adopting upstream's
     new dedupe step. In 0.16.5 → 1.4.2 it meant adopting upstream's "report an unreadable
     `extensions.yml`" text in both skills, the `Entity.field` citations in `/speckit-tasks`, and
     `-RequireSpec` plus "re-assess every task" in `/speckit-converge`. Row 2a is one paragraph: put the "Tests are REQUIRED" text back in place of
     upstream's "Tests are OPTIONAL". Row 2b is the same paragraph plus the override path in
     Outline step 4. It is overwritten only if the Copilot integration is installed (see Known gaps). Row 2c is the
     "Convergence tasks follow the project's task format" block in step 7.
   - `core-changed` if the upgrade touched the core tasks template. The failure prints the core
     template's diff since the fork base, found by hash in git history. In a shallow clone it says
     history is unavailable and still fails; compare the two files by hand.

   - `project-file-lost` if the upgrade deleted a project-owned file (row 3). Restore it with
     `git checkout HEAD -- <file>`, then carry over any upstream wording worth keeping by hand.
   - `registry-stale` if Spec Kit stopped managing a `LOCAL_EDITS` file. Restore it as above and
     move its entry from `LOCAL_EDITS` to `PROJECT_OWNED`, as row 3 did in 1.4.2.

   You no longer need to hunt for local edits before `--force`: the gate compares every managed
   file against its manifest hash, accepting both LF and CRLF, so a Windows checkout's line endings
   are not counted as edits.
3. **Merge the upstream change into the override.** Keep the **Doc-impact sweep**,
   **Close-out re-search** and **Open the PR** tasks, the User Story 1 test pair with its **Verify RED** /
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
| `registry-stale` | A `LOCAL_EDITS` file is no longer listed in any manifest, so Spec Kit no longer manages it | To keep the file, move the entry to `PROJECT_OWNED` and update its row. If it is no longer needed, drop the entry and the row |
| `project-file-lost` | A `PROJECT_OWNED` file is missing or lost its marker. An upgrade deletes files that drop out of its manifest | Restore it from git history |
| `project-file-managed` | A `PROJECT_OWNED` file is listed in a manifest again, so the next `--force` upgrade overwrites it | Move the entry back to `LOCAL_EDITS`, or rename the project file so the paths no longer collide |
| `inventory-stale` | This runbook is missing, or does not name a guarded customisation | Add the row to the table above |
