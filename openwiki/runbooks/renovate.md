---
type: Runbook
title: Renovate dependency bot
description: Operating the Renovate dependency bot — the three channels and their cadences, the Friday-only window that the nightly cron is NOT, the budget that binds before the schedule, and the silent failure modes that produce absence instead of errors.
resource: docs/runbooks/renovate.md
tags: [renovate, ci, dependencies, runbook]
timestamp: 2026-08-28T00:00:00+00:00
---

# Renovate dependency bot

Renovate opens dependency-update PRs on a defined schedule and budget. The configuration rationale —
grouping, version locks, cooldowns — lives in `renovate.json` (heavily commented). This page covers
the operating side: the schedule, how to force a run, reading the dashboard, and the failure modes
that produce absence instead of errors.

## Three channels

| channel | trigger | schedule |
| --- | --- | --- |
| **security** — `vulnerabilityAlerts` + OSV | nightly cron `0 3 * * *` | schedule-exempt, unbudgeted |
| **lockfile refresh** — `lockFileMaintenance` | the window run | Friday, ranked ahead of routine work (`prPriority: 5`) |
| **routine** — grouped package rules | the window run | Friday only |

Nothing auto-merges. Every group carries `automerge: false`.

## Gotchas

- **The nightly cron is NOT the Friday window.** `.forgejo/workflows/renovate.yml` has two crons
  doing different jobs. The `0 3 * * *` cron runs nightly but is deliberately *outside*
  `renovate.json`'s permitted window — only schedule-exempt work (security PRs) lands there. The `0
  7 * * 5` cron is Friday 07:00 UTC, inside the `* 2-4 * * 5` window. "It will sort itself out
  tonight" is false for anything except a security PR or an explicit dashboard request.
- **The budget binds before the schedule.** `prHourlyLimit: 4` — measured 2026-08-28: the window run
  created exactly 4 PRs and deferred everything else a week. `handleConcurrentLimits()` also blocks
  **branch** creation on the same budget, not just PR creation. Leaving four green Renovate PRs
  unmerged caps the next window at one new PR. **Merging promptly is a throughput lever.**
- **`dryRun` defaults to `true` and must be set explicitly when forcing a run.** The default
  prevents accidents; the cost is that a forced dry run looks exactly like a forced live run —
  nothing moves, no error. Run 5963 (2026-08-14) was recorded as "the schedule beats a dashboard
  unlimit tick" when it had simply been a dry run.
- **You cannot read a run's mode — verify it empirically.** The step name renders the raw
  uninterpolated `${{ … }}` expression; `/actions/runs/{id}/jobs` returns 404; there is no log
  endpoint. The signal that works: `git ls-remote origin 'refs/heads/renovate/*'` before and after,
  plus checking whether ticks reverted to `- [ ]`. Heads moved AND ticks consumed ⇒ it ran live.
- **Never hand-close a Renovate PR.** Closing one marks that update rejected — Renovate stops
  proposing it until a human ticks the dashboard to revive it. Closing `js-patchminor` silently
  blocks every JS patch/minor update.
- **Never hand-push to a Renovate branch.** Renovate detects the branch was modified and can stop
  managing it. Use `rebase-branch=` + a dispatch instead.
- **A channel whose toolchain is missing dies silently.** If a lockfile manager's binary is not on
  PATH, `execa` rejects and Renovate suppresses it to a single "WARN: execa promise rejection
  suppressed" line under Repository Problems — no PR, no error, nothing to notice. The pep621
  channel created nothing for weeks until `uv` was added to `renovate.yml` (item #218). A new
  manager needs a new toolchain step.
- **The release-age cooldown does not cover transitives.** `minimumReleaseAge: 3 days` gates the
  package Renovate proposes. It does nothing about what a lockfile regeneration drags in. pnpm 11
  independently verifies the lockfile against supply-chain policies on install. Measured on PR #263:
  a compliant `@ag-ui/client` bump resolved `zod@4.5.1` (published 1.7 hours earlier) and reddened
  six required contexts at `pnpm install` — none of them about the change. **Handling: wait.** The
  transitive ages past the ~24 h cutoff and a re-run passes. Do NOT add it to
  `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` — that list is for security-floor exceptions,
  not impatience. See [CI self-serve diagnostics](ci-diagnostics.md) for the board shape this
  produces.
- **Extraction is not grouping.** A `customManagers` entry makes Renovate *see* a second copy of a
  version. It does not make both copies move in one PR — a later broad rule can claim one half and
  strand the other. Every extracted pair needs a `packageRule` matching both managers, ordered after
  the broad rules. This has been paid for three times: nx (PRs #141 and #193), the Playwright image
  tag (#204), and the pnpm/Dockerfile pins (#225). `renovate-workflow.guard.test.mjs` asserts the
  *resolved* group for each pair.
- **`@copilotkit/*` ships breaking API changes in minor bumps.** It is grouped separately behind
  `dependencyDashboardApproval`, like the `cargo 0.x` rule. One breaking member makes a whole
  batched PR unmergeable and unsplittable — and Renovate regenerates it weekly, so routine bumps
  riding with it stay blocked for as long as the migration takes.
- **Re-read the dashboard before ticking — section and checkbox names change between runs.** The
  same update moved from `unlimit-branch=` under Rate-Limited to `unschedule-branch=` under
  Awaiting Schedule to `other-branch=` under Other Branches across three runs on one day. Ticking a
  name from memory writes a box Renovate does not read.

## Dashboard checkbox reference (item #29)

Renovate rewrites the dashboard body on a schedule. Never edit its prose, retitle it, relabel it, or
close it — ticking a checkbox is the one sanctioned interaction.

| section | checkbox | what ticking does |
| --- | --- | --- |
| Pending Approval | `approve-branch=` | **required** — `dependencyDashboardApproval` groups are never proposed otherwise |
| Awaiting Schedule | `unschedule-branch=` | creates it on the next run, ignoring the Friday window |
| Rate-Limited | `unlimit-branch=` | creates it despite the PR budget |
| Pending Status Checks | `approvePr-branch=` | opens the PR now, skipping the `minimumReleaseAge` cooldown |
| Open | `rebase-branch=` | rebases/regenerates that branch on the next run — not schedule-gated |
| Other Branches | `other-branch=` | forces a PR for a branch that has none |
| Repository Problems | — | **read this** — Renovate reporting its own errors; the toolchain-missing warning appears here |

A tick is a one-character edit. Read the body immediately before writing, assert the target checkbox
appears exactly once and is untenanted, and assert the resulting body differs by exactly the number
of characters you intended.
