---
type: Runbook
title: "Spec Kit: this repository's customisations, and upgrading it"
description: The one inventory of every way the repository changes or adds to GitHub Spec Kit — the tasks-template override carrying the doc-impact sweep, the required tests and the Verify RED / Verify GREEN checkpoint format it shows, the two registered local edits (the /speckit-tasks skill's "tests are required" rule, and /speckit-taskstoissues sending tasks to the Forgejo backlog), the constitution, the git and agent-context extension hooks, and the three CLI version pins — plus who owns which file, the order of preference for a new customisation, the guard that fails when any of them is lost or a Spec Kit-owned file is edited without being registered, its ten failure codes, the upgrade procedure, and the Copilot and /speckit-constitution gaps.
resource: docs/runbooks/spec-kit.md
resource-sha256: 3ba0463b841c127fd1c3a9da185663d1993eb9c5c9b1125996513261b7c06821
tags: [spec-kit, sdd, templates, guardrails, upgrade, runbook]
timestamp: 2026-11-15T17:56:25.721Z
---

# Spec Kit: this repository's customisations, and upgrading it

Spec-Driven Development runs on GitHub Spec Kit. The runbook (`../../docs/runbooks/spec-kit.md`) is
the **single list of every Spec Kit customisation** and the procedure for upgrading Spec Kit without
losing one. The lifecycle itself is in [the SDD process page](../process/spec-driven-development.md);
the doc-impact sweep's purpose and the quarterly audit are in [Doc drift](doc-drift.md).

## Who owns which file

Spec Kit owns every file in `.specify/integrations/*.manifest.json`: the `/speckit-*` skills, the
Copilot agents, the PowerShell scripts and the core templates. `specify integration upgrade --force`
rewrites them all without saying that a local edit is being lost. The project owns the rest of
`.specify/`: `overrides/`, the constitution, `extensions.yml`. So a change takes one of these forms, in
order of preference: a project-owned file Spec Kit reads (an override, the constitution, a hook); a
**registered** local edit to a Spec Kit-owned file, when nothing else can carry it; never an edit to
a core template.

## The customisations

1. **Tasks-template override** (`.specify/templates/overrides/tasks-template.md`, feature 101): a fork
   of the core template that adds the **Doc-impact sweep** and **Close-out re-search** tasks. It
   resolves first because `Resolve-Template` and `Resolve-TemplateContent` check `overrides/` first.
2. **Required tests in the TDD checkpoint format**: the same override replaces the core template's
   "tests are optional" with the constitution's rule. Its User Story 1 sample shows test tasks with a
   **Verify RED** (and expected failure) and a paired implementation task with a **Verify GREEN**. The
   full format and rules are in `docs/templates/feature-test-tasks-template.md`. Because the
   `/speckit-tasks` skill itself said "Tests are OPTIONAL", which the agent reads alongside the
   template, that line is also replaced with "Tests are REQUIRED" as a registered local edit.
3. **`/speckit-taskstoissues` → Forgejo** (`.claude/skills/speckit-taskstoissues/SKILL.md`, feature
   049): files tasks through `scripts/backlog.mjs` instead of GitHub issues, as the other registered
   local edit. The 0.11.2 → 0.16.5 upgrade overwrote it once.
4. **The constitution**, **the extension hooks** (the `git` extension's branch creation and
   auto-commits, which run even when marked optional; the `agent-context` extension's rewrite of
   CLAUDE.md's `SPECKIT` region) and **three CLI version pins** that must move together.

## The guard

`scripts/check-speckit-overrides.mjs` runs in guardrails. Its failure codes:

- **Fork:** `core-changed` (the failure prints the upstream diff since the fork base),
  `override-missing`, `header-invalid`, `sweep-missing`, `tdd-format-missing`, and
  `resolution-broken`, which means Spec Kit changed how templates resolve. Update the guard at the
  cause; never delete it.
- **Managed files:** every managed file is compared against its manifest hash, LF or CRLF. An
  unregistered difference fails `unregistered-edit`. A registered edit that matches upstream again,
  or that lost its marker string, fails `local-edit-reverted`. A registered file no manifest lists
  fails `registry-stale`.
- **Inventory:** `inventory-stale` fails if the runbook does not name the override, the TDD
  template and every registered edit, so the list cannot fall behind the guard.

The fork point on the override's line 1 is written only by `--record`, which refuses an override
that lost the sweep or the TDD sample.

**Upgrade procedure**, in one PR from a worktree: install the new CLI, run
`specify integration upgrade claude --force`, bump the three pins, run the gate, re-apply each
`local-edit-reverted` file from git (merging what upstream added), merge any `core-changed` diff into
the override, `--record`, then re-run the gate and its tests. The managed-file comparison replaces
the old manual hunt for local edits before `--force`.

## Gotchas

- **Copilot bypasses the override.** `.github/agents/speckit.tasks.agent.md` reads the core template
  directly, so only the constitution's rules cover a Copilot-generated `tasks.md`. Closing that would
  make the agent a registered local edit (backlog item #1031).
- **`/speckit-constitution` checks the core tasks template**, not the override. After an amendment,
  check the override by hand.
- **The core template says to delete every sample task.** The override's `EXCEPTION` note keeps the
  sweep, the close-out task and the RED/GREEN fields. Keep that note when re-merging an upgrade.
- **Adding an edit to a Spec Kit-owned file is a two-part change**: a `LOCAL_EDITS` entry in the gate
  (with a marker upstream lacks) and a row in the runbook's table, in the same PR.
