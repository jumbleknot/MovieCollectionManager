---
type: Runbook
title: Renovate dependency bot
description: Operating the Renovate dependency bot — the three channels and their cadences, the Friday-only window that the nightly cron is NOT, the budget that binds before the schedule, the silent failure modes that produce absence instead of errors (including the pinDigest/digest collision fixed by item #350, the timestamp-absent ghcr.io/quay.io tags fixed by item #349 with timestamp-optional, and the Docker Hub page-11 403 that discards all timestamps fixed by capping dockerMaxPages at 10), the pinned-toolchain table and the Rust devcontainer rebuild gotcha, and the two-place config validator that catches the unknown-key class the guard test cannot.
resource: docs/runbooks/renovate.md
tags: [renovate, ci, dependencies, runbook]
timestamp: 2026-09-05T01:39:12.000Z
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
- **A pinDigest that collides with a version update on the same branch is DROPPED, silently.**
  `docker:pinDigests` sat in `renovate.json`'s `extends` and did nothing for `python:3.13-slim` for
  as long as it had been there — not deferred, discarded every run. Measured 2026-08-30 (item #308):
  Renovate logged `INFO: Ignoring upgrade collision` eight times, once per reference, and the pin
  never appeared on the dashboard or in Repository Problems. The mechanism
  (`workers/repository/updates/branchify.js`): upgrades are de-duplicated per branch on
  `` `${packageFile}:${depName}:${currentValue}` ``; a second update for the same key with a
  different `newValue` is dropped outright. `matchDatasources: ["docker"] → groupName: "docker base
  images"` puts every docker update on one branch, so `3.13-slim → 3.14-slim` (version) and
  `3.13-slim → 3.13-slim@sha256:…` (pinDigest) collide and the pin loses. The tell: images that
  already carry no parseable version (`rust:alpine3.21`, `uv:latest`) receive digests in the same
  PR — they have no competing version update to collide with. **The fix is a separate
  `docker digest pins` packageRule scoped to `matchUpdateTypes: ["pinDigest"]`, ordered after `docker
  base images`** — a separate rule is a separate branch, a separate branch is a separate key
  namespace. Verified: re-running the lookup with the rule present took the collision count from eight
  to zero (item #308). The guard test asserts both halves.

  **SUPERSEDED 2026-09-04 (item #350): the rule now claims `["pinDigest", "digest"]`, and the
  guard's control was reversed.** The scoping above held only while the image was unpinned. Once
  `python:3.13-slim` carried a digest (feature 063), its weekly refresh became an updateType `digest`
  and collided with the same `3.14-slim` version update on the same key — eight times per run,
  measured with the identical lookup, while the version update it lost to sat pending. So the
  python digest **never refreshed**: the #303 class reopened for python, reported nowhere. A refresh
  is the one docker update that *always* shares its key with any version update of the same image,
  so it needs its own namespace as much as the initial pin does. Verified the #308 way: collision
  count for python 8 → 0 with the widened rule.
- **A ghcr.io or quay.io tag that has no `releaseTimestamp` is pending FOREVER under any cooldown — and if it shares a group with a non-pending update, it is dropped silently.** Measured 2026-09-04 on PR #347 (`renovate/uv-pin`): the eight github-releases uv sites moved to 0.12.8 and the four `ghcr.io/astral-sh/uv` image tags stayed at 0.12.7 — a half-bump with the group rule in place and correct. The mechanism: `minimumReleaseAgeBehaviour` defaults to `timestamp-required` (added to Renovate 2025-10). The docker datasource only supplies `releaseTimestamp` for Docker Hub (`tag_last_pushed`); every ghcr.io and quay.io tag, and every `pinDigest`, arrives without one. So any cooldown makes those tags permanently pending. In a mixed group, `generate.js` removes pending upgrades when *any* upgrade in the group is not pending (`"Branch is not pending, removing pending upgrades"`) — the non-pending half ships; the pending half is discarded, at DEBUG, on every run. **The fix for the `uv pin` group: set `minimumReleaseAge: null` on the rule that groups both halves.** The guard test asserts both halves resolve to no cooldown. The trade — uv bumps skip the 3-day cooldown — is recorded on the rule.

  **DECIDED 2026-09-04 (items #349, #350), both in `renovate.json`:** registries that cannot supply
  a timestamp do not wait for one. A packageRule on `matchDatasources: ["docker"]` for `ghcr.io/`
  and `quay.io/` sets `minimumReleaseAgeBehaviour: "timestamp-optional"` — a release *with* a
  timestamp is still aged, one *without* proceeds. **Docker Hub deliberately stays
  `timestamp-required`**: its tags and digests carry `tag_last_pushed`, so the cooldown there is
  temporal and real; widening the rule to all of docker would silently disable feature 034's control
  for the images it actually works on. Add a registry to the rule only after checking the datasource
  still cannot time-stamp it. The guard test asserts both halves. Renovate WARNs once per run under
  this setting; a top-level `logLevelRemap` demotes that one message to `info` so it does not
  become a permanent Repository Problem — a *different* WARN still surfaces.

  Residuals that remain after #349/#350: `docker digest pins` (all `pinDigest`/`digest`, all
  timestamp-less even after the widened scoping) still sits under Pending Status Checks permanently
  — the initial pins can only land from a dashboard tick. **`hub.docker.com` was allowlisted
  2026-09-05** (`.devcontainer/egress-allowlist.json`; on the sandbox platform the operator must
  also apply the host-side rule — see `devcontainer-sandbox.md` §4): a local lookup now sees
  `tag_last_pushed` and the Docker Hub half can be observed locally rather than inferred from CI.
- **Docker Hub's anonymous tag API returns 403 from page 11, and one 403 discards every timestamp.**
  `/v2/repositories/<repo>/tags?page_size=100` answers 200 for pages 1–10 and **403 Forbidden** from
  page 11 (measured 2026-09-05; `page_size=1000` is silently capped to 100). `library/node` has 9080
  tags. Renovate's default `dockerMaxPages` is 20, so on a cold cache — every CI run — it asks for
  page 11, gets the 403, and `_getDockerHubTags` returns `null`: the entire timestamped result for
  that image is discarded and the registry tag list, which has no timestamps, is used instead. Under
  `timestamp-required` that is pending for ever, for node, python, postgres, redis, mongodb, opa,
  clickhouse, langfuse, and minio alike — the permanent "Pending Status Checks" on `docker base
  images` and `docker digest pins`, which read exactly like a 3-day cooldown that never elapsed.

  **Fixed 2026-09-05: `RENOVATE_DOCKER_MAX_PAGES: '10'` on the Run Renovate step** (`dockerMaxPages`
  is `globalOnly`, so it cannot live in `renovate.json`); the guard test asserts ≤ 10. Ten
  newest-first pages reached back to 2025-11 for node, so every live candidate has a timestamp.
  Verified: the same lookup then logged zero "no releaseTimestamp" markings, and the pending members
  were exactly the ones pushed inside the last three days — temporal, as designed.

  ⚠️ **Reproduction trap**: Renovate keeps a 30-minute package cache at `/tmp/renovate/cache`. A
  local lookup made right after a failed Docker Hub fetch served the failure from cache and made no
  Hub requests — the run looked identical to the broken one. Point `RENOVATE_CACHE_DIR` at a fresh
  directory for any re-measurement.
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

## Pinned toolchains (item #307)

Item #303's principle restated: a floating reference means no version, no classification, and no
reproducibility; a pin with nothing maintaining it trades a floating reference for a rotting one.
Every pin below is exact, the same at every site, and tracked by something that will move it.

| tool | the pin lives in | how Renovate sees it | grouped? |
| --- | --- | --- | --- |
| **Rust** | `rust-toolchain.toml` (`channel`) + devcontainer `--default-toolchain` arg | built-in `rust-toolchain` manager + a customManager for the devcontainer half (same depName and datasource — one dependency, not two) | **yes** — `rust toolchain` |
| **semgrep** | `scripts/sast-scan.mjs` (`SEMGREP_PIN`) | customManager, `pypi` | no |
| **cargo-audit** | `guardrails.yml` (`--version`) and the toolchain image (`cargo-audit@X`) | customManager, `crate` | no |
| **uv** | one version string repeated at every site (3 install-script URLs + 5 `setup-uv` inputs + 4 image tags) | customManager (`github-releases`) for script/action shapes; built-in docker manager for image tags | **yes** — `uv pin` |

**Grouping rule**: a group is needed when a *second* manager sees the other half of the same
dependency. Trivy covers two files with one depName and has no group — one dependency, one branch.
Rust and uv each need one because the built-in manager claims a half under a different depName.

### Rust: the devcontainer must be rebuilt after a toolchain bump

All three workflows install rustup with `--default-toolchain none`. The first `cargo` call inside
the repository resolves the channel and its components from `rust-toolchain.toml`.

> ⛔ **A Rust bump needs the devcontainer image REBUILT before local `cargo` works again — and
> until it is, `cargo`/`rustc`/`nx test mc-service` FAIL in the dev container.** This is inherent
> to pinning an exact version, not to which version was chosen. Measured 2026-08-30, immediately
> after adding the file:
>
> ```
> $ rustup show active-toolchain
> info: syncing channel updates for 1.98.0-x86_64-unknown-linux-gnu
> error: could not download … https://static.rust-lang.org/dist/channel-rust-1.98.0.toml.sha256
>        dns error: No address associated with hostname
> ```
>
> Two facts combine. **rustup keys toolchains by NAME**: the image installs one called
> `stable-x86_64-unknown-linux-gnu`, and a file naming `1.98.0` asks for a *different* toolchain —
> so rustup tries to fetch it even when the bytes on disk are the same compiler. And
> **`static.rust-lang.org` is not on the dev container's egress allowlist**, so that fetch cannot
> succeed.
>
> The fix is automatic: the Renovate `rust toolchain` PR moves `rust-toolchain.toml` **and**
> `.devcontainer/toolchain.Dockerfile` together — that is what the grouping rule is for — and
> `devcontainer-image.yml` is path-triggered on `.devcontainer/toolchain.Dockerfile`, so merging
> one rebuilds the image with a toolchain named `1.98.0`, which the file then resolves locally with
> no download at all. **The only manual step is pulling the rebuilt image.** CI is unaffected
> throughout: it installs rustup fresh with `--default-toolchain none` on a runner with open egress.

### uv: one version string, many sites

uv's single source of truth is **one version string, repeated at every site**, held together by one
Renovate customManager plus the `uv pin` packageRule, and asserted equal across every site by
`renovate-workflow.guard.test.mjs`. It is deliberately not a file that every site reads — `astral-sh/setup-uv`'s
`version:` input is an Actions expression and cannot read a repository file, so a file would leave
the five action sites unpinned. The install-script URL carries the version in its path
(`https://astral.sh/uv/<version>/install.sh`), which also stops fetching the moving script. Each
`setup-uv` input carries a `# uv-version` marker so the manager's matchString does not claim any
other `version:` key added to those workflows later.

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
- **`curl https://sh.rustup.rs | sh` remains an unversioned script piped to sh**, in three workflows
  and the toolchain image. This is item #307's criterion 5 met for uv and **not** met for rustup,
  deliberately. What that script installs is `rustup` (a bootstrapper), and the thing that decides
  which compiler runs — the toolchain — is now pinned by `rust-toolchain.toml`, so a change in
  rustup cannot change the compiler. The pinnable alternatives both cost more than they buy: the
  archive binary hard-codes the architecture (breaks a non-amd64 devcontainer build); the archive
  script path could not be verified from the dev container (`static.rust-lang.org` is not on the
  egress allowlist). Revisit only if rustup itself is ever implicated.
- **`backend/mc-service/Dockerfile` still builds `FROM rust:alpine3.21@sha256:…`** — a version-less
  tag, so Renovate can only churn its digest and can never propose a classified update. Re-tagging
  it is a change under `backend/`, which is SDD-gated, so it is an accepted divergence recorded in
  `rust-toolchain.toml` and in the `rust toolchain` packageRule (item #307, criterion 1). A guard
  test asserts the toolchain group does **not** claim it — the failure that would matter is Renovate
  proposing a Rust release number as a docker tag.
- **`renovate-config-validator` catches the unknown-key class that the guard test cannot — but only with both `--strict --no-global` flags.** Measured 2026-08-30 against this repo's own `renovate.json` on renovate@44.52.0: without `--no-global` the file is validated as a *global self-hosted* config (not the repo config Renovate actually reads), and without `--strict` a renamed key is a warning not a failure — exit 0 on precisely the class the check exists to catch. Since item #309 the validator runs in two places, both on renovate@44: (1) `guardrails/renovate-config` in `.forgejo/workflows/guardrails.yml` — required, unconditional, catches an edit to `renovate.json` before it merges; (2) a step in `renovate.yml` before `Run Renovate` — catches a key deprecated by a minor bump between Friday windows when nothing in the repo changed. It is deliberately NOT path-gated: a cold run measured 27 s; a path filter buys seconds and costs the guarantee that a green board means the validator ran. The guard test (`renovate-workflow.guard.test.mjs`) asserts the job carries no `if:` and no `needs:`, and that all three `renovate@44` references agree. The validator does not replace the guard test — the guard test catches a key Renovate knows but ignores depending on where it is written (the `prPriority`-inside-`lockFileMaintenance` case).
