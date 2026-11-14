# PRD — Documentation Drift Prevention

**Status**: Draft for review · **Date**: 2026-11-14 · **Author**: Steven Watson (with Claude Code)
**Input to**: a numbered spec (`specs/NNN-doc-drift-prevention/`) for layers 1 and 2. Layer 3
needs no spec. **Relates to**: ADR-0004 (session-maintained wiki), item #588 / PR #590 (the first
drift audit), the [wiki-maintenance runbook](../runbooks/wiki-maintenance.md).

---

## 1. Problem statement

Since feature 098 (ADR-0004), CI keeps each `openwiki/` summary in step with its **source
document**. V17 fails a PR whose summary no longer matches the source's fingerprint. Nothing keeps
the source document in step with **the system it describes**. If a PR changes the compose stacks
and leaves `docs/runbooks/local-dev.md` alone, every check stays green and the runbook is silently
wrong. The wiki then summarises the wrong runbook faithfully.

What keeps docs current today is prose: the constitution's "relevant documentation must be updated
as part of the implementation process", a generic `Documentation updates in docs/` line in the
tasks template, and review.

### What the record shows (measured 2026-11-14)

We mapped each `specs/NNN-*/tasks.md` to the first-parent commits that landed it, and checked
whether each feature edited the docs its own tasks named. 83 of 98 features could be mapped.

| Measure | Result |
|---|---|
| Mapped features that changed code | 80 |
| …with explicit documentation tasks | 66 |
| Documentation tasks checked off | 269 of 285 (94%) |
| Tasks left as the template's generic placeholder | 0 |
| Code-changing features that touched no doc | 12, none a real gap on inspection |

**Following through on doc tasks is not the weak point.** Doc tasks are specific, name files, and
get done. Two checked-off tasks were not done:

- **020 T030** named seven docs to move to the new stack layout. `agents/movie-assistant/README.md`
  was never edited. Its OpenSearch setup still created the pre-071 volume and ran
  `docker compose --profile audit up -d` against the retired root aggregator, and it named a CI
  workflow (`.github/workflows/agent-gates.yml`) that had become a job in `guardrails.yml`. It was
  wrong for five months and fixed by this proposal's PR.
- **073 T071** named `openwiki/projects/bff.md`, which was not updated.

**The weak point is discovery.** A feature updates the docs it *thinks of* while planning. A
change to the compose stacks does not lead anyone to the agent README that also describes them.
PR #590 (2026-09-27) rewrote **340 lines across 15 canonical docs**, including 116 lines of
`android-emulator.md`. That drift built up while every feature was ticking its own doc tasks. §8
records this proposal's own audit of the current tree.

## 2. Goals and non-goals

**Goals**

- G1: When a feature renames, removes or changes the meaning of something a doc refers to, the
  feature finds every doc that refers to it, by search, before tasks are final.
- G2: Before a feature is called done, it shows that the old names no longer appear in docs that
  state current procedure.
- G3: The process change survives a Spec Kit upgrade (§4).
- G4: Drift that slips through is found periodically, and the amount found is the measure of
  whether G1 and G2 work.

**Non-goals**

- Any LLM call in CI. The API key is scoped to the movie assistant and OpenWiki (CLAUDE.md), and
  a bot PR has no session to act on a finding.
- Rewriting history. Dated incident records and "measured on …" tables describe the past and
  stay as written.
- Changing ADRs, `specs/` or `docs/proposals/`. These are records, not current procedure.

## 3. The three layers

| Layer | When | Cost | Catches |
|---|---|---|---|
| 1. Doc-impact sweep | every SDD feature: at `/speckit-tasks`, and again at close-out | a few greps, in the session, on the subscription | docs that reference what the feature changes, including ones nobody thought of |
| 2. Mechanical doc-impact check | every PR, in CI | deterministic, no model | a change to a file a doc declares it describes, with no doc touched and no declared "no doc impact" |
| 3. Drift audit | quarterly, and after a large infrastructure feature | one session reading the canonical docs | slow or semantic drift that layers 1 and 2 cannot see |

### 3.1 Layer 1 — the doc-impact sweep

**At task generation.** The tasks template replaces its generic line with a required task:

> **Doc-impact sweep.** List the identifiers this feature renames, removes or changes the meaning
> of: file and directory paths, nx `project:target` names, script names and flags, environment
> variables, compose service, container, volume, network, stack and profile names, ports, workflow
> and job names, and user-visible labels. Search every `*.md` outside `specs/`, `docs/proposals/`
> and `docs/decisions/` for each one. Every hit becomes a named doc task, or a one-line note
> saying why it needs no change. Record the terms and the result in this task.

**At close-out.** The final validation checklist
([openwiki/invariants/feature-validation-checklist.md](../../openwiki/invariants/feature-validation-checklist.md),
canonical) gains one item: re-run the sweep's searches for the **old** identifiers. Any remaining
hit in a doc that states current procedure is either fixed or justified in `tasks.md`.

The search is literal and cheap on purpose. 020's miss would have been one grep for
`--profile audit` or `agent-audit-opensearch-data`.

### 3.2 Layer 2 — a mechanical per-PR check (sketch; needs its own spec)

Each runbook declares the files it describes in front matter, for example
`describes: [infrastructure-as-code/docker/stacks/*.compose.yaml, scripts/gen-dev-env.mjs]`. A
guardrail fails a PR that changes a declared file without touching the doc and without a
`Doc-impact: none — <reason>` trailer in the PR body or a commit message.

Constraints the spec has to resolve:

- **G14's trap, inverted.** Renovate and CD rewrite lockfiles, Dockerfiles, compose files and
  `.forgejo/workflows/**`. If those can be declared, every bot PR fails with no session there to
  act. Bot-rewritten paths must be refused as `describes:` entries, using the same list G14 reads,
  or bot PRs exempted by author.
- **Granularity.** A whole-file trigger on `devcontainer.md` (1,391 lines) fires on nearly every
  change. Declarations should be narrow, and the check reports which doc to look at rather than
  requiring a particular edit.
- **Whether it pays.** Build it only if layer 3 keeps finding drift that a `describes:` link
  would have caught (§6).

### 3.3 Layer 3 — the periodic drift audit

The audit is a session that reads every doc stating current procedure (`docs/runbooks/**`,
`docs/MCM-Architecture.md`, project READMEs) against the current tree. It verifies the checkable
claims (paths, commands, targets, flags, env vars, names, ports, workflow and job names, links),
makes the smallest edit that makes a proven-wrong statement true, and lists suspected drift it
cannot prove. It refreshes the wiki pages whose sources it changed, in the same PR. It is filed as
a recurring backlog item. The first instance is this proposal's PR (§8). The procedure belongs in
`docs/runbooks/wiki-maintenance.md` or a sibling runbook once ratified.

## 4. Surviving a Spec Kit upgrade

### 4.1 What an upgrade does to this repository

- Spec Kit is at **0.11.2** (`.specify/init-options.json`). The last upgrade (commit `7d4e7a93`,
  2026-05-18) rewrote `.specify/scripts/**`, the `.claude/skills/speckit-*` skills, the
  extensions and the core templates. Both `tasks-template.md` and `plan-template.md` were last
  changed by that commit.
- Spec Kit records the files it owns, with SHA-256 hashes, in
  `.specify/integrations/speckit.manifest.json` (scripts and the five core templates) and
  `.specify/integrations/claude.manifest.json` (the skills). `tasks-template.md` currently matches
  its manifest hash (`fc29a233…`), so it carries **no local edits** today.
- Not listed in either manifest, so project-owned: `.specify/templates/overrides/`,
  `.specify/memory/constitution.md`, `docs/templates/`, `openwiki/`.
- Unverified: whether a future `specify` upgrade uses the manifest to skip or warn on locally
  modified files. This design does not depend on it.

**So editing `.specify/templates/tasks-template.md` directly is rejected.** The next upgrade
replaces it with nothing to say the change was lost. Editing the `speckit-tasks` skill is rejected
for the same reason.

### 4.2 Where the change goes

Spec Kit 0.11.2 resolves templates in a fixed order (`Resolve-Template` in
`.specify/scripts/powershell/common.ps1`): **project overrides → presets → extensions → core**.
`setup-tasks.ps1` resolves `tasks-template` through it and hands the path to the `speckit-tasks`
skill as `TASKS_TEMPLATE`. Verified 2026-11-14 against a scratch copy of the scripts: with
`.specify/templates/overrides/tasks-template.md` present, it resolves to the override.

| Option | Survives upgrade | Cost | Verdict |
|---|---|---|---|
| A. Edit the core template | **no**, silently overwritten | none | rejected |
| B. Project override `.specify/templates/overrides/tasks-template.md` | yes, project-owned and first in resolution | a full copy, which **shadows** upstream improvements to the core template (below) | **adopt**, with the fork guard |
| C. A local preset (`.specify/presets/mcm/`) with an `append` strategy | yes | more machinery. `setup-tasks.ps1` uses path resolution (`Resolve-Template`), not `Resolve-TemplateContent`, so in 0.11.2 the composition strategies **do not apply** to tasks generation and a preset is a full replace like B | not now; revisit if several templates get customised or `setup-tasks` adopts composition |
| D. The rule in the constitution and the validation checklist | yes, both project-owned | prose only: an obligation, not structure | **adopt alongside B**, as the precedent the TDD checkpoint format set (`docs/templates/feature-test-tasks-template.md`, mandated by the constitution) |

**The shadowing risk, and its guard.** An override is a fork. After an upgrade, `/speckit-tasks`
keeps using the old structure, and any upstream improvement to the core template never reaches
this repository, silently. That is the same failure as option A in reverse. The guard uses the
fingerprint pattern V17 already applies to wiki pages:

1. The override's first line records its fork base:
   `<!-- forked-from: .specify/templates/tasks-template.md sha256=<hash> spec-kit=0.11.2 -->`.
2. A guardrail test, in `node --test scripts/__tests__/`, which guardrails already runs, fails when:
   - the core template's hash differs from `forked-from`. Spec Kit changed it, so re-merge the
     upstream change into the override and re-record. The failure names both files and prints the
     core diff since the fork base, from git history;
   - the override is missing, or no longer contains the doc-impact sweep task;
   - `setup-tasks.ps1` no longer resolves `tasks-template` through `Resolve-Template`, or
     `Resolve-Template` no longer checks `overrides/` first. A static check on the scripts'
     source: an upgrade that drops override support must fail loudly, not quietly fall back to core.
3. The hash is only ever written by a small `--record` helper. Never hand-typed (the V17 rule).

The override also covers the case where `TASKS_TEMPLATE` comes back empty and the skill falls back
to the core path: the constitution rule (D) still requires the sweep, and `/speckit-analyze`
treats constitution conflicts as CRITICAL.

**What a Spec Kit upgrade then looks like.** Run the upgrade. The guard fails and names
`tasks-template.md`. Read the core diff, merge what is worth keeping into the override, and run
`--record`. The upgrade PR carries all three. The upgrade procedure, which no runbook covers today,
gets a short section stating this.

## 5. Changes, by layer

| Layer | Change | Files |
|---|---|---|
| 1 | Override with the sweep task in place of the generic doc line, plus the `forked-from` header | `.specify/templates/overrides/tasks-template.md` (new) |
| 1 | Fork guard and `--record` helper | `scripts/check-speckit-overrides.mjs` (new), `scripts/__tests__/` |
| 1 | Constitution sentence: a feature runs the doc-impact sweep, and its results are recorded in `tasks.md` | `.specify/memory/constitution.md` (version bump) |
| 1 | Close-out item: re-search the old identifiers | `openwiki/invariants/feature-validation-checklist.md` |
| 1 | Spec Kit upgrade procedure | a runbook section |
| 2 | `describes:` front matter, guardrail, bot-path refusal | its own spec, gated on §6 |
| 3 | Recurring audit backlog item; procedure written into a runbook | backlog, runbook |

Layer 1 touches `scripts/`, so it goes through spec → plan → tasks first.

## 6. Success measures

- **SM-1:** every feature opened after ratification has a doc-impact sweep task with recorded
  search terms and results (sampled from `tasks.md`).
- **SM-2:** each quarterly audit finds fewer proven drift items per 1,000 doc lines than the one
  before. §8 is the baseline.
- **SM-3, the trigger for layer 2:** if an audit finds drift that a `describes:` link would have
  caught, and a layer-1 sweep ran on the feature that caused it, layer 1 is not enough. Specify
  layer 2.
- **SM-4:** a Spec Kit upgrade never lands without the fork guard firing and being resolved. The
  next upgrade is the test.

## 7. Open questions

1. Should the sweep also be added to the plan template, where identifier changes are first
   designed? It is cheaper to find a dependent doc before tasks exist. That means a second
   override, the same pattern and the same guard.
2. Who owns the quarterly cadence? A recurring backlog item needs someone to re-file it, or a
   scheduled reminder.
3. Should README files under `agents/`, `mcp-servers/` and `infrastructure-as-code/` become
   `resource`s of wiki pages, so V17 covers them? Today a README has no summary and no fingerprint.

## 8. Baseline: the 2026-11-14 drift audit

This is the first layer-3 run, done in the PR that adds this proposal. It covered every runbook,
`docs/MCM-Architecture.md` and the project READMEs: about 16,800 lines, read in four chunks
against the tree at `e5cda61b`. Only checkable claims were edited, each against code evidence.
Dated records were left as history. Anything about the live host, the forge or upstream tools that
the repo cannot prove was reported rather than edited.

| Chunk | Docs | Lines | Proven drift fixed |
|---|---|---|---|
| Dev/test runbooks, architecture, READMEs | 7 runbooks + 15 READMEs | ~4,600 | 44 (41 + the movie-assistant README's 3) |
| Dev container and CI diagnostics | 4 | ~4,300 | 9 |
| Renovate, wiki maintenance, CI evidence, scanning | 6 | ~4,000 | 12 |
| Production and homelab | 6 | ~3,700 | 11 |
| **Total** | **21 changed** | **~16,800** | **76, about 4.5 per 1,000 lines** |

The 18 derived wiki pages over those sources were refreshed in the same PR: 9 needed body edits and
9 were fingerprint-only.

**Where the drift came from.** Three patterns account for nearly all of it.

1. **Renames that left prose behind.** The pre-020 container names (`mc-db`, `mcm-bff-db`,
   `mc-service-db`), `docker compose` calls aimed at the retired root aggregator, and the pre-071
   OpenSearch volume. Layer 1's sweep is aimed at exactly this; one grep per old name would have
   found each one.
2. **Version and toolchain bumps.** Node 24 → 26, corepack removed, Playwright 1.63 → 1.65, openwiki
   0.7.1 → 0.9.0, Trivy 0.76.1 → 0.76.2, Rust 1.98 → 1.99. Several came from a merge on the day of
   the audit. Most of these bumps are Renovate PRs, where no session exists to run a sweep, so
   layer 1 does not reach them. That is the strongest case for layer 2, or for citing the pin file
   instead of restating the version.
3. **Behaviour changes the docs never followed.** Feature 087's cold-load bundle budget, spec 097's
   `eslint .`, the per-user TMDB key, the un-ignored mc-service HTTP tests, CI's `low`
   reasoning-effort fallback, and from-scratch rebuild steps that later features never revisited
   (Phase 5.5 networks, the host compose templates, the rebuild secrets list).

**Left as suspected, needing a person or a live check:** the `5433` host port in `local-dev.md`;
the logical names `mc-db` and `mcm-bff-db` that `MCM-Architecture.md` still uses in headings and
diagrams (keep them as logical names, or switch to the container names?); whether pnpm 12 keeps the
lockfile supply-chain verification `renovate.md` attributes to pnpm 11; whether running from the
repo root still matters for `--dir` now that corepack is gone (`wiki-maintenance.md`,
`sast-scanning.md`); and openwiki behaviours recorded for 0.6/0.7.1 that have not been re-checked
on 0.9.0.

**Drift found in code comments, outside this audit's scope:** the web-api-mcp compose comment on
the TMDB key; `.devcontainer/devcontainer.json:186,257`; `.devcontainer/toolchain.Dockerfile:16`;
`scripts/sast-scan.mjs:462-464`; `.forgejo/workflows/renovate.yml:92`.
