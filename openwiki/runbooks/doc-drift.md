---
type: Runbook
title: "Doc drift: the doc-impact sweep, Spec Kit upgrades, and the quarterly audit"
description: How the repository keeps its procedure documents in step with the code (the direction V17 does not cover) — the doc-impact sweep every SDD feature runs at task generation and close-out, carried by a project override of Spec Kit's tasks template; the fork guard that turns a Spec Kit upgrade's silent template change into a red guardrails check, its five failure codes and the --record-only fingerprint; the Copilot and /speckit-constitution gaps the override cannot reach; and the quarterly drift audit that measures the result and files its own successor.
resource: docs/runbooks/doc-drift.md
resource-sha256: a5b8fe67c7010f50e89b64a56cdcce931a5deb08cc4e4a1cbc1d6991c33782bf
tags: [documentation, drift, spec-kit, sdd, audit, runbook]
timestamp: 2026-11-15T01:52:56.770Z
---

# Doc drift: the doc-impact sweep, Spec Kit upgrades, and the quarterly audit

**Feature 101** (item #1021). V17 keeps each wiki summary in step with its source document. This
runbook covers the other direction: keeping the source document in step with **the code it
describes**. The procedures are in `../../docs/runbooks/doc-drift.md`. The design and the 2026-11-14
baseline are in `../../docs/proposals/PRD-DocDriftPrevention.md`. For the wiki side, see
[OpenWiki knowledge-bundle maintenance](wiki-maintenance.md).

## Three layers, two of them live

1. **The doc-impact sweep** (live). Every SDD feature lists the identifiers it renames, removes or
   changes the meaning of, searches every doc stating current procedure for each one
   (`git grep -n -F` over `*.md`, excluding `specs/`, `docs/proposals/` and `docs/decisions/`), and
   turns each hit into a named doc task or a one-line justification. It does this when tasks are
   generated, and again at close-out for the old names. The measured weak point was
   **discovery**, not follow-through: features did 94% of the doc tasks they wrote.
2. **A mechanical per-PR check** (not built). It is triggered only if an audit finds drift that a
   `describes:` link would have caught on a feature whose sweep ran (SM-3).
3. **The quarterly drift audit** (live). See below.

## Where the sweep lives, and why it needs a guard

The sweep is a required task in `.specify/templates/overrides/tasks-template.md`, a project override
that Spec Kit's `Resolve-Template` checks before presets, extensions and core. The constitution
(v2.10.0, **Documentation**) requires it independently, and the final validation checklist carries
the close-out item.

**An override is a fork.** After a Spec Kit upgrade, `/speckit-tasks` would keep using the old copy
and never see upstream improvements, silently. `scripts/check-speckit-overrides.mjs` runs in
guardrails and fails with one of five codes:

- `core-changed`: the core template no longer matches the fork point on the override's first line.
  The failure prints the core diff since the fork base, found by hash in git history. It still fails
  when history is unavailable.
- `override-missing`, `header-invalid`, `sweep-missing`: the override is gone, its fork point is
  malformed, or no task line carries `**Doc-impact sweep**`.
- `resolution-broken`: `setup-tasks.ps1` no longer resolves `tasks-template` through
  `Resolve-Template`, or that function no longer checks `overrides/` first. The scripts are read as
  text and never run.

The fork point is written **only** by `--record`, never by hand. `--record` refuses an override that
has lost the sweep. **Upgrade procedure**: run the upgrade, read the printed core diff, merge it into
the override (keeping the sweep and close-out tasks), `--record`, and land all of it in one PR. A
`resolution-broken` failure means Spec Kit changed how templates resolve. Update the guard at the
cause; never delete it.

## Gotchas

- **The Copilot integration bypasses the override.** `.github/agents/speckit.tasks.agent.md` reads
  the core template directly. Only the constitution rule covers a Copilot-generated `tasks.md`, and
  the file is Spec Kit-owned, so it is not patched.
- **`/speckit-constitution` checks the core tasks template**, not the override. After a constitution
  amendment, check the override by hand.
- **The core template's sample-task comment says to delete every sample.** The override adds an
  explicit exception for the sweep and close-out tasks. Keep that note when re-merging an upgrade.

## The quarterly audit

One session reads `docs/runbooks/**`, `docs/MCM-Architecture.md` and the project READMEs against a
named commit, in chunks by area. It verifies only checkable claims (paths, commands, targets, flags,
env vars, names, ports, workflows, pins, links), makes the smallest true edit for each proven drift,
and lists what it cannot prove rather than editing it. ADRs, specs, proposals and dated records are
history and are never rewritten. Stale code comments go to one backlog item. Affected wiki pages are
refreshed in the same PR.

It records the drift rate per 1,000 lines in the runbook's audit log. The baseline is 2026-11-14:
76 drifts in ~16,800 lines, **4.5 per 1,000**. Its **last step files the next audit** as a dated
backlog item about three months on, so the cadence needs no scheduler. The next audit is item
#1027 (2027-02).
