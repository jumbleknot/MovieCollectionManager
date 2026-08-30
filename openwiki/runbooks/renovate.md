---
type: Runbook
title: Renovate dependency bot
description: Operating the Renovate dependency bot — the three channels and their cadences, the Friday-only window that the nightly cron is NOT, the budget that binds before the schedule, and the silent failure modes that produce absence instead of errors.
resource: docs/runbooks/renovate.md
tags: [renovate, ci, dependencies, runbook]
timestamp: 2026-08-30T17:08:17.796Z
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
- **A dispatched run now publishes its RESOLVED mode as a commit status — but the empirical check
  remains mandatory.** Item #268. Every introspective route is dead on this Forgejo build: the step
  name renders the raw uninterpolated `${{ … }}` expression; `/actions/runs/{id}/jobs` returns 404;
  there is no log endpoint. The run now posts a `renovate/mode` commit status on the dispatched SHA
  *before* Renovate runs (`"LIVE"` or `"DRY RUN (creates nothing)"`), built from proven parts (env-var
  resolution in `run:` blocks and the statuses endpoint). ⚠️ Until the first real dispatch after
  2026-08-30 has been seen to post it, treat the status as unverified on this forge. The empirical
  check remains the authority on what the run *did*: `git ls-remote origin 'refs/heads/renovate/*'`
  before and after, plus checking whether ticks reverted to `- [ ]`. Heads moved AND ticks consumed
  ⇒ it ran live. **Apply this check only after the run starts — not after the dispatch.** The dispatch
  returns `HTTP 204` immediately but the run only queues. A queued run is invisible in `/actions/tasks`
  (that endpoint lists jobs, and a job row does not exist until the job starts); use
  `/actions/runs?event=workflow_dispatch` instead. Sequence: confirm the run exists → wait for
  `status` to leave `waiting` → then read heads and ticks. Measured 2026-08-29: a dispatch was
  written up as "did nothing" because `/actions/tasks` showed nothing new — the run had been waiting
  24 minutes behind a ~35-minute `app-e2e`. Also: the `dryRun: "false"` string form is confirmed
  live (run 2285) but is NOT safe by construction — `"false"` is a truthy string under GitHub
  expression semantics and would select a dry run; it resolved live only because Forgejo coerced it
  against the input's declared `type: boolean`. The empirical check is mandatory, not advisory.
- **Never hand-close a Renovate PR — with one measured exception for `lockFileMaintenance`.**
  Closing an ordinary update PR marks it rejected — Renovate stops proposing it until a human ticks
  the dashboard to revive it. If the queued CI is in the way, cancel the runs — that frees the
  runner without signalling rejection. Leave the PR; Renovate autocloses this class itself (retitling
  it `- autoclosed`) and deletes the branch, provided nobody hand-pushed to it.

  **MEASURED EXCEPTION (item #290, 2026-08-30, verified against renovate@44.52.0 dist): closing a
  `lockFileMaintenance` PR does NOT mark the channel rejected.** The suppression is gated on
  `recreateClosed`, and that flag is `true` for `lockFileMaintenance` (set at `:150` of
  `workers/repository/updates/generate.js`) — so `check-existing.js` returns `null` before it ever
  looks for a closed PR, and the channel is unaffected. Keep the blanket rule anyway: knowing which
  shape a given PR resolved to means reading Renovate's resolution at merge time, which is not a
  thing to do routinely. Act on the exception only deliberately.
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
  not impatience. **DECIDED 2026-08-28 (item #271): this friction is ACCEPTED, not mitigated.** It
  is infrequent, fails loudly and safely (a red gate, never a silent bad merge), and is a
  two-minute diagnosis with this runbook. Mitigations were considered and rejected: shifting the
  window trades a certain constraint for a probabilistic one; pinning the verify-time policy
  re-opens the cold-`--frozen-lockfile` question feature 034 already settled. Revisit only if it
  starts blocking multiple PRs a week. See [CI self-serve diagnostics](ci-diagnostics.md) for the
  board shape this produces.
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
- **A surviving `renovate/*` branch is not evidence of pending work — check ancestry before
  ticking.** `default_delete_branch_after_merge` was false until 2026-08-29 (item #290), so merged
  Renovate PRs left their branches behind and Renovate kept listing them. Ticking `unschedule-branch`
  for an already-merged branch opens an empty PR that queues a full CI cycle. Before ticking any
  listed branch, run `git merge-base --is-ancestor origin/renovate/<branch> main && echo "EMPTY"`.
  Do NOT substitute `git diff --stat main...branch` — for an already-merged branch it prints nothing,
  and blank output reads as "no changes" rather than "already in main". Why it happens: `renovate.json`
  sets `rebaseWhen: "conflicted"`, which causes `shouldReuseExistingBranch` (in
  `workers/repository/update/branch/reuse.js`) to skip the `isBranchBehindBase` guard entirely. An
  ancestor branch is not conflicted, so control falls through to `reuseExistingBranch: true` and
  Renovate opens a PR from the stale commit verbatim. A reused branch also bypasses the branch
  budget limit, because the budget gate is conditioned on `!branchExists`. Renovate does NOT need
  the branch to survive — proven by symmetry: when PR #276 merged and deleted its branch, the python
  channel still appeared on the dashboard under Awaiting Schedule. Surviving branches buy nothing
  and cost empty PRs.
- **`renovate/lock-file-maintenance` is hard-exempt from Renovate's own pruning — by exact name.**
  `finalize/prune.js` filters it out before `cleanUpBranches` ever sees it, so Renovate will never
  clean it up and after a merge it lingers forever. `default_delete_branch_after_merge` (enabled
  2026-08-29) is therefore the *only* mechanism that removes it; the one stale copy predating the
  setting had to be deleted by hand. The comparison is `!==` on the exact name: the suffixed group
  branches this repository produces (`renovate/lock-file-maintenance-cargo-deps`,
  `renovate/lock-file-maintenance-python-deps`) are **not** exempt — they are prunable by autoclose.
  Deleting a branch that is an open PR's head closes that PR — treat it as hand-closing for ordinary
  updates (marks the channel rejected). It is safe for `lockFileMaintenance`: the `recreateClosed`
  exception (see the Never hand-close gotcha above) means the channel is unaffected. Assume it is
  not safe for anything else without reading the renovation code. Only a stale branch with no open
  PR is unconditionally safe to remove.
- **Merging past a pending `renovate/stability-days` check is only acceptable when three conditions
  all hold (item #298).** Branch protection treats the check as advisory, so the forge permits
  merging past it — this rule says when that is acceptable. **Default: HOLD.** The three conditions
  are: (1) the wait *cannot* satisfy it — the pending state is structural, not temporal (temporal: the
  release ages past a knowable date and goes green — wait; structural: something resets the clock
  faster than it can run down); (2) the posture has been measured first with the gate's own criteria
  and recorded on the PR (for images, the `--severity CRITICAL --ignore-unfixed` recipe in
  [infra-image-scanning](infra-image-scanning.md); for packages, the SAST/audit gates on the PR); and
  (3) the update has security value now — it clears a live finding or unblocks a red gate on `main`.
  Impatience does not qualify. Post-#297 the structural case should no longer arise for the docker
  group (images are version-tagged); if `stability-days` settles unaided on the next docker PR, criterion
  1 should essentially never hold again and the rule collapses to **wait**. ⚠️ Use a two-dot diff
  (`git diff main branch`, not `git diff main...branch`) to ask what a PR would still change —
  the three-dot form is against the merge base and will list changes `main` already has by another
  route.
- **The weekly health digest (item #311) goes and looks so you do not have to.** `scripts/renovate-health.mjs`
  runs every Friday at 11:00 UTC (after the window run finishes) via `.forgejo/workflows/renovate-health.yml`
  and posts a comment on item #311. It classifies every `renovate/*` branch by ancestry, reports budget
  consumption, surfaces Repository Problems warnings, and flags pending `stability-days` states. Always
  exits 0 — the comment is the report. **A week of silence means the job itself died.** Dispatchable
  for on-demand verification. Close item #311 to stop the digest permanently.

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

## Accepted residuals (decided, not overlooked)

Recorded from the 2026-08-30 latent-issue audit so the next reader knows each was seen and decided,
rather than rediscovering it as a suspected defect.

- **`engines.node: ">=22.13"` is a floor, not a pin, and it stays one.** Every pin runs 24.x; the
  floor states compatibility, not reality. `check-toolchain-consistency.mjs` checks satisfaction,
  deliberately. Raise the floor only when a tool requires it.
- **Node rides two Renovate groups.** Workflow `node-version` entries ride `ci actions`
  (github-actions manager); Dockerfile `FROM node` rides `docker base images`. A Node bump can
  arrive as two PRs, and the pins already differ. Accepted **while the gate floor-checks** — none of
  this can merge unsafe. If Node drift ever bites, the fix is the nx/playwright/pnpm pattern: one
  group, one guard.
- **`runs-on: ubuntu-latest` is extracted** by the github-runners manager (15 refs). On act_runner
  the label maps to a runner-side container and a "bump" would be meaningless — if such a proposal
  appears, close it as not applicable (this is not a `lockFileMaintenance` PR; the hand-close rule
  marks only that one label rejected, which is the intent here).
- **`npx --yes renovate@44` is major-pinned and Renovate cannot see it** — documented in
  `renovate.yml` as a deliberate residual with its own bump procedure.
