# Renovate — operating the dependency bot

How to drive Renovate here, and how to tell the difference between "it is waiting", "it did nothing"
and "it is broken" — which look identical from the outside and have cost this repository several
sessions of misdiagnosis.

The **configuration** rationale lives in `renovate.json`, which is heavily commented and is the source
of truth for grouping, version locks and cooldowns. This runbook is the **operating** half: the
schedule, the dashboard, forcing a run, and the failure modes that are silent by construction.

---

## 1. The three channels and their cadences

`renovate.json`'s own description states the goal: keep the dependency surface patched enough that the
repository's gates stay green before a human notices, while never auto-merging and never swamping the
single CI runner.

| channel | trigger | schedule |
| --- | --- | --- |
| **security** — `vulnerabilityAlerts` + OSV | nightly cron `0 3 * * *` | schedule-**exempt**, unbudgeted |
| **lockfile refresh** — `lockFileMaintenance` | the window run | Friday, ranked ahead of routine work (`prPriority: 5`) |
| **routine** — the grouped package rules | the window run | Friday only |

**Nothing auto-merges.** Every group carries `automerge: false`. A tick gets you a PR, never a merge.

### The window is Friday, and the nightly cron is NOT it

`.forgejo/workflows/renovate.yml` has two crons doing different jobs:

- `0 3 * * *` — nightly, **outside** `renovate.json`'s permitted window, deliberately. Only
  schedule-exempt work (security PRs) lands here.
- `0 7 * * 5` — Friday 07:00 UTC = 03:00 EDT / 02:00 EST, **inside** the `* 2-4 * * 5` window.

> ⚠️ **Routine branch work does not happen on the nightly run.** Outside the window Renovate returns
> `not-scheduled` *before* branch creation. This has been got wrong repeatedly, including by readers of
> this repository's own notes: "it will sort itself out tonight" is false for anything except a
> security PR or an explicit dashboard request. If you want routine work now, you must force it (§3).

### The budget binds before the schedule does

`prConcurrentLimit: 5`, `prHourlyLimit: 4`. Measured 2026-08-28: the window run created **exactly 4**
PRs — the hourly limit, precisely. Everything else deferred a week.

`handleConcurrentLimits()` checks the hourly PR limit for *every* key, so spending it also blocks
**branch** creation, not just PR creation. And open PRs consume concurrency: leaving four green
Renovate PRs unmerged caps the next window at one new PR. **Merging promptly is a throughput lever.**

---

## 2. Reading the Dependency Dashboard (item #29)

Item #29 carries `status/bot-managed`. Renovate rewrites its body on a schedule. **Never edit its
prose, retitle it, relabel it or close it.** Ticking a checkbox is the one sanctioned interaction —
that is the bot's own input mechanism, not prose.

> ⚠️ **Re-read the dashboard before ticking. The sections and the checkbox names change.** The same
> update moved from `unlimit-branch=` under **Rate-Limited** to `unschedule-branch=` under **Awaiting
> Schedule** to `other-branch=` under **Other Branches** across three runs on one day. Ticking a
> checkbox name from memory writes a box Renovate does not read, and you then report a diagnostic that
> never ran.

| section | checkbox | what ticking does |
| --- | --- | --- |
| Pending Approval | `approve-branch=` | **required** — `dependencyDashboardApproval` groups are never proposed otherwise |
| Awaiting Schedule | `unschedule-branch=` | creates it on the next run, ignoring the Friday window |
| Rate-Limited | `unlimit-branch=` | creates it despite the PR budget |
| Pending Status Checks | `approvePr-branch=` | opens the PR now, skipping the `minimumReleaseAge` cooldown |
| Open | `rebase-branch=` | rebases/regenerates that branch on the next run — **not** schedule-gated |
| Other Branches | `other-branch=` | forces a PR for a branch that has none |
| Repository Problems | — | **read this.** Renovate reporting its own errors; see §5 |

**Editing the body safely.** A tick is a one-character edit. Read the body immediately before writing,
assert the target checkbox appears exactly once and is untenanted, and assert the resulting body
differs by exactly the number of characters you intended and is the same length. Anything less risks
clobbering a concurrent bot rewrite.

> ⚠️ **A `renovate/*` branch that already exists is not evidence of pending work — check ANCESTRY
> before ticking it.** This repository has `default_delete_branch_after_merge: false`, so a merged
> Renovate PR leaves its branch behind. Renovate keeps listing that branch on the dashboard, and a
> tick opens a PR for content `main` already has. Item #290 tracks whether the setting can simply be
> turned on; until it is, this check is the mitigation.
>
> Measured 2026-08-29 (item #290, PR #288). `renovate/lock-file-maintenance-cargo-deps` was merged as PR #260
> and `renovate/lock-file-maintenance` as PR #261; both refs survived. An `unschedule-branch` tick on
> the cargo one produced an **empty PR** that then queued a full CI cycle ahead of real work.
>
> ```bash
> git merge-base --is-ancestor origin/renovate/<branch> main && echo "EMPTY — already in main"
> ```
>
> Do **not** substitute `git diff --stat main...branch` for this. For an already-merged branch it
> prints **nothing**, which reads as "no output" rather than "no changes" — that is exactly how this
> was missed, in a survey where the one real branch printed a stat and the two empty ones printed
> blanks. `--is-ancestor` answers the question rather than leaving it to be inferred from silence.
> (§4's two-dot warning is the sibling check, asking what a NON-empty branch would still change.)

**The mechanism, from renovate@44's own dist** (`workers/repository/update/branch/reuse.js`,
`shouldReuseExistingBranch`) — this is a config interaction, not a bug:

- **No branch** → `Branch needs creating` → `reuseExistingBranch: false`, and Renovate regenerates the
  content from scratch. This is the healthy path.
- **Branch exists** → the `isBranchBehindBase` guard, the one thing that would notice the branch is
  already in `main`, runs **only** when `rebaseWhen` is `behind-base-branch` or a `keepUpdatedLabel`
  is set. `renovate.json` sets **`rebaseWhen: "conflicted"`**, so it is skipped outright
  (`Skipping behind base branch check due to rebaseWhen=conflicted`). An already-merged branch is an
  *ancestor* of `main`, so it is not conflicted either — control falls through to
  `reuseExistingBranch = true` and Renovate opens a PR from the **stale commit verbatim**.

Corroborated on PR #288: its head is still `c4d4a5e4`, dated 2026-08-28 07:03. The 21:43Z run that
opened it created no new commit — it did not regenerate, did not rebase, and did not notice.

A surviving branch distorts one more thing: `branch/index.js` gates the branch budget behind
`!branchExists`, so a reused branch **bypasses the branch limit** (§1) entirely.

> ✅ **Renovate does NOT need a merged branch to survive — proven by symmetry.** When PR #276 merged,
> `renovate/lock-file-maintenance-python-deps` **was** deleted (that merge passed
> `delete_branch_after_merge`); the python channel is nonetheless listed on the dashboard under
> **Awaiting Schedule**, exactly like the js one whose branch survived. Dashboard tracking comes from
> Renovate's own update computation, not from branch existence. So the surviving branch buys nothing
> and costs an empty PR.

> ⚠️ **`renovate/lock-file-maintenance` is HARD-EXEMPT from Renovate's own pruning — by exact name.**
> `finalize/prune.js` filters it out before `cleanUpBranches` ever sees it:
>
> ```js
> const lockFileBranch = `${config.branchPrefix}lock-file-maintenance`;
> renovateBranches = renovateBranches.filter((branch) => branch !== lockFileBranch);
> ```
>
> So Renovate will **never** clean that branch up, and after a merge it lingers for ever. Enabling
> **`default_delete_branch_after_merge`** (done 2026-08-29, item #290) is therefore not merely tidier
> — it is the *only* mechanism that removes this particular branch, and the one stale copy that
> predated the setting had to be deleted by hand.
>
> Note the comparison is `!==` on the exact name, so the **suffixed** group branches this repository
> actually produces — `renovate/lock-file-maintenance-cargo-deps`,
> `renovate/lock-file-maintenance-python-deps`, created because the cargo and python groups carry
> their own `groupName` — are **not** exempt. They are prunable, which is why leaving PR #288 for
> autoclose is the right call rather than merging an empty PR: `cleanUpBranches` closes the PR
> (retitling it `- autoclosed`) and deletes the branch, provided `isBranchModified` is false — which
> it is, for any branch nobody hand-pushed to (§4).

> ⛔ **Never delete a branch that is an OPEN PR's head.** It is hand-closing by another route and
> carries the same consequence as §4's rule — for `lockFileMaintenance` it marks the channel rejected.
> `renovate/lock-file-maintenance-cargo-deps` must therefore stay until PR #288 autocloses, even
> though its content is already in `main`. Only a stale branch with **no open PR** is safe to remove.

---

## 3. Forcing a run

```
POST /api/v1/repos/{owner}/{repo}/actions/workflows/renovate.yml/dispatches
{"ref":"main","inputs":{"dryRun":"false"}}
```

> ⚠️ **`dryRun` defaults to TRUE and must be set explicitly.** The default is correct — a dispatch that
> creates PRs by accident is the worse failure — but it means a forced run that did nothing looks
> exactly like a forced run that worked. This has already produced one wrong recorded conclusion:
> run 5963 (2026-08-14) was written up as *"the schedule beats a dashboard unlimit tick"* when it had
> simply been a dry run.

Ticks and the dispatch compose: tick everything you want in one pass, then dispatch once. Independent
channels cannot confound each other, and one dispatch is one runner slot.

### You cannot read the run's mode — verify it empirically

Item #268. On this Forgejo build all three routes are dead:

- the step name renders the **raw uninterpolated** `${{ … }}` expression on the run page;
- `/actions/runs/{id}/jobs` → `404 page not found`;
- there is no log endpoint.

`event_payload.inputs` works, but only echoes what you **sent** — not what the expression resolved to.

**The signal that does work is empirical**, because a live run moves things and a dry run cannot:

```bash
git ls-remote origin 'refs/heads/renovate/*'          # before, and after
node scripts/backlog.mjs show 29 | grep -E '^\s*- \[x\]'   # ticks consumed == live
```

Heads moved **and** ticks consumed back to `- [ ]` ⇒ it ran live.

**Wait for the run to actually START before applying that check — and do not look for it in
`/actions/tasks`.** The dispatch returns `HTTP 204` immediately, but the run only *queues*: there is
one runner, and it may already be inside a ~35-minute `app-e2e`.

Measured 2026-08-29. A dispatch at 21:19Z returned 204; `/actions/tasks?limit=50` listed 75 renovate
rows whose newest was **eight hours old**, and no new one — which reads exactly like "the dispatch did
nothing", and was written up that way before being corrected. **`/actions/tasks` lists JOBS, and a job
row does not exist until the job starts.** The run was there the whole time, under a different
endpoint:

```bash
# does the run EXIST? (a queued run appears here and nowhere else)
curl -sS -H "Authorization: token $TOKEN" "$API/actions/runs?event=workflow_dispatch&limit=5"
# then poll it until status leaves `waiting`
curl -sS -H "Authorization: token $TOKEN" "$API/actions/runs/<id>"
```

The string form in the recipe above is confirmed to resolve **live** (run 2285, 2026-08-29: heads
moved, ticks consumed, PRs #288/#289 created). Do not read that as "the string form is safe by
construction" — it is not. `renovate.yml` computes
`(github.event_name == 'workflow_dispatch' && inputs.dryRun) && 'full' || ''`, and under GitHub
expression semantics a non-empty string `"false"` is **truthy**, which would select `'full'` — a dry
run. It ran live only because Forgejo coerced the value against the input's declared `type: boolean`.
That coercion is a property of this forge build, not of the recipe, which is exactly why the
empirical check below is mandatory rather than advisory.

Two traps in that payload: the run's `event` field renders as the **empty string** for a dispatch
(the `?event=workflow_dispatch` filter still matches it, so filter — do not read the field), and
`status` sits at `waiting` for as long as the queue is deep. The run above waited ~24 minutes, then
ran for ~3.

So a 15-minute poll of heads-and-ticks times out on **queue depth alone** and proves nothing about the
mode. Sequence it: confirm the run exists → wait for `status` to leave `waiting` → *then* read heads
and ticks. Anything else re-derives the item #268 mistake with a new cause.

---

## 4. Renovate PRs — what not to do

**Never hand-close a Renovate PR.** Closing one marks that update *rejected*: Renovate stops proposing
it until a human ticks the dashboard to revive it. Closing `js-patchminor` would silently block every
JS patch/minor update.

**Never hand-push to a Renovate branch** to resolve a conflict. Renovate detects the branch was
modified and can stop managing it. Use `rebase-branch=` + a dispatch instead.

**An EMPTY PR from a stale branch is still a Renovate PR — do not hand-close it.** The temptation is
strong, because a PR with no diff is obviously not going to merge. But the rule above does not have an
exception for it: hand-closing PR #288 would mark `lockFileMaintenance` rejected and silently disable
the one channel that clears a CVE the manifest range already permits (§5). Leave it; Renovate
autocloses this class itself. If the queued CI is genuinely in the way, CANCEL the runs — that frees
the runner without signalling rejection — and still leave the PR alone.

**Autoclose is normal and is not a failure.** When a bump is already satisfied on `main`, Renovate
closes the PR itself and deletes the branch — the title gains `- autoclosed`. Measured on PR #262
after a lockfile refresh had already delivered its content.

> ⚠️ **Use a TWO-dot diff to ask "what would this still change on `main`".** `git diff main...branch`
> is against the *merge base* and shows what the branch adds relative to a common ancestor — it will
> happily list changes `main` already has by another route. On PR #262 that misread produced "three
> version moves remain unique to this PR" when the two-dot diff showed it would have *downgraded*
> crates. `git diff main branch` is the honest question.

---

## 5. The silent failure modes

These are the ones worth internalising, because none of them produces a red build or an error you can
search for. They produce **absence**, and absence reads as "nothing to do".

### A channel whose toolchain is missing dies silently

Renovate shells out through `execa` to regenerate a lockfile. If the binary is not on PATH, execa
rejects, Renovate **suppresses** the rejection to a single line on the dashboard:

```
## Repository Problems
 - ⚠️ WARN: execa promise rejection suppressed
```

and the channel simply never appears. No PR, no error, nothing to notice — every run, for ever.

Measured 2026-08-28 (item #218): with the schedule *and* budget taken out of the picture by an
`unschedule-branch` tick, the `pep621` channel still created nothing, because `renovate.yml` installed
pnpm and Rust and nothing for Python. The symmetry was the proof — the two channels with a toolchain
on PATH both produced PRs; the one without never had.

**So: a new manager means a new toolchain step in `renovate.yml`.** It currently provisions pnpm
(corepack), Rust (rustup) and uv (`astral-sh/setup-uv`).

**Rule out "nothing to refresh" before believing a channel is idle** — run the refresh by hand
(`uv lock --upgrade --dry-run`, `cargo update --dry-run`) and see whether work exists.

### The release-age cooldown does not cover transitives

`renovate.json`'s catch-all `minimumReleaseAge: 3 days` gates the package Renovate **proposes**. It
does nothing about what a lockfile regeneration **drags in**, and pnpm 11 independently verifies the
lockfile against supply-chain policies on install:

```
✗ Lockfile failed supply-chain policy check (2494 entries in 10.8s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] zod@4.5.1 was published at 2026-08-28T17:56:29Z,
within the minimumReleaseAge cutoff (2026-08-27T19:35:05Z)
```

Measured on PR #263: a fully compliant `@ag-ui/client 0.0.58 -> 0.0.59` resolved `zod@4.5.1`, published
1.7 hours earlier, and **six required contexts went red at `pnpm install`** — none of them about the
change. The tell is the breadth: when `okf` and `sast` fail together, suspect the install, not the code.

**Handling: wait.** The transitive ages past the ~24h cutoff and a re-run passes. Do **not** add it to
`pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` — that list is for security-floor exceptions, and
using it here spends a security mechanism on impatience.

> **DECIDED 2026-08-28 (item #271): this is ACCEPTED, not mitigated.** It is infrequent, it fails
> loudly and safely — a red gate, never a silent bad merge — and with this runbook it is a two-minute
> diagnosis. Mitigations were considered and rejected as costing more than the friction: shifting the
> Renovate window to dodge fresh publishes trades a certain constraint for a probabilistic one, and
> pinning the verify-time policy explicitly re-opens the cold-`--frozen-lockfile` question feature 034
> already settled. **If you are here because a PR is red on this: re-run after the cutoff. That is the
> whole procedure.** Revisit only if it starts blocking multiple PRs a week.

### Extraction is not grouping

A `customManagers` entry makes Renovate *see* a second copy of a version. It does **not** make both
copies move in one PR — a later broad rule (`js patch/minor`, `js majors`) will claim one half and
strand the other. Every such pair needs a `packageRule` matching **both** managers, ordered **after**
the broad rules.

This has been paid for three times: nx (PRs #141 and #193, both half-bumps *with* the manager already
in place), the Playwright image tag (#204), and the pnpm/Dockerfile pins (#225).
`renovate-workflow.guard.test.mjs` asserts the *resolved* group for each pair, because a rule that
merely mentions the package passes a weaker check.

### A version number that does not advertise a breaking change

`@copilotkit/*` ships breaking API changes in **minor** bumps. It is grouped separately behind
`dependencyDashboardApproval`, exactly like the `cargo 0.x` rule, because one breaking member makes a
whole batched PR unmergeable *and* unsplittable — and Renovate regenerates it weekly, so the routine
bumps riding with it stay blocked for as long as the migration takes (measured on PR #263).

---

## 6. Triage checklist

1. **Is it red, or did it never run?** Absence is the common case. Check **Repository Problems** first.
2. **Is the failure about the change?** If unrelated gates fail together, look at the install step.
3. **Is `main` the right baseline?** `app-e2e` is path-gated; a run of config-only commits skips it, so
   "green on main" can mean "not exercised on main". Find the last commit that actually ran the job.
4. **Change one variable.** Redirect a single dependency rather than reinstalling a whole branch.
5. **Print the value, do not reason about it.** The mongodb 7.6.0 investigation (item #264) turned on
   printing the client metadata document — `{}` versus a full document — after two plausible
   hypotheses about servers and versions had both been falsified.

## Related

- `renovate.json` — grouping, version locks, cooldowns, and the reasoning for each
- `.forgejo/workflows/renovate.yml` — schedule, toolchains, dispatch inputs
- `scripts/__tests__/renovate-workflow.guard.test.mjs` — the assertions that keep the above true
- [CI self-serve diagnostics](ci-diagnostics.md) — reading a failure without log access
- [The agent-driven backlog](backlog.md) — item #29 and the `status/bot-managed` rule
