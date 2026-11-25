---
type: Runbook
title: "Doc drift: the doc-impact sweep and the quarterly audit"
description: How the repository keeps its procedure documents in step with the code (the direction V17 does not cover) — the doc-impact sweep every SDD feature runs at task generation and close-out, carried by a project override of Spec Kit's tasks template (whose guard and upgrade procedure live on the Spec Kit page); the three layers and which are live; and the quarterly drift audit that measures the result and files its own successor.
resource: docs/runbooks/doc-drift.md
resource-sha256: e7ad99fc74fae776346cfc898ed30ed873bf472b201611ca0965ccbeb27a06a0
tags: [documentation, drift, spec-kit, sdd, audit, runbook]
timestamp: 2026-11-25T01:11:35.909Z
---

# Doc drift: the doc-impact sweep and the quarterly audit

**Feature 101** (item #1021). V17 keeps each wiki summary in step with its source document. This
runbook covers the other direction: keeping the source document in step with **the code it
describes**. The procedures are in `../../docs/runbooks/doc-drift.md`. The design and the 2026-11-14
baseline are in `../../docs/proposals/PRD-DocDriftPrevention.md`. For the wiki side, see
[OpenWiki knowledge-bundle maintenance](wiki-maintenance.md).

## Three layers, two of them live

1. **The doc-impact sweep** (live). Every SDD feature lists the identifiers it renames, removes or
   changes the meaning of, searches every doc stating current procedure for each one
   (`git grep --untracked -n -F` over `*.md` — `--untracked` so a sweep run before the feature's
   first commit still searches the documents it just created — excluding `specs/`, `docs/proposals/` and `docs/decisions/`), and
   turns each hit into a named doc task or a one-line justification. It does this when tasks are
   generated, and again at close-out for the old names. The measured weak point was
   **discovery**, not follow-through: features did 94% of the doc tasks they wrote.
2. **A mechanical per-PR check** (not built). It is triggered only if an audit finds drift that a
   `describes:` link would have caught on a feature whose sweep ran (SM-3).
3. **The quarterly drift audit** (live). See below.

## Where the sweep lives

The sweep is a required task in `.specify/templates/overrides/tasks-template.md`, a project override
that Spec Kit resolves ahead of its core template. The constitution (v2.10.0, **Documentation**)
requires it independently, and the final validation checklist carries the close-out item.

The override is a fork, so an upgrade can leave it stale or stop resolving it. The guard that
catches that (`scripts/check-speckit-overrides.mjs`), its failure codes, the upgrade procedure and the
Copilot and `/speckit-constitution` gaps are on [the Spec Kit page](spec-kit.md), which lists every
Spec Kit customisation in one place.

## The quarterly audit

One session reads `docs/runbooks/**`, `docs/MCM-Architecture.md`, Part 1 of `docs/MCM-Learnings.md`
and the project READMEs against a named commit, in chunks by area. It verifies only checkable claims (paths, commands, targets, flags,
env vars, names, ports, workflows, pins, links), makes the smallest true edit for each proven drift,
and lists what it cannot prove rather than editing it. ADRs, specs, proposals and dated records are
history and are never rewritten. Stale code comments go to one backlog item. Affected wiki pages are
refreshed in the same PR, and so is `docs/MCM-Learnings.md`: a new measurement-log column written by
`node scripts/count-repo-metrics.mjs --append-log docs/MCM-Learnings.md` on `main` (version-stamped,
refusing a commit already logged or a shallow clone), never pasted by hand and never an edited old one.

It records the drift rate per 1,000 lines in the runbook's audit log. The baseline is 2026-11-14:
76 drifts in ~16,800 lines, **4.5 per 1,000**. Its **last step files the next audit** as a dated
backlog item about three months on, so the cadence needs no scheduler. The next audit is item
#1027 (2027-02).
