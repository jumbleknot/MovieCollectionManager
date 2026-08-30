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
> before ticking it.** A merged Renovate PR used to leave its branch behind; Renovate keeps listing
> that branch on the dashboard, and a tick opens a PR for content `main` already has.
>
> **`default_delete_branch_after_merge` is now `true`** (item #290 — verified against the repository
> API on 2026-08-30, and the last stale ref was removed the same day). Keep this ancestry check
> anyway, for two reasons that outlive the setting:
>
> 1. **The repo default covers the UI merge button only.** A merge through the API leaves the branch
>    unless the request passes `delete_branch_after_merge: true` **explicitly** — so an agent- or
>    script-driven merge can still create a stale ref while the setting reads `true`.
> 2. A branch can predate the setting, or be pushed by hand.
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

> ⚠️ **Deleting a branch that is an OPEN PR's head closes that PR** — treat it as hand-closing and
> apply §4's rule and its measured exception. It is safe for `lockFileMaintenance`; assume it is not
> safe for anything else.
>
> **CORRECTED 2026-08-30 (item #290).** This block previously read *"⛔ Never delete a branch that is
> an OPEN PR's head … for `lockFileMaintenance` it marks the channel rejected"*, and named
> `renovate/lock-file-maintenance-cargo-deps` as one that "must stay until PR #288 autocloses". The
> stated consequence was **false for the one channel it named** — see §4 for the code path. The
> branch was deleted on 2026-08-30 and PR #288 closed with it.
>
> Recorded so the correction is not merely asserted: this repository had the rule *and* the wrong
> reason for it, which is the shape it has been bitten by before — a comment standing in for a check
> (#194, #204, and §2's own `--is-ancestor` note).

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

### Reading the run's mode — the status, then the empirical check

Item #268. Every **introspective** route is dead on this Forgejo build:

- the step name renders the **raw uninterpolated** `${{ … }}` expression on the run page;
- `/actions/runs/{id}/jobs` → `404 page not found`;
- there is no log endpoint.

`event_payload.inputs` works, but only echoes what you **sent** — not what the expression resolved to.

**A dispatched run now publishes its RESOLVED mode itself**, as a commit status on the dispatched
sha, posted *before* Renovate runs (so a LIVE dispatch is recognisable early enough to abandon):

```bash
curl -sS -H "Authorization: token $TOKEN" "$API/commits/<dispatched sha>/status" \
  | jq '.statuses[] | select(.context=="renovate/mode") | .description'   # "LIVE" or "DRY RUN (creates nothing)"
```

It is built only from proven parts (env-var resolution in `run:` blocks, and the statuses endpoint
the failure digest already writes with `github.token` — guardrails #1627), **not** from `run-name:`,
which is the same expression class the step name already failed on.

> ✅ **VERIFIED on this forge, run 2397 (2026-08-30), item #268 closed.** A dispatch with
> `dryRun: "true"` against sha `95d1371c` posted `renovate/mode` = **"DRY RUN (creates nothing)"**
> at 22:37:35Z — **13 seconds** after the run started (22:37:22Z), against a 2m42s run. Note *what
> that reading proves*: the step is `if [ -n "$RENOVATE_DRY_RUN" ]`, so it prints `LIVE` whenever
> the job-level expression fails to resolve. Seeing "DRY RUN" is therefore positive evidence that
> the `${{ }}` resolved — a failure to interpolate could not have produced it.

The status answers the mode; the empirical check below remains the authority on what the run
*did*. Read both, and mind the empirical check's own limit: **outside the Friday window a LIVE run
also creates nothing** for routine work, so unmoved heads are *consistent with* a dry run there
rather than decisive.

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

**An EMPTY PR from a stale branch is still a Renovate PR — prefer leaving it.** Renovate autocloses
this class itself, and letting it do so costs nothing but a week. If the queued CI is genuinely in the
way, CANCEL the runs rather than closing the PR — that frees the runner without touching the PR.

> ✅ **MEASURED EXCEPTION, verified against renovate@44.52.0's own dist (item #290, 2026-08-30):
> closing a `lockFileMaintenance` PR does NOT mark the channel rejected.** The suppression this
> section warns about is gated on `recreateClosed`, and that flag is assigned per upgrade shape in
> `workers/repository/updates/generate.js`:
>
> ```js
> upg.recreateClosed = upg.recreateWhen === "always";                       // :137  the DEFAULT
> if (upg.isLockFileMaintenance) upg.recreateClosed = upg.recreateWhen !== "never";  // :150
> ```
>
> `recreateWhen` defaults to `"auto"` and is not set anywhere in this repository's `renovate.json`
> (verified: no top-level key, no packageRule). So the default is `false` — the rule above is right
> for an ordinary update — while `lockFileMaintenance` resolves to **`true`**, and
> `update/branch/check-existing.js` then returns before it ever looks for a closed PR:
>
> ```js
> if (config.recreateClosed) { logger.debug("recreateClosed is true. No need to check for closed PR."); return null; }
> ```
>
> With `existingPr` null, `update/branch/index.js:116`'s `"already-existed"` skip is unreachable.
> Three GROUPED shapes get the same exemption (`:188` single-update group, `:196` multi-version
> group, `:200` multi-value digest group) — so the blanket rule is more conservative than the code in
> several cases. **Keep it blanket anyway**: knowing which shape a given PR resolved to means reading
> Renovate's resolution, which is not a thing to do at merge time. The exception is documented so a
> future reader can act on it deliberately, not so the rule gets relaxed by default.
>
> ⚠️ **This was found the wrong way round.** PR #288's branch was deleted on 2026-08-30 *before* this
> block had been read, in violation of the rule as it then stood; the code was read afterwards and
> happened to vindicate the action. That is luck in ordering, not method — had the rule been right,
> the deletion would have disabled the channel that had just silently cleared the `image-size`
> advisories (item #303). Read §2 and §4 in full before touching a Renovate branch.
>
> **Falsifiable prediction, recorded 2026-08-30:** the cargo lockfile channel is unharmed, so
> Renovate's next in-window run (Friday 2026-09-04, 06:00–08:00 UTC) should list
> `renovate/lock-file-maintenance-cargo-deps` on the Dependency Dashboard again — alongside
> `renovate/lock-file-maintenance` and `-python-deps`, both of which are already listed as awaiting
> schedule **with no branch on `origin` at all**, which is independent evidence that the dashboard
> listing comes from Renovate's update computation rather than from branch existence. If it does not
> reappear, this correction is wrong and the blanket rule should be restored without the exception.

### Merging past `renovate/stability-days` — the rule (item #298)

The check enforces `renovate.json`'s `minimumReleaseAge: 3 days` — feature 034's control against a
compromised just-published release. Branch protection treats it as advisory, so the forge *permits*
merging past it; this section says when that is acceptable, so the answer stops depending on who is
at the keyboard.

**Default: HOLD.** Merging past a pending `stability-days` is permitted only when **all three** hold:

1. **The wait cannot satisfy it** — the pending state is *structural*, not *temporal*. Temporal:
   the release ages past a knowable date and the check goes green (the PR #263 zod case — wait).
   Structural: something resets the clock faster than it can run down (measured pre-#297: floating
   base-image tags rebuilt upstream re-pinned the digest weekly, so the 3-day clock never survived
   a regeneration).
2. **The posture has been measured first**, with the gate's own criteria, and recorded on the PR —
   for images, the `--severity CRITICAL --ignore-unfixed` recipe in
   [infra-image-scanning](infra-image-scanning.md); for packages, the SAST/audit gates on the PR
   itself.
3. **The update has security value now** — it clears a live finding or unblocks a red gate on
   `main`. Impatience does not qualify; that reasoning is the one `pnpm-workspace.yaml` records for
   rejecting `minimumReleaseAgeExclude` as a convenience lever.

Applied to the two cases that prompted the rule: **#263 was correctly parked** (temporal — the zod
transitive aged out at a knowable instant) and **#289 was acceptably merged** (structural at the
time — pre-#297 floating tags meant no wait would ever satisfy it — and its posture was scanned
first). They were both right, and the distinguishing fact is criterion 1.

**Post-#297 the structural case should no longer exist for the docker group**: the eight images are
version-tagged, so a proposal is a discrete release event and the cooldown is satisfiable. The
observation protocol in `specs/063-infra-image-version-pins/quickstart.md` (T014) confirms or
refutes this on the next `docker base images` PR — if `stability-days` is observed settling
unaided, criterion 1 should essentially never hold again and the whole rule collapses to **wait**.
(One residual: `docker:pinDigests` digest-only refreshes of a rebuilt tag can still reset the
clock; if that is observed keeping the group perpetually pending, record it on item #298's
successor rather than merging past silently.)

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

## 7. Accepted residuals — decided, not overlooked

Recorded from the 2026-08-30 latent-issue audit so the next reader knows each was *seen* and
*decided*, rather than rediscovering it as a suspected defect:

- **`engines.node: ">=22.13"` is a FLOOR, not a pin, and it stays one.** Every pin runs 24.x; the
  floor states compatibility, not reality. `check-toolchain-consistency.mjs` checks satisfaction,
  deliberately. Raise the floor only when a tool requires it — and note item #225's still-unenforced
  criterion that a pnpm bump re-checks it.
- **Node rides two Renovate groups.** Workflow `node-version` entries ride `ci actions`
  (github-actions manager); Dockerfile `FROM node` rides `docker base images`. A Node bump can
  therefore arrive as two PRs, and the pins already differ (24.19.0 workflows / 24.14.1 app
  Dockerfile / bare `24` in infra-image-scan.yml). Accepted **while the gate floor-checks** — none
  of this can merge unsafe. If Node drift ever bites for real, the fix is the nx/playwright/pnpm
  pattern: one group, one guard.
- **`runs-on: ubuntu-latest` is extracted** by the github-runners manager (15 refs). On act_runner
  the label maps to a runner-side container and a "bump" would be meaningless — if such a proposal
  ever appears, close it as not applicable (it is not a `lockFileMaintenance` PR; the §4 rule about
  hand-closing marks only that one label rejected, which is the intent here).
- **`npx --yes renovate@44` is major-pinned and Renovate cannot see it** — already documented in
  `renovate.yml` as a deliberate, reviewed residual with its own bump procedure. Not re-decided
  here.

The audit's *actionable* findings are items **#307** (floating/rotting merge-gating toolchains:
Rust, semgrep, cargo-audit, uv), **#308** (the #297 class in app Dockerfiles), and **#309**
(`renovate-config-validator` runs nowhere in CI). **#307 and #309 are now closed** — see §8 and §9.

Two residuals were *added* by #307 and are recorded here rather than left to be rediscovered:

- **`curl https://sh.rustup.rs | sh` remains an unversioned script piped to sh**, in three workflows
  and the toolchain image. This is item #307's criterion 5 met for uv and **not** met for rustup,
  deliberately. What that script installs is `rustup` (a bootstrapper), and the thing that decides
  which compiler runs — the toolchain — is now pinned by `rust-toolchain.toml`, so a change in
  rustup cannot change the compiler. The pinnable alternatives both cost more than they buy: the
  archive **binary** (`static.rust-lang.org/rustup/archive/<v>/x86_64-unknown-linux-gnu/rustup-init`)
  hard-codes the architecture, which would break a non-amd64 devcontainer build; the archive
  **script** path could not be verified from the dev container at all, because
  `static.rust-lang.org` is not on its egress allowlist — and shipping an unverified URL into four
  install sites is the trade this repository declines. Revisit if rustup itself is ever implicated.
- **`backend/mc-service/Dockerfile` still builds `FROM rust:alpine3.21@sha256:…`** — a version-LESS
  tag, so Renovate can only churn its digest and can never propose a classified update. Re-tagging
  it is a change under `backend/`, which is SDD-gated, so it is an accepted divergence recorded in
  `rust-toolchain.toml` and in the `rust toolchain` packageRule (item #307, criterion 1). A guard
  test asserts the toolchain group does **not** claim it — the failure that would matter is
  Renovate proposing a Rust *release* number as a *docker tag*.

## 8. Pinned toolchains and where each pin lives (item #307)

Item #303's principle, restated because #307 applied it four more times: **a floating reference
means no version, and no version means no classification and no reproducibility; a pin with nothing
maintaining it trades a floating reference for a rotting one.** So every pin below is (a) exact,
(b) the same at every site, and (c) tracked by something that will move it.

| tool | the pin lives in | sites | how Renovate sees it | grouped? |
| --- | --- | --- | --- | --- |
| **Rust** | `rust-toolchain.toml` (`channel`) | that file + the devcontainer's baked `--default-toolchain` | built-in **`rust-toolchain`** manager (depName `rust`, datasource `rust-version`) + a customManager for the devcontainer half | **yes** — `rust toolchain` |
| **semgrep** | `scripts/sast-scan.mjs` (`SEMGREP_PIN`) | one | customManager, `pypi` | no — one manager, one depName |
| **cargo-audit** | `guardrails.yml` (`--version`) and the toolchain image (`cargo-audit@X`) | two | customManager, `crate` | no — one manager, one depName |
| **uv** | the version string, at every site | 3 install-script URLs + 5 `setup-uv` inputs | customManager, `github-releases` | **yes** — `uv pin` |

> ⚠️ **Grouping is needed when a SECOND manager sees the other half — it is not a ritual for every
> custom manager.** The Trivy manager (§ item #303) covers two files with one depName and has no
> group, correctly: one dependency, one branch. nx (#141/#193), Playwright (#204) and pnpm (#225)
> each needed a group because the *built-in npm manager* claimed one half. Rust needs one because
> the built-in `rust-toolchain` manager claims one half; uv needs one because item #308's image
> refs will be claimed by the built-in **docker** manager under a *different depName and a
> different datasource*.

### Rust: the toolchain file is the single source, and rustup is told to defer to it

All three workflows install rustup with **`--default-toolchain none`**. The first `cargo` call
inside the repository then resolves the channel *and its components* from `rust-toolchain.toml` —
which is why `--component clippy` is no longer written in `app-ci.yml`. There is no `stable` literal
left in any workflow, and the guard test fails if one returns.

`rust-toolchain.toml` needs **no customManager**: renovate@44 ships a built-in `rust-toolchain`
manager (`managerFilePatterns` `/(^|/)rust-toolchain(\.toml)?$/`). Adding one would double-manage
the file — two depNames for one package, two branches, both editing the same line — the exact
reasoning `renovate.json` gives for *not* adding a regex manager over `pnpm-workspace.yaml`. The
devcontainer half does need one, because no built-in manager reads a Dockerfile `RUN` line; it emits
the **same** depName and datasource, which is what makes the two halves one dependency rather than
two that share a name.

### uv: the DECISION about its single source of truth (item #307 decides, #308 consumes)

**uv's single source of truth is ONE VERSION STRING, repeated at every site, held together by one
Renovate customManager plus the `uv pin` packageRule, and asserted equal across every site by
`renovate-workflow.guard.test.mjs`.**

It is deliberately **not** a file that every site reads. `astral-sh/setup-uv`'s `version:` input is
an Actions expression and cannot read a repository file, so a file would leave the five action sites
unpinned — the half-measure that produces exactly the drift being fixed. The nx / Playwright / pnpm
pins are the precedent for the shape: one string, many sites, one guard.

Two mechanical consequences worth knowing before editing a uv site:

- the install-script URL carries the version in its **path** — `https://astral.sh/uv/<version>/install.sh`
  — which also stops fetching the moving script (`astral.sh/uv/install.sh` was byte-for-byte the
  #303 Trivy shape). Verified: the versioned URL redirects to that release's own `uv-installer.sh`
  asset, which exists per release;
- each `setup-uv` input carries a **`# uv-version` marker**. Without it the manager's matchString
  would be a bare `version:` key and would claim any other `version:` input added to those workflows
  later.

**Item #308 consumes this decision**: the eight `ghcr.io/astral-sh/uv:latest@sha256:…` refs re-tag to
`ghcr.io/astral-sh/uv:<this version>`, and the `uv pin` rule already names that docker packageName —
so #308 is a re-tag, not a re-think, and the guard is wrong-and-loud rather than silently absent if
the re-tag ever arrives without it.

## 9. The config validator — what it catches that the guard test cannot (item #309)

Everything in §5 and every assertion in `renovate-workflow.guard.test.mjs` is **enumerative**: it
names a hazard that has already fired. The **unknown-key** class fires nothing. A major renaming a
key (v41: `fileMatch` → `managerFilePatterns`), or a typo in a new rule, does not error — the
config **silently manages nothing**, which is §5's mechanism in a new place.

`renovate-config-validator` catches exactly that class, and since item #309 it runs in **two**
places, both on the same `renovate@44` major the real run uses (the guard test asserts all three
references agree):

| where | catches | when |
| --- | --- | --- |
| `guardrails / renovate-config` — required by the `guardrails*` glob, **unconditional** | an EDIT to `renovate.json` | before it merges |
| a step in `renovate.yml`, before `Run Renovate` | a key deprecated by a renovate@44 **minor** — nothing in the repo changed, so no PR runs | at most a week later |

> ⚠️ **Both flags are load-bearing. Measured 2026-08-30 against this repository's own
> `renovate.json` on renovate@44.52.0:**
>
> | invocation | result |
> | --- | --- |
> | `renovate-config-validator renovate.json` | *"Validating as **global** config"*; `fileMatch` rename → WARN, **exit 0** — the mutation PASSES |
> | `… --strict --no-global renovate.json` | *"as **repo** config"*; same mutation → **exit 1** |
>
> Without `--no-global` the file is checked as a *global self-hosted* config, not as the repo config
> Renovate will read. Without `--strict` a needed migration is a warning, not a failure — green on
> precisely the class the check exists to catch.

**It is deliberately NOT path-gated**, and that reverses item #309's own recommendation. The
proposal assumed the ~240 MB npx pull was too heavy for every PR; measured, a **cold** run took
**27 s** wall-clock, in a workflow whose `naming` job already runs `pnpm install --frozen-lockfile`.
A path filter would have bought seconds and cost the property that matters — that a green board
means the validator *ran*. The guard test asserts the job carries no `if:` and no `needs:`.

The validator does **not** replace the guard test. They catch different things: the validator
catches a key Renovate does not know; the guard test catches a key it knows but **ignores where it
is written** (the `prPriority`-inside-`lockFileMaintenance` case, §5 and `renovate.json`'s own
comment).

## Related

- `renovate.json` — grouping, version locks, cooldowns, and the reasoning for each
- `.forgejo/workflows/guardrails.yml` — the `renovate-config` job (§9), the required config validator
- `rust-toolchain.toml` — the Rust pin (§8), read by renovate@44's built-in `rust-toolchain` manager
- `.forgejo/workflows/renovate.yml` — schedule, toolchains, dispatch inputs
- `scripts/__tests__/renovate-workflow.guard.test.mjs` — the assertions that keep the above true
- `scripts/renovate-health.mjs` / item **#311** — the weekly health digest: channel liveness, stale
  branches, budget consumption, `stability-days` states. Close item #311 to stop it.
- [CI self-serve diagnostics](ci-diagnostics.md) — reading a failure without log access
- [The agent-driven backlog](backlog.md) — item #29 and the `status/bot-managed` rule
