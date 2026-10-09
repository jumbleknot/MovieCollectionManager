# CI Self-Serve Diagnostics

**Feature 042.** Diagnose a CI failure without a human copy-pasting logs into the session.

The forge API exposes **no log, artifact, or per-run-jobs endpoint** — measured, and `swagger.v1.json`
confirms the absence is by design in this build. So this inverts the direction: **CI pushes a curated
digest into a channel the API can already read**, and `scripts/ci-status.mjs` reads it back.

**There is also no RE-RUN endpoint** — measured 2026-08-31, all three plausible shapes answer `404`:
`actions/runs/{id}/rerun`, `actions/tasks/{id}/rerun`, `actions/runs/{id}/rerun-failed-jobs`. Nothing
can re-run a job in place, and there is no way to re-run *one* failed job at all. Re-triggering means
producing a **new head sha** — `git commit --amend --no-edit` (same tree, new committer timestamp) plus
a force-push re-fires the whole `pull_request` run. Budget for the full suite, not for the one job that
failed, and read the digest first: on this runner a re-run costs ~35 minutes of capacity-1 time, so it
is worth spending only when the evidence says the failure is not about your diff.

> **No forge host literal, token, or SSH target belongs in this file** (topology-scrub rule). Every
> command below resolves the host from the `origin` remote at runtime.

---

## Quick reference

```bash
node scripts/ci-status.mjs status                      # HEAD — is this commit mergeable?
node scripts/ci-status.mjs status --sha <full-sha>     # a specific commit (full 40 chars)
node scripts/ci-status.mjs status --pr 82              # a pull request
node scripts/ci-status.mjs watch --pr 82               # poll until settled (required AND advisory)
node scripts/ci-status.mjs watch --pr 82 --required-only  # poll only until the MERGE question is answered
node scripts/ci-status.mjs failure --pr 82             # why did it fail?
node scripts/ci-status.mjs failure --pr 82 --full      # + fetch the full evidence bundle
node scripts/ci-status.mjs durations                   # how long does each app-e2e step take?
```

**Exit codes** — the `3` is the one that matters:

| Code | Meaning |
|---|---|
| `0` | Mergeable (or superseded — not a failure) |
| `1` | A **required** context genuinely failed |
| `2` | Bad arguments, missing token, or missing scope |
| `3` | Still waiting when `watch` timed out — **runner starvation, not failure** |

Exit `3` is deliberately distinct from `1`. There is one `kvm` runner; a poller that exits non-zero
on `pending` reports a saturated queue as a broken build.

**`watch` waits for ADVISORY contexts too, and that is not the same question as the exit code**
(item #403). `watch` is asked "has this commit settled"; its exit code answers "may I merge". Those
diverge precisely where it hurts: on 2026-09-09, PR #400 merged with 11/11 required contexts green,
and the push run's `app-ci / trigger-cd` then failed in 3s with
`ERR_MODULE_NOT_FOUND: Cannot find package 'yaml'`. Nothing blocked, `main` stayed green, and **the
CD dispatch simply did not happen** — found only because a human opened the run and read the
advisory row. Verifying the fix, `watch` again exited 0 while `trigger-cd` was still `pending`, and
confirming it needed a hand-rolled polling loop over that one context.

`trigger-cd` is advisory and is the *only* place a declined or failed deploy is visible
([the state table below](#the-four-states-that-are-reported-wrong) says so in its own right), so a
`watch` that returns before it reports has dropped the deploy outcome. Since item #403:

- `watch` keeps polling while **any** context is still running, advisory included. `--required-only`
  restores the narrower wait for a caller that genuinely only wants the merge answer.
- An advisory **failure** gets its own `⚠️ ADVISORY FAILURE` block immediately above the `VERDICT`
  line, naming each context and saying what the failure cost. The row was always in the table; what
  was missing was any reason to read it, because `VERDICT mergeable` two lines down is what gets read.
- **The exit code did not change, in either direction.** `exit 0 ⟺ mergeable` is load-bearing for a
  `ci-status … && merge` wrapper. In particular, an advisory context that never finishes before the
  timeout still returns the verdict's own code — it does *not* turn a mergeable commit into exit `3`
  — and `watch` says which context never reported instead of silently dropping it. A required
  context pending at the timeout is still exit `3`, unchanged.

> ⚠️ **A pipe throws the exit code away — including this one.** `ci-status … watch | tail -30` reports
> **`tail`'s** status, so exit `3` and exit `1` both arrive as `0`. Measured 2026-09-06: a watch that
> printed `still waiting after 5100s … (exit 3)` in its own output was recorded by the session as
> `WATCH_EXIT=0`, because the code came from the pipe. This is the same shape as the
> `node --test <file> --test-name-pattern` trap in CLAUDE.md — the natural-looking invocation quietly
> reports success. Redirect and read the file instead:
>
> ```bash
> node scripts/ci-status.mjs watch --pr 372 --timeout 5100 > /tmp/watch.log 2>&1; echo "EXIT=$?"
> ```
>
> `set -o pipefail` also works, but it is not on by default in these sessions and a `tail` that
> succeeds is not what you are asking about anyway. This is not a CI-specific trap — the general
> form, and why `grep` is worse than `tail`, is in
> [e2e-testing.md § The instrument traps that cost the most](e2e-testing.md).

**Exit `3` twice running is usually SERIALIZATION, not a dead runner — and merging is what causes
it.** A merge commit fires `app-e2e` on `main`, and with capacity 1 that run takes the runner ahead
of every open PR. Measured 2026-09-06: PR #370's `app-e2e` waited on `main`'s post-merge run from
PR #369, then PR #372's waited on `main`'s from PR #370. Both watches expired against a healthy
queue. Distinguish the two before re-triggering anything — a `running` row for your own branch means
wait, while recent rows for *other* branches with nothing for yours means starvation:

```bash
curl -s -H "Authorization: token $MCM_FORGE_TOKEN" \
  "$FORGE/api/v1/repos/jumbleknot/mcm/actions/tasks?limit=14" \
  | jq -r '(.workflow_runs // .)[] | "\(.status)|\(.name)|\(.head_branch)|\(.run_started_at)"'
```

Note `conclusion` is `null` even for successful tasks in this listing — read `status`, not
`conclusion`, or every green job reads as unfinished.

**`/actions/runs/{id}/jobs` does not exist in this build** (measured 2026-09-06 — it answers with a
non-JSON body, so a naive `| jq` dies on a parse error rather than a 404). There is no per-job
listing to drill into; `actions/tasks` above is the only queue view.

**A ⏳ that will not resolve looks exactly like one that will — and the honest answer is usually
"wait longer".** Both are the absence of a commit status being rendered as a state, and the
`actions/tasks` listing does NOT disambiguate them: a run that is queued but not yet DISPATCHED has
no task row at all, so "no row for my job" means *not yet*, not *never*.

This was gotten wrong expensively on 2026-09-18, and the mistake is worth more than the rule.
PRs #479 and #482 sat ⏳ on `app-e2e` and `infra-image-scan` through two watches (3000 s and
3300 s), each ending in the *correct* message — `still waiting … runner starvation, not failure`.
`actions/tasks` showed no row for either job. That absence was read as "path-gated out, never
scheduled, waiting is futile", a conclusion written up as a decision table and merged into this
runbook. **It was wrong.** The statuses resolved on their own at 11:08:59Z and 11:18:52Z, roughly
seven minutes after the check that declared them dead:

```
app-ci / app-e2e            pending  10:00:32Z
app-ci / app-e2e            pending  10:14:35Z
app-ci / app-e2e            SKIPPED  11:08:59Z   ← resolved on its own
infra-image-scan / …        SUCCESS  11:18:52Z
```

So: **the tool's starvation message was right and the reasoning that overrode it was wrong.** Two
lessons, in order of how much they cost:

- **Absence in a 50-row shared-queue window is not evidence.** `actions/tasks?limit=50` is capped
  and repo-wide; a busy period pushes your job out of it, and a queued-but-undispatched job was
  never in it. Use the listing to confirm what IS running, never to prove what is not.
- **A path-gated job does eventually SAY so.** It posts `skipped` (API `success`, description
  `"Has been skipped"`) once evaluated — see the state table below. If a context is genuinely gated
  out, you get that word; you do not get a permanent ⏳. So ⏳ means *not yet evaluated*, whatever
  the paths say.

The reliable check is the commit's own status history, which carries timestamps and is not a capped
window:

```bash
node --input-type=module -e "
const r=await fetch(process.env.FORGE+'/api/v1/repos/jumbleknot/mcm/commits/'+process.env.SHA+'/statuses?limit=50',
  {headers:{Authorization:'token '+process.env.MCM_FORGE_TOKEN}});
for(const s of await r.json()) console.log(s.context.padEnd(38), String(s.status).padEnd(8), s.created_at);
"
```

A context whose newest entry is `pending` is still coming. Compare its timestamp with the others: an
hour behind a green board on this capacity-1 runner is normal serialization, not a dead job.

---

## The four states that are reported wrong

Two of the five check states are **misreported by the raw API** and must be derived. Both wordings
below were **measured**, not guessed — an earlier version of this tool matched `/^skipped/i` because a
hand-authored fixture said `"Skipped"`, so a path-gated job rendered as `passed` and an operator would
have believed it ran. The forge says `"Has been skipped"` and `"Has been cancelled"`.

| State | What the API says | What it means | Failure mode if you get it wrong |
|---|---|---|---|
| `skipped` | `success`, description `"Has been skipped"` | did not run — **why** is not in the payload (see below) | Fails **safe** as a state; the *cause* label fails LOUD (item #396) |
| `waiting` | `pending` | queued behind the single runner | Fails **safe** — an unnecessary wait |
| `superseded` | **`failure`** | run cancelled by a newer push | Fails **LOUD** — announces a broken build that isn't |
| advisory | `failure` on a non-required context | `dast`, `prod-apk`, `trigger-cd` | Either a false "blocked", or a silently dropped regression |
| `cd-dispatch / trigger-cd` | `success` or `failure`, with the reason as the description | **not a CI result** — the deploy gate's own answer | Reading it as a check; it is the *only* place a declined deploy is visible |

### 🚨 A ⏳ is not a future pass — a context that has not reported has not committed to RUNNING

The table above gets each state right once it exists. The mistake is upstream of it: treating
`waiting` as *"it will run, and then it will pass"*. It is neither. A pending context can still
resolve to **`skipped`** (path-gated) or **`superseded`** (cancelled by a newer push), and both are
non-runs that a green board then presents as satisfied.

Item #568 tripped over this twice in one afternoon, in both directions:

- a second `app-e2e` execution was declared "in flight on main's head" and resolved **`skipped`** —
  the head was a docs-only merge, correctly path-gated out;
- the merge commit of the fix itself, and the commit after it, both resolved **`superseded`**.

Three candidate runs, three non-runs, and the verification everyone believed was coming never
happened. **Derive whether a job will run from the FILTER and the changed paths, never from its
spinner** — `app-ci.yml`'s `changes` job holds the answer, and it is deterministic:

```bash
git diff --name-only origin/main...HEAD   # then read the `app:` / `mobile:` filters in app-ci.yml
```

Worth knowing while reading them: `app` lists **named scripts, not `scripts/**`**, and the rule is
stated in place — a script that *deploys or configures* what the suite exercises belongs there, one
that only *reports* on the run does not. And `mobile` is a deliberate strict **subset** of `app`
(no `infrastructure-as-code/docker/**`, no lockfile), so a PR can run the whole web half while the
emulator half never fires; the `mobile-e2e` label is the opt-in.


### A skip does not say why it was skipped (item #396)

The payload carries the state, never the cause. `ci-status` used to annotate every skip
`(path-gated → satisfied)`, which reads as *"this diff does not warrant that job"* — and on PR #393
(2026-09-08) that was wrong on both counts. The commit touched `agents/**` and `mcp-servers/**`,
which **are** in app-ci's `changes` filter; `app-e2e` had been skipped because `affected`, which it
`needs:`, failed on one E501. Fixing the lint let `app-e2e` run, and it caught a real defect
(gateway → web-api-mcp returned 421). Had the label been believed, the conclusion would have been
"the agent layer does not trigger E2E at all" — false, alarming, and the end of the investigation.

The forge exposes no per-run-jobs endpoint, so the tool reads the `needs:` edges out of
`.forgejo/workflows/*.yml` in the current checkout and prints one of three sentences:

| Annotation | What it took to say it |
|---|---|
| `(path-gated → satisfied)` | the workflow parsed **and** every `needs:` of that job passed or was itself skipped — the job's own `if:`/path filter is the only remaining cause |
| `(NOT run — needs: X, which did not pass)` | the workflow declares the edge **and** `X`'s status on this same commit and event says it failed or was cancelled |
| `(skipped — cause not determined: …)` | the workflow could not be read or parsed, the job is not in it, or a dependency has not reported — the tool does not guess |

Only the label changed. A dependency-skipped required context still counts as satisfied for the
verdict, exactly as before: the merge is blocked by the **failed dependency itself**, which is the
truthful reason.

**`cd-dispatch / trigger-cd` is published by the deploy gate, not by a job.** `trigger-cd` is advisory,
so before item #230 a run that declined to dispatch and a run that deployed looked identical from
outside — which is how a merged commit went undeployed for a day. `scripts/cd-dispatch-gate.mjs` now
states its decision on the commit: `superseded — <sha> is the tip …` and `nothing deployable changed
since the last deploy` are `success` (correct non-deploys); a guardrails failure, an unfinished
guardrails run, or no guardrails at all are `failure` and also red the job.

**The superseded trap is the dangerous one.** On a real cancelled commit, **13 of 16 contexts read
`status: "failure"`** for a commit that was never broken. The tell: *every job dies together on a
change that could not have affected them all.* It is detected two independent ways — the status
description is literally `"Has been cancelled"`, and the owning run's `status` is `cancelled`. Either
alone suffices, so a UI wording change cannot silently turn it back into `failed`.

### `ci-status.mjs` must stay dependency-free — `trigger-cd` runs it with no `node_modules`

`app-ci / trigger-cd` runs `scripts/cd-dispatch-gate.mjs`, which imports `ci-status.mjs` to reuse its
check classification rather than re-deriving it. That job checks out the repo and runs node
**directly**: there is no `pnpm install` step. So every module reachable from the gate may import
node builtins and repo-local files, and nothing else.

Measured 2026-09-09, on the merge of PR #400. Item #396's needs-graph was implemented with
`import { parse } from 'yaml'` — a devDependency, so every local test passed — and `trigger-cd` then
died on `main`:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml' imported from …/scripts/ci-status.mjs
```

**The reason this is worth a runbook entry rather than a memory:** `trigger-cd` is *advisory*. The PR
merged green, `main` stayed green, no required context moved — and the CD dispatch simply did not
happen. A real break that blocks nothing and announces itself nowhere is only found by someone
reading the advisory row on purpose.

The fix is not to add an install step to `trigger-cd`; it is to keep the graph dependency-free. The
`needs:` extraction is hand-rolled for exactly this reason, and two tests hold the line: one walks the
import graph from `cd-dispatch-gate.mjs` and fails on any bare specifier, and one cross-checks the
hand parser against the real `yaml` package over every workflow in `.forgejo/workflows/` — so
"small enough to hand-roll" stays measured rather than assumed.

Reproduce the CI condition locally by copying `scripts/*.mjs` somewhere with no `node_modules`
anywhere up the tree, then `node -e "import('./cd-dispatch-gate.mjs')"`.

### "Every job died together" has a SECOND cause — the install step

The superseded tell above (*every job dies on a change that could not have affected them all*) is not
unique to cancellation. A broken `pnpm install` produces the identical shape: every job that installs
dependencies goes red, including ones with no relationship to the diff.

Measured 2026-08-28 on PR #263 — `affected`, `mc-service-checks`, `naming`, `okf`, `agent-gates` and
`sast` all failed, plus advisory `dast`, on a one-line `@ag-ui/client` bump. The cause was a
supply-chain policy rejecting a transitive published 1.7 hours earlier, at
`step:<job>-install-js-dependencies`. Nothing was wrong with the change.

**So when the whole board goes red: check `status` for `cancelled` FIRST, then open any one failing
job's digest and look at which STEP failed.** If it is the install step, the other five digests will
say the same thing and reading them is wasted effort. See
[the Renovate runbook](renovate.md) for the cooldown/transitive interaction behind this one.

### Ask the right diff question — two-dot, not three-dot

When deciding whether a branch still contributes anything over `main`:

```bash
git diff main branch      # ✅ what the trees actually differ by
git diff main...branch    # ❌ what the branch adds since the MERGE BASE
```

The three-dot form happily lists changes `main` already has by another route, so a fully-superseded
branch still looks like it carries work. Measured on PR #262: three-dot said "three version moves
remain unique to this PR"; two-dot showed merging it would have **downgraded** crates, and Renovate
autoclosed it as satisfied minutes later.

### `--run N` resolves the run's own commit — and a confident negative is the class to remember (item #226)

`--run N` resolves the run's own commit and fetches its bundle. Until 2026-09-01 it did **nothing at
all**: the flag was parsed and read by no code path, so `resolveSha` fell through to
`git rev-parse HEAD` and the tool answered about your working copy.

```bash
node scripts/ci-status.mjs failure --run 2477        # ✅ resolves that run's commit, prints its digest
```

**That failure mode is the one to remember, because the class recurs.** It answered
"No failed jobs on this commit" — a *confident negative*, not an error — which reads as "CI is fine"
mid-triage. It cost a wrong conclusion on 2026-09-01: run 2477's digest was reported as never
published when it existed the whole time. The empty-result message now names the commit it examined
(`No failed jobs on 99892b0e — checked every event's contexts`) precisely so a wrong target is
visible in the answer itself.

`watch --branch main` still has the original shape — it reports on whatever `main` resolves to
locally, which can be several merges stale. **Prefer `--pr N` or `--sha $(git rev-parse <ref>)`.** An
abbreviated sha is refused outright, which is the tool behaving well — the forge's `head_sha` filter is
exact-match, so a short sha would return zero runs and look like "no CI ran".

### `app-e2e` is SKIPPED on most pull requests — the board hides its true failure rate

`app-e2e` is path-gated on `changes.outputs.app`. A PR touching only `scripts/`, `docs/` or
`openwiki/` renders it `skipped → satisfied` and the board goes green **without the E2E suite ever
running**. That is correct behaviour, and it makes the suite's reliability invisible from the board.

**Measured 2026-09-02.** Of eleven recent `app-ci` runs that looked like a clean green streak, only
**three** had actually executed `app-e2e`; the rest were path-gated skips. Two readings of the same
board therefore both look true — "a long history of green CI" and "roughly a quarter of runs that
run the suite fail" — and a PR that *does* touch an app path then looks like it introduced a
regression when it merely exercised something the streak never did.

**Before concluding that a change destabilised CI, isolate runs that actually RAN the job**, and
isolate the specific failure. The description distinguishes them without opening anything:

```bash
curl -sS -H "Authorization: token $TOKEN" "$API/commits/<sha>/status" \
  | jq -r '.statuses[] | select(.context|test("app-e2e")) | .status + " :: " + .description'
#   success :: Has been skipped        <- did NOT run; proves nothing about the suite
#   success :: Successful in 28m40s    <- ran
#   failure :: Failing after 12m43s    <- ran and failed
```

> ⚠️ **An all-history failure percentage is NOT evidence about recent stability.** It spans months
> including known-broken periods and does not isolate the failure class in question. Both errors were
> made in one session: a 2-run sample read as "coin flip", then a 641-run baseline offered as the
> correction. Neither answered the actual question, which is narrow — *among recent runs that ran
> `app-e2e`, how many failed in THIS way?* Use the right data, not merely more of it.

### The event-suffix rule

Context strings carry an event suffix, and **the same job appears once per event with outcomes that
can disagree**:

```text
guardrails / secret-scan     push=success   pull_request=failure
```

A required-context glob like `guardrails*` matches **both**. That cuts two ways, and the tool has now
been wrong in each direction:

- **Ignoring the event over-reports failure.** A roll-up that lumps the two together reports failure
  for a commit whose push run was entirely green (measured 2026-07-19, on a superseded commit).
- **Selecting one event over-reports SUCCESS**, which is the dangerous direction. `ci-status` used to
  filter the whole verdict to one event, so a required job that failed on `push` while its
  `pull_request` twin was path-gated to a 2 s skip produced `VERDICT mergeable` and exit 0 — and
  `POST /pulls/{n}/merge` answered **405**. Four occurrences: PRs #276, #302 and #263, plus two
  dependency PRs blocked the same day as #276.

**Since item #281 the two concerns are separated.** The **verdict** is whole-commit — it evaluates
every context the globs match, exactly as branch protection does. The **view** is still one event,
chosen by `--pr`/`--event`, so the check table stays readable. When a context gates the merge but
is not in the view, it is named explicitly rather than left to be inferred:

```text
ALSO GATING (other events — every branch-protection glob ends in `*`, so it matches these too)
  ✗ infra-image-scan / infra-image-scan (push)  failed
  ↳ absent from the table above because the view is scoped to one event, while branch
    protection evaluates the whole commit. THIS is what makes a merge 405 on a green PR.
```

Selecting one event is safe for the verdict only because superseding is handled a layer earlier:
`classifyCheckState` maps a cancelled context to `superseded`, never `failed`, so the 2026-07-19 case
cannot come back through the whole-commit gate. `--selftest` pins the over-reporting direction.

`--event` therefore only chooses which event's table you read. It is not needed to see why a
green-looking PR's merge was refused (before item #281 it was the documented workaround) — the default
verdict already sees it.

### A scheduled run reports `event: push` — the trigger is in a DIFFERENT field (item #418)

`GET /actions/runs` returns **two** event fields per run, and they disagree on every cron run:

| field | value on a weekly cron run | what it actually is |
|---|---|---|
| `trigger_event` | `schedule` | what fired the run |
| `event` | `push` | the class of the **synthesized payload** |

Measured 2026-09-12 across **all 68** scheduled runs since 2026-07-31: `trigger_event` is `schedule`
for every one, `event` is `push` for every one. There is no counter-example, and the `ScheduleID`
(non-zero only on a cron run) agrees with `trigger_event` throughout — it **is** present in the
listing, not only on the run-detail endpoint.

**`github.event_name` inside the job follows `trigger_event`.** A step gated
`if: github.event_name == 'schedule'` DOES run on the weekly cron. Item #418 read `event`, saw
`push`, and concluded the repository's only allowlist-expiry check had never once executed; the step
had in fact been running weekly since the Friday after it was added, and had gone red for three
consecutive weeks. Nothing was broken. **Do not "fix" a `== 'schedule'` gate from the `event` field.**

`ci-status.mjs` filters `--event` on `event`, not `trigger_event`, and that is **correct for its
purpose**: the commit-status context suffix (`… (push)`) is derived from the same `event` field, so a
cron run's statuses really do land in the `push` view. The two fields answer different questions —
`event` is "which context bucket", `trigger_event` is "what fired it".

To list scheduled runs, filter on `ScheduleID !== 0` or `trigger_event === 'schedule'`:

```js
const runs = (await api(`/repos/${owner}/${repo}/actions/runs?page=1&limit=50`)).workflow_runs;
runs.filter((r) => r.ScheduleID).map((r) => [r.id, r.created, r.workflow_id, r.trigger_event]);
```

### A scheduled run posts NO commit status — so "no failed jobs" is not "healthy" (item #485)

A `schedule`-triggered run posts **no `<workflow> / <job>` commit status at all**. Its red is visible
only in the runs listing, the job log and the evidence bundle. Nothing attached to the commit says
`main` is failing. Measured across three scheduled `infra-image-scan` runs whose own API status is
`failure`:

| run | date | sha | infra contexts on that sha |
|---|---|---|---|
| 1948 | 2026-08-21 | `7a9ff92c` | *(none)* |
| 2132 | 2026-08-28 | `b3c77867` | *(none)* |
| 3521 | 2026-09-18 | `3cbe637e` | only `infra-image-scan/expiry`, which the job posts **itself** by curl |

The endpoint is not the problem — `3cbe637e` carries 40 statuses from the previous day's push.

**What this produced until 2026-09-19.** `failure --run <id>` reads *contexts*, found none, and answered:

```
$ node scripts/ci-status.mjs failure --run 3521
No failed jobs on 3cbe637e — checked every event's contexts.     # exit 0
```

Not wrong about what it read, and the opposite of the truth. "Checked every event's contexts" reads
as thoroughness, which is what made it a false negative rather than a shrug. **Fixed 2026-09-19** —
the run's own status is now carried through from the `--run` lookup, so the same command answers:

```
⚠ Run 3521 is FAILED (status=failure conclusion=<unset>) but posted NO commit status …   # exit 1
```

> **`status` carries the terminal verdict on this forge; `conclusion` is `undefined` on every run
> measured.** A reader that consults only `conclusion` sees nothing. `ci-status.mjs` reads both.

A red scheduled sweep is now also visible **on the commit**: `infra-image-scan.yml` posts an
`infra-image-scan/weekly` status carrying a real `success`/`failure`. It cannot gate anything —
branch protection requires the glob `infra-image-scan / infra-image-scan*` and this context has no
` / ` separator, the same reason `infra-image-scan/expiry` never has — and protection is evaluated on
PR heads, while this posts only on the scheduled run's own commit.

### Four measured quirks of `GET /actions/runs` (2026-09-19)

Three of the four read as success while returning the wrong thing, which is why they are listed
together. Forgejo `15.0.3+gitea-1.22.0`:

| query | result |
|---|---|
| `?limit=3` **alone** | **IGNORED** — returned all 3614 runs (371 KB). `limit` takes effect only when paired with `page`. |
| `?trigger_event=schedule` | **SILENTLY IGNORED** — returned the **unfiltered** set, 3614 runs across every workflow. Same shape as the unknown-label trap: a filter that does nothing reads as "matched everything". Filter `trigger_event` **client-side**. |
| `?workflow_id=<file>` | **Works** — a real server-side filter. The value is the workflow **file name**, e.g. `infra-image-scan.yml`. |
| `/actions/workflows/<file>/runs` | **404** — the endpoint does not exist on this build. |

So the query that actually works is:

```bash
# the newest SCHEDULED run of one workflow: filter workflow_id on the server, trigger_event locally
curl -s -H "Authorization: token $MCM_FORGE_TOKEN" \
  "$FORGE/api/v1/repos/$OWNER/$REPO/actions/runs?workflow_id=infra-image-scan.yml&page=1&limit=50" \
  | jq '[.workflow_runs[] | select(.trigger_event=="schedule")][0] | {id, status, started, commit_sha}'
```

`limit=50` is measured as enough to reach the most recent scheduled sweep past a week of PR runs
(run 3521 sat one page deep on 2026-09-19). Treat "not found in the page" as **unknown**, never as a
pass.

#### A FIFTH quirk: a queued run's `started` is the EPOCH, so any time filter hides it

Measured 2026-09-26. A run with `status: waiting` reports:

```json
{ "id": 3995, "status": "waiting", "prettyref": "#559", "started": "1970-01-01T00:00:00Z" }
```

Not `null` — the **epoch**. So the natural narrowing filter silently drops every queued run:

```bash
jq '.workflow_runs[] | select(.started > "2026-09-25T23:20")'   # ← waiting runs VANISH
```

Three runs had been created for a push and all three were invisible, which reads exactly like "the push
triggered nothing". This is the `/actions/tasks` trap in a new place: filter on `status` or `id`, and
read `started` only **after** you know the run has begun. A sort by `Date.parse(started)` is safe (a
queued run sorts oldest and so is never picked as "newest"), but a *filter* on it is not.

### A bundle is named after the JOB, which is not always the tail of the context (item #563)

Evidence bundles are versioned `<runId>--<jobName>`. Two shapes of context reach a commit here and they
nest **differently**:

| context | shape | bundle-owning job |
|---|---|---|
| `guardrails / naming` | a real Actions check, `<workflow> / <job>` **with spaces** | the **tail** — `naming` |
| `infra-image-scan/weekly` | a narrow status a job posts about **itself** by curl (items #418, #485) | the **head** — `infra-image-scan` |

The narrow ones carry **no ` / `** deliberately: branch protection requires
`infra-image-scan / infra-image-scan*`, and a separator-less context cannot match it, which is the only
reason posting them is safe. So the tail is a **label** (`weekly`, `expiry`, `mode`), not a job.

Deriving the job with `context.split('/').pop()` is therefore right for one shape and wrong for the
other, and the wrong answer is not a blank — it is a confident sentence:

```
$ node scripts/ci-status.mjs failure --run 3946
no bundle exists for 3946--weekly — the job may have died before the digest step ran.
```

The bundle existed the whole time as `ci-failures:3946--infra-image-scan`, on the one run that was
telling you `main` was failing a required gate. `bundleJobName()` now handles both shapes. **List the
package registry before believing a bundle is absent:**

```bash
curl -s -H "Authorization: token $MCM_FORGE_TOKEN" \
  "$FORGE/api/v1/packages/$OWNER?type=generic&q=ci-failures&limit=50" | jq -r '.[] | .version'
```

### An abbreviated sha returns `[]`, which reads as "no CI ran"

`ci-status.mjs` refuses a short sha outright, and that guard is why it is worth naming what happens when
you go around it. Querying the statuses endpoint with a **padded** sha — one abbreviated in a
`git log --oneline` and then typed out to 40 characters — answers:

```
GET /commits/db5de155cf20c3ebd0e3b0b9a68a3b96e1e0b94e/statuses   →  []
GET /commits/db5de155cf20c3ebd0e3b0b9a68a3b96e1e0b94e/status     →  { "state": "", "statuses": [] }
```

An empty array for a commit that does not exist, indistinguishable from a commit with no checks. Paid
for on 2026-09-26, minutes after reading the guard that exists to prevent it. Always
`git rev-parse <ref>`; `git cat-file -t <sha>` is the one-command check that the sha is real at all.

### Where the REQUIRED set comes from (do not hand-maintain it)

The required globs are read **live** from `GET /repos/{owner}/{repo}/branch_protections` for the
target's base branch (a PR is gated by its base, not its head). The header line names the source:

```text
REQUIRED  (from branch protection for `main`)
REQUIRED  ⚠ could not read branch protection (…) — using the built-in list, which may be stale
```

**Why it is fetched rather than listed.** It used to be a hardcoded array, and it drifted. Feature
035 added `infra-image-scan / infra-image-scan*` to branch protection; the array kept five globs. On
2026-07-26 `ci-status` printed `VERDICT mergeable` and exit 0 for PR #103 while
`POST /pulls/103/merge` answered **405 "Not all required status checks successful"** — the sixth
check was still pending and the tool had classified it as advisory. That direction of error is the
dangerous one: it **over-reports** mergeable, so a `ci-status status && merge` wrapper calls a merge
that cannot succeed.

Consequences worth knowing:

- The endpoint is **repository-scoped** — both `MCM_FORGE_TOKEN` and the `git credential fill`
  credential return **200**. (Contrast `issues/{n}` → 403 and packages → 401 on the latter.)
- A fetch failure **degrades, it does not abort** — a verdict from a possibly-stale list beats no
  verdict — but the `⚠` line always says so. If you see it, treat the verdict as advisory and
  confirm against the forge before merging.
- `parseRequiredGlobs` returns **null**, never `[]`, when no rule covers the branch. An empty
  required set would mark every context optional and render *everything* mergeable — the same
  over-reporting bug in a louder disguise.
- `infra-image-scan / infra-image-scan` takes **~8 min** on a PR and is usually the last required
  check to settle, so it is the common reason a PR that "looks green" still 405s.

---

## Why a lookup is fast (and how to keep it that way)

**These are correctness rules, not optimizations** — the wrong query returns **12.4 MB where the
right one returns 15 KB**, and that ~800× payload difference is a property of the API, independent of
how fast the link happens to be:

| Query | Honoured? | Payload | Time (2026-07-18) |
|---|---|---|---|
| `?head_sha=<full-sha>` | ✅ true server-side filter | **15 KB** | 0.48 s |
| `?page=N&limit=M` | ✅ | 82 KB | 1.2 s |
| `?limit=N` **alone** | ❌ **silently ignored** | **12.4 MB** | 94 s |
| `?status=` `?event=` `?branch=` | ❌ silently ignored | **12.4 MB** | 94 s |

**On those timings:** they were measured while the homelab's tailnet **transmit** was throttled to
~135 KB/s by a Tailscale tun segmentation-offload bug — fixed 2026-07-25, link now ~85 MB/s (see
[prod-reboot-resilience.md](prod-reboot-resilience.md) Part 1a). Real times are now far lower and the
100× latency gap has largely closed, **but the rule is unchanged**: 12.4 MB still has to be
transferred, parsed, and held, and the payload column is the durable reason to query by `head_sha`.

An abbreviated sha is **rejected**: `head_sha` is exact-match, so a short sha returns zero runs and
reads as "no CI ran". Use `git rev-parse`.

Raw payloads are cached to disk and referenced by path — they never reach the conversation.

---

## Token provisioning

Two tokens, each doing exactly one job. Neither value ever enters git.

### Read side — `MCM_FORGE_TOKEN`

Scopes: **`read:repository` + `read:issue` + `read:package`**.

Set on the Windows host and passed through by `devcontainer.json` via `${localEnv}`, exactly like
`ANTHROPIC_API_KEY`:

```powershell
setx MCM_FORGE_TOKEN "<token>"
```

> ⚠️ **`setx` only affects newly-launched processes.** VS Code must be **fully quit** — not reloaded —
> before the container rebuild, or `${localEnv}` resolves to empty and the token silently isn't there.

**It deliberately does NOT reuse the `git credential fill` credential.** That one is write-capable yet
*repository-scoped only*: it returns **403 on `issues/{n}/comments`** and **401 `reqPackageAccess`** on
the package registry, so it can read neither a digest nor a bundle. This is granular scope, not
expiry — the same token 200s on `actions/runs` in the same second. The dedicated token is strictly
*less* privilege while reaching more of what is needed.

### Write side — `CI_DIGEST_TOKEN`

Scopes: **`write:issue` + `write:package` + `read:repository`**. Stored as a **Forgejo Actions
secret**, never in git.

Deliberately **not** `CD_PUSH_TOKEN` — that is a whitelisted-user PAT able to push protected `main`,
and spreading it across ~20 jobs to publish diagnostics would be a real privilege expansion.

Not the run-provisioned `GITHUB_TOKEN` either, for the primary channel: it cannot write issues or
packages. It **can** write commit statuses, which is why the degraded fallback below uses it — measured
by a temporary probe on guardrails run #1627 (feature 051 T034), which left a real `probe-051-t034`
status behind via `POST /repos/{owner}/{repo}/statuses/{sha}`. The pre-receive hook does not decline
it: that hook governs **git pushes**, not **API writes** (an earlier version of this section conflated
the two).

**Missing scopes fail loudly, naming the scope.** A bare `401`/`403` is indistinguishable from an
expired credential and cost this design a full revision cycle to diagnose.

### When `CI_DIGEST_TOKEN` is empty — the degraded fallback

`CI_DIGEST_TOKEN` is an Actions secret, so it is blank **exactly when a run is most confusing**. On
the AGit-headed run of 2026-08-01 every `${{ secrets.* }}` arrived empty; the digest collected its
evidence, could not publish it, printed it to a job log the forge API cannot serve, and exited 0.
Zero comments, no error, no signal.

The digest now falls back:

| `CI_DIGEST_TOKEN` | Channel | Outcome recorded |
|---|---|---|
| present | PR comment (on `pull_request`) + evidence bundle | `published` |
| **empty**, run token present | **commit status** `ci-digest/<job>` carrying the failing step and a short excerpt | `published`, **`degraded: true`** |
| both empty | nothing publishable | `failed:no-credential` |

**Why the degraded case is `published` and not `failed`.** `contracts/digest-outcome.md` literally
says the fallback records `failed:no-credential`. That wording would make *published* and *failed*
simultaneously true and break the outcome vocabulary, in which `failed` means the evidence did **not**
reach a channel. The reader's question is "did the diagnosis get to me?" — via the fallback the answer
is yes, in a reduced form. So both facts are carried rather than collapsed: `published` with
`degraded: true`, and a summary naming the missing credential. A deliberate deviation from the
contract's wording, not an oversight.

**What the fallback deliberately does not do.** It publishes no bundle and no PR comment — the run
token has neither `write:package` nor `write:issue`. It carries the failing step's **name** plus a
truncated excerpt: enough to name the fault, not to replay the build. Truncation never splits a
`<redacted-…>` placeholder, because half a redaction still *looks* redacted while a future
value-wrapping placeholder would leak its tail.

> ⚠️ **Residual, stated because it is the half that matters.** T034 proved the run token *can* write
> statuses. It did **not** prove the token is *populated* on a secretless run — that run had secrets.
> `github.token` is runner-provisioned rather than an Actions secret, so it ought to survive where
> `secrets.*` do not, but "ought to" is not a measurement, and proving it needs an AGit-headed push,
> which [CLAUDE.md](../../CLAUDE.md) forbids. If a future secretless run still publishes nothing, this
> is the first thing to check.

---

## Reading a PASSING run's counts

**A green `app-e2e` now publishes its counts.** Feature 054 (item #167) made the publication gate
three-way: a cancelled run publishes nothing, a failure publishes the full digest, and an **explicit
success** publishes a small *counts-only* bundle — the `[e2e-gate]` line, the `[e2e-contention]`
tally, and the `[e2e-turns]` verdict — with no PR comment.

**And it NAMES what it counted (item #568).** The counts alone were not enough: run 4033 was green
with `flaky=1`, and which test had needed its retry was unrecoverable — counts mode collects only the
three tally logs, the bundle's own manifest records *"playwright report — not present"*, and this
forge build **404s `/actions/runs/{id}/jobs`**, so the dot-reporter output survived nowhere a session
could reach. `[e2e-gate]` now prints the identities of the flaky, skipped and did-not-run tests under
the counts line, and says so explicitly when a section header outnumbers the identities beneath it
(a truncated log, where taking the list as complete is worse than printing nothing). Naming a flaky
test never changes the verdict — it passed on retry.

So on a green run, read the `[e2e-gate]` block and not just its first line. If you find yourself
wanting to re-run a green job to find out *which* test was flaky, that answer is already in the
bundle.

⚠️ **Use `MCM_FORGE_TOKEN` for packages.** The `git credential fill` credential — the one that opens
pull requests — returns an **empty package list** rather than a 403, which reads as "no bundle was
published" for a bundle that exists. Measured 2026-08-12: the same query returned 0 versions with one
token and 50 with the other, seconds apart.

```bash
# LIST the versions. Never construct the name: `run_number` in /actions/tasks is OFFSET from the
# run id the bundle is named after, so a constructed name reads as "no bundle" for a bundle that
# exists.
curl -s -H "Authorization: token $MCM_FORGE_TOKEN" \
  "$FORGE/api/v1/packages/$OWNER?type=generic&q=ci-failures&page=1&limit=50" | jq -r '.[].version'
```

Three things worth knowing before you rely on it:

- **It is gated on an EXPLICIT `success`**, not on "anything that is not a failure". A job that loses
  `CI_DIGEST_JOB_STATUS` publishes nothing at all. That asymmetry is deliberate: the looser rule would
  resurrect the bug where a dropped env var published a spurious digest on a green run.
- **It is self-limiting to `app-e2e`**, by construction rather than by a job allowlist. Counts mode
  collects only the `e2e-result-gate`, `e2e-contention-tally` and `e2e-turn-tally` step logs; every
  other job has none, publishes nothing, and says so in its log. An allowlist would be a second place
  to forget to update.
- **It needs `CI_DIGEST_TOKEN`.** The run-provisioned token can only write a commit status, which
  cannot carry these lines. On that path the counts still reach the job log, which a human can read in
  the browser — narrowed, not lost.

Retention applies here too, and had to be added rather than inherited: pruning previously ran only on
the digest path, which was safe while the channel fired only on failures. A channel that fires on
every green run needs it, so the counts publish prunes as well.

⚠️ **The same credential split hits the CONTAINER REGISTRY, and it lies in the other direction.**
`docker manifest inspect <forge>/…/mcm-devcontainer:<sha>` answers **`no such manifest`** when the
CLI is not logged in — not `unauthorized`. That reads as "the image was never published" for an
image that is sitting right there, which is precisely the wrong conclusion to draw about a build you
have just dispatched. Measured 2026-08-22: the identical command gave `no such manifest` for a tag
whose image was **already pulled and listed in `docker images` locally**.

**Always run the control first** — inspect a tag you KNOW exists. If that also reports missing, the
instrument is unauthenticated and you have learned nothing about the tag you care about. `curl`
against the registry API is the reliable probe, and `MCM_FORGE_TOKEN` is the credential that works
(the `git credential fill` one returns **401** here — a third scope behaviour on the same forge):

```bash
ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
curl -sS -o /dev/null -w 'HTTP %{http_code}  digest=%header{docker-content-digest}\n' \
  -u "$OWNER:$MCM_FORGE_TOKEN" -H "Accept: $ACCEPT" \
  "$FORGE/v2/$OWNER/mcm-devcontainer/manifests/$SHA"
```

**To prove WHAT is in a published image without pulling 14 GB**, walk index -> amd64 manifest ->
config blob and read its `history[].created_by`. That is how the `pwsh` layer was confirmed present
in the CI-built image (and how you check the image did not accidentally end as `USER root`):

```bash
node -e 'const j=require("./config.json");
  console.log(j.history.map(h=>h.created_by||"").filter(c=>/pwsh/i.test(c)).join("\n"), j.config.User)'
```

**What a green run still does not tell you.** `flaky > 0` does not fail the build — #167 declines to
propose that deliberately, because one transient blip blocking a merge is a policy change that should
be decided on this data rather than ahead of it. Read the number; do not assume the gate acted on it.

### A GREEN job that is not `app-e2e` emits nothing — record the measurement as a commit status

The bullet above ("self-limiting to `app-e2e`, by construction") has a consequence worth stating
outright, because it cost item #457 a close: **every other job's green publication finds nothing and
uploads nothing.** Measured verbatim in `cd-deploy` run 3430's `Publish failure digest` step:

```
[ci-failure-digest] digest-outcome=not-needed — no digest was needed — the job passed and produced
                    no counts sources
[ci-failure-digest] counts mode — this job runs no e2e counts steps; nothing to publish.
```

So for any job but `app-e2e`, a **green run leaves no machine-readable trace of what its steps
printed**. Every other route is closed too — measured against run 3430:

| route | result |
|---|---|
| commit statuses on the run's sha | **zero rows** — `cd-deploy` posts none of its own |
| `/actions/runs/3430/jobs` | **404** (item #268) |
| `/actions/runs/3430/logs` | **404** |
| `ci-failures` bundles | across all **274** published versions, the only `prod-apk` one is `3409--prod-apk` — a **failure** |

Note what that last row means: `prod-apk`'s output has only ever been readable **because the job
failed**. A step that succeeds at doing nothing leaves no trace at all. That is the same blindness as
the `[skip ci]` and advisory-green classes — *a green tick is not evidence that a step did its job* —
and it is why item #457 could confirm its fix had **shipped** but not that its output had **appeared**.

**The pattern that closes it** (items #418, #268, #485, and now #457): have the step export its
measurement to `$GITHUB_OUTPUT`, and add a tiny recorder that `curl`s it onto the commit as a status.

```yaml
- name: Report disk space (…)
  id: disk
  run: |
    …
    avail_gb=$(df -P -k / | awk 'NR==2 { printf "%.0f", $4/1048576 }')
    echo "avail_gb=${avail_gb}" >> "$GITHUB_OUTPUT"

- name: 'Publish prod-apk disk measurement (items #457, #418)'
  if: ${{ always() && github.event_name != 'pull_request' }}
  continue-on-error: true
  env:
    GITHUB_TOKEN: ${{ github.token }}
    MEASURED_AVAIL_GB: ${{ steps.disk.outputs.avail_gb }}
  run: |
    desc="reclaimed=none avail=${MEASURED_AVAIL_GB:-<unset>}G …"
    curl -fsS -X POST -H "Authorization: token $GITHUB_TOKEN" -H 'Content-Type: application/json' \
      "${GITHUB_SERVER_URL}/api/v1/repos/${GITHUB_REPOSITORY}/statuses/${GITHUB_SHA}" \
      -d "{\"context\":\"cd-deploy/prod-apk-disk\",\"state\":\"success\",\"description\":\"$desc\"}"
```

Read it back with `GET /repos/{owner}/{repo}/commits/{sha}/status`. Five properties are load-bearing:

- **`always()`**, so a *failed* run still leaves the record — that is when it matters most. A recorder
  gated on the thing it measures records nothing on exactly the run you needed it for (item #418).
- **`continue-on-error`** and `-f` on curl: this is bookkeeping, never a second gate. If the POST
  fails, the job's own conclusion is already the truth and the status's **absence** is its own tell.
- **`state` is always `success`**, with the finding in the description. A red on `main`'s tip is a
  signal a bookkeeping step has no standing to raise.
- **Values are carried through RAW**, `<unset>` included. `<unset>` is a real answer — it says the
  runner returned no value for that context, which is a different fault from returning a wrong one.
- **The context name must match no required glob.** Check it against the real list, do not reason
  about it:

  ```bash
  curl -s -H "Authorization: token $MCM_FORGE_TOKEN" "$API/branch_protections" \
    | jq -r '.[].status_check_contexts[]'
  # 2026-09-19 → guardrails*  app-ci / changes*  app-ci / affected*
  #              app-ci / mc-service-checks*  app-ci / app-e2e*  infra-image-scan / infra-image-scan*
  ```

  ⚠️ **"A context without a ` / ` separator cannot gate" is NOT the rule** — `guardrails*` has no
  separator and gates everything it prefixes. The separator argument happens to hold for
  `infra-image-scan/expiry` and `infra-image-scan/weekly`; it is not general.
  `scripts/__tests__/prod-apk-disk-step.guard.test.mjs` pins the check against the measured glob list.

## Why CI still judges its own counts

The digest publishes **on failure**. That is right for diagnosis and wrong for verification: on a
green run there is nowhere to read `skipped=` from, and `ci-status`/`/actions/tasks` only ever report
the job's exit status. Combined with the fact that **Playwright exits 0 with tests skipped**, a green
`app-e2e` carried no information about how many tests actually ran. Feature 040 validated green with
33 specs skipped on exactly this blind spot (item #150).

Two consequences for anyone verifying a branch here:

- **Do not quote counts you have not read.** If a run is green there is no bundle, so `failed=` /
  `flaky=` / `passed=` are not available to you. Say what the gate asserts, not what you assume it
  would have printed.
- **The assertion lives in the job**, as the `E2E result gate` step
  (`node scripts/e2e-failure-set.mjs gate …`), which fails on `skipped > 0`, `did not run > 0`, or a
  log with no summary. So a green `app-e2e` now *does* mean "nothing hidden" — but still not "nothing
  needed a retry", because `flaky` is only visible in a bundle, and a bundle only exists on failure.

**There are now two such gates, for the same reason.** The second is the `Contention gate`
(`scripts/e2e-contention-tally.sh --gate`), which fails `app-e2e` on `refresh_429 > 0` or
`session_evicted > 0`. Feature 052's own SC-007 asked for its contention tally to be readable on
passing runs and could not be satisfied as written — measured on runs 1622/1623, both green, whose
bundles simply do not exist. Left advisory, a partial return of the worker/session contention would be
absorbed by `retries: 1`, keep the job green, and never surface.

The pattern generalises, and is worth applying to the next check of this kind: **if a condition is
only observable on a failing run, it is not being verified — move it into the job.** Note both gates
run without `continue-on-error`; adding it back leaves a step that still runs and still prints while
the job passes regardless, which is invisible in the log and is asserted against in
`scripts/__tests__/`.

Counts for a green `app-e2e` are readable now — see *Reading a PASSING run's counts* above. The in-job
gates stay regardless: a gate that runs where it cannot be forgotten is stronger than a number somebody
has to remember to go and read.

## Verifying a branch WITHOUT opening a pull request

**A push to a feature branch runs almost nothing.** `guardrails` and `app-ci` both scope their
`push:` trigger to `main` — a deliberate 2026-07-26 change, because a bare `push:` fired both `push`
and `pull_request` on a branch with an open PR and ran guardrails twice per push on a capacity-1
runner. Feature branches are gated through `pull_request` instead.

So pushing `051-ci-diagnostics-closure` triggered only `infra-image-scan` and `devcontainer-image`,
and only because their **path filters** matched the workflow files in the diff. Nothing else ran, and
`ci-status status --sha` correctly reported one required context still waiting — which reads like a
slow queue rather than "these workflows are not going to run at all".

**Both expose `workflow_dispatch`, so a branch can be fully verified without a PR:**

```bash
FORGE=http://<forge>/api/v1
TOK=$(printf "protocol=http\nhost=<forge-host>\n\n" | git credential fill | grep '^password=' | cut -d= -f2-)

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  "$FORGE/repos/<owner>/<repo>/actions/workflows/guardrails.yml/dispatches" \
  -d '{"ref":"<branch>"}'                                   # -> 204

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: token $TOK" -H 'Content-Type: application/json' \
  "$FORGE/repos/<owner>/<repo>/actions/workflows/app-ci.yml/dispatches" \
  -d '{"ref":"<branch>","inputs":{"provider":"anthropic"}}'  # -> 204
```

Use the **`git credential fill`** credential, not `MCM_FORGE_TOKEN` — the read token 403s. Pass
`provider: anthropic` to `app-ci` so the agent E2E specs run on the surface that matters.

⚠️ **A dispatched run posts NO commit status** (the same property documented for `cd-deploy` in
[ci-evidence-pipeline.md](ci-evidence-pipeline.md#cd-deploy-is-a-special-case)). `ci-status status --sha` will therefore keep saying *waiting* no matter how the run
goes — it is reading a channel the run never writes to. Read `/actions/tasks` instead:

```bash
curl -s -H "Authorization: token $TOK" "$FORGE/repos/<owner>/<repo>/actions/tasks?limit=40"
```

⚠️ **And note the shape of that payload**: Forgejo puts the outcome in **`status`**
(`running` / `success` / `failure` / `skipped`), *not* in a GitHub-style `status: completed` plus
`conclusion`. A poller written to the GitHub shape matches nothing and reports silence — which looks
exactly like "still running".

⚠️ **`run_number` in `/actions/tasks` is NOT the id the failure bundle is named after.** They are
offset. An `app-e2e` job reported as `run#1602` published its bundle as **`1603--app-e2e`**, because
the bundle version comes from `GITHUB_RUN_ID` (a repository-wide counter) while `run_number` is
per-workflow. Two consequences, both of which cost time here:

- Fetching `<run_number>--<job>` returns **404**, which reads as "no bundle was published" — the
  digest-absent case — when in fact one exists under a different name. **List the package versions
  rather than constructing the name**, and take the newest for the job:
  `GET /api/v1/packages/{owner}?type=generic&limit=10`.
- A poller keyed on a hard-coded `run_number` threshold silently matches nothing. Key it on the job
  names you dispatched, or on `head_sha`.

## Opening a pull request

### 🚨 The invariant: a PR's head MUST be a real branch

**Do NOT open a PR with an AGit push (`HEAD:refs/for/main`).** AGit creates a PR with no backing
branch — its `head.ref` is `refs/pull/<n>/head`. **Forgejo treats a non-branch head as untrusted and
runs it WITHOUT Actions secrets**: every `${{ secrets.* }}` in the workflow arrives as the empty
string.

The failure this produces does not mention secrets. `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` is
empty, the cache server rejects the request, and nx reports:

```text
NX   Successfully ran target lint for project mc-service
NX   Misconfigured remote cache endpoint: Requests should respond with text/plain on 401s
```

which reads as a cache or credential fault. On **2026-08-01** that cost two sessions most of a day
(PR #126): the cache server, the token, the MinIO bucket, and the nx wrapper were each investigated
and found healthy, because they *were* healthy. Jobs that never touch the nx cache pass, so the
failure looks selective and content-specific. The tell is measuring the secret's **length inside the
job** — `0`, sha256 `e3b0c44298fc` (the empty string) — versus `64` on a branch-backed PR. The same
commits reopened from a real branch (#129) passed first try.

`scripts/ci-status.mjs` now prints a **DETACHED HEAD** warning for this, because it is invisible in
the web UI.

### Opening one from a session

```bash
git push origin HEAD:<branch>            # a REAL branch — this is the load-bearing part

ORIGIN="$(git remote get-url origin)"; PROTO="${ORIGIN%%://*}"; HOST="${ORIGIN#*://}"; HOST="${HOST%%/*}"
TOKEN="$(printf 'protocol=%s\nhost=%s\n\n' "$PROTO" "$HOST" | git credential fill | sed -n 's/^password=//p')"
curl -sS -X POST "$PROTO://$HOST/api/v1/repos/jumbleknot/mcm/pulls" \
  -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  -d '{"head":"<branch>","base":"main","title":"…","body":"…"}'      # expect 201
```

**`POST /pulls` works from a session** — measured 2026-08-01, four consecutive `201 Created`
(#125, #127, #128, #129). If it answers

```text
403 token does not have at least one of required scope(s): [write:repository]
```

you used the **wrong credential**. `MCM_FORGE_TOKEN` is the *read* token
and can never create a PR. The `git credential fill` credential is a different one — write-capable at
repository scope, the same property that made the AGit push work. Use it and the API succeeds, with a
full markdown body and an editable PR afterwards.

**It works in the dev container too** (measured): the container mounts no host credential store, but
VS Code's Dev Containers **credential-helper proxy** forwards the credential over an IPC socket, so
`git credential fill` returns `username` + `password` non-interactively there as well.

> **Fallback.** That helper is `/tmp/vscode-remote-containers-<uuid>.js` and needs VS Code attached.
> In a bare `devcontainer exec` session with no VS Code, `git credential fill` returns nothing. Then:
> push the branch (which needs no API token) and open the PR in the web UI. **Never** fall back to
> AGit — a PR you cannot get CI signal from is worse than one you opened by hand.

### No checks appeared AT ALL — read the commit MESSAGE before anything else

`ci-status` says *"no checks have reported for this commit yet"*, `?head_sha=<sha>` returns **0 runs**,
and `/actions/tasks` shows nothing for the branch. That is not a slow runner and not a broken workflow
file — nothing was ever queued.

**The forge scans the whole commit message for a CI-skip marker, and skips every workflow when it finds
one.** `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`. It applies to `push`,
`pull_request` and `pull_request_sync` alike, and it reads the **entire** message, not the subject line
— so a marker quoted in a body paragraph, inside a bullet, or in a code fence silently disables CI for
that commit. Measured 2026-08-31 on PR #322: a commit whose body *described* cd-deploy's `[skip ci]`
promotion commit produced zero runs on both the push and the pull request.

The tell that separates it from a dead runner: `/actions/tasks?limit=40` still shows recent tasks for
*other* branches. A dead runner starves everything; a skip marker starves exactly one commit.

The fix is to reword the message — `git commit --amend`, then force-push — never to disable the
feature. Quote the marker as `` `skip`-`ci` `` or name it in prose ("a skip-ci marker") when a commit
needs to talk about one.

### Deleting the branch on merge — the repo default does NOT cover an API merge

`default_delete_branch_after_merge: true` (enabled 2026-08-29, item #290) is the default for the
**merge button in the web UI**. A merge driven through the API is unaffected unless the request says
so:

```bash
# deletes the head branch
--data '{"Do":"merge","delete_branch_after_merge":true}'
# leaves it behind, even with the repo default ON
--data '{"Do":"merge"}'
```

Measured the same evening: PR #287 and PR #293 passed the flag and their branches were gone; PR #291
omitted it and `290-renovate-runbook-dispatch-and-stale-branches` survived the merge and had to be
deleted by hand. **So a session merging through the API must pass the flag every time** — the repo
setting will not cover for it.

This is not housekeeping. A surviving `renovate/*` branch makes Renovate reuse a stale commit instead
of regenerating, which is how an empty PR gets opened
([renovate.md §2](./renovate.md), item #290) — and `renovate/lock-file-maintenance` in particular is
hard-exempt from Renovate's own pruning, so nothing else will ever clean it up.

Two branches you should **not** delete:

- **An open PR's head.** It is hand-closing by another route, with the same consequence — for a
  `lockFileMaintenance` branch it marks the channel rejected.
- **A branch an automation owns and recreates**, e.g. `openwiki-maintenance`. Its workflow re-creates
  it each scheduled run, so a lingering ref there is its normal working state rather than debris.

### "Is it merged?" — `merged: true` is not the answer

`GET /pulls/{n}` reports `head.sha` as the branch's **current tip, not the commit that was merged**.
Measured 2026-08-01: PR #119 showed `merged: true` with a `head.sha` created **47 minutes after** the
merge, because two further commits had been pushed to the same branch afterwards. The PR page read as
though it had shipped those commits. `main` did not contain them, and the PR was already closed, so
nothing was going to carry them.

Reusing a branch after its PR merged is the trap: the natural "push the follow-up to the same branch"
silently orphans the work. Ask git, then confirm the content:

```bash
git fetch origin
git merge-base --is-ancestor <sha> origin/main && echo merged || echo NOT merged
git show origin/main:<path> | grep <the thing you changed>
```

#### Worse: `merged: true` AND a MATCHING `head.sha`, with the head's commits still absent

The case above is a branch pushed to **after** the merge. This one has no such tell, and the API is
self-consistent and wrong. Measured 2026-09-19 on PR #498:

| field | value |
|---|---|
| `state` / `merged` | `closed` / `true` |
| `head.sha` | `a58e4802` — the second commit, pushed **before** the merge |
| `merge_commit_sha` | `9b394ba4` |
| **that merge commit's parents** | `ebbaab71` and **`270174d9`** — the **first** commit |

So the forge merged a **stale snapshot of the branch** while reporting a head it did not merge. Two
commits were on that branch; one shipped, one silently did not, and every field you would think to
check agreed that it had. `git merge-base --is-ancestor a58e4802 origin/main` answered **no**.

The mechanism was not confirmed and does not matter for the check: **a PR's `head.sha` is a claim
about the branch, never about the merge.** Only the merge commit's own parents are evidence.

```bash
# The authoritative pair. Run BOTH after any merge you did not watch land.
git fetch origin
git merge-base --is-ancestor <your-sha> origin/main && echo merged || echo 'NOT merged'
git log -1 --format='parents: %P' "$(git rev-parse origin/main)"   # your commit must be in here
```

And confirm the **content**, not just the graph — `git show origin/main:<path> | grep <what you
changed>`. A `0` from that grep is what turned this from "the PR merged" into "half of it did".

If a commit is stranded, it is not lost: rebase it onto the new `main` and open a fresh PR. Do **not**
reuse the merged branch — that is the trap in the section above, and the two compound.

---

## When there is no digest

If a job dies **before** the digest step runs — runner crash, malformed workflow YAML, or a fault in
the digest step itself — nothing is published. `ci-status failure` says so explicitly rather than
reporting "no failure".

That class is a **known, accepted gap**. Direct build-host access was the only design covering it and
was rejected as widening the security posture for a rare failure class. For those, fall back to the
out-of-band `~/mcm-ci-last-failure/` bundle on the runner (see
[e2e-testing.md](./e2e-testing.md) diagnosis step 6) — the access path is documented in private memory,
not here.

> ⚠️ **Before believing "no digest", drop `--job` and look again.** Measured 2026-08-30 on PR #289:
> `failure --pr 289 --job "infra-image-scan / infra-image-scan"` — the value copied straight out of
> this tool's own status table — reported *"1 job(s) failed, but no digest was published for them"*.
> The digest was on the PR the whole time and named all five blocking findings. The marker carries the
> **bare** job name (`job=infra-image-scan`); the filter was comparing it against the `workflow / job`
> **context** form, matched nothing, and an unmatched filter rendered as absence. That mismatch sent a
> session into an hour of local Trivy reproduction to re-derive what the digest already said.
>
> Both halves are fixed — `--job` now accepts either form, and a filter that excludes every digest
> now names what IS available instead of claiming absence — but the habit is the durable protection:
> **absence reported under a filter is a claim about the filter until you have checked without it.**
> The bundle is the second opinion, and it is retrievable directly when you want the raw evidence:
>
> ```bash
> curl -sS -H "Authorization: token $MCM_FORGE_TOKEN" \
>   ".../api/packages/<owner>/generic/ci-failures/<runId>--<job>/bundle.json.gz" -o b.gz
> ```
>
> Its `meta.digestOutcome` states whether the digest published and by which channel (`pr-comment`
> here), which distinguishes "never ran" from "ran, and you did not find it". Note the package
> listing is **paginated** — checking three pages of four and concluding "nothing was published since
> 2026-08-28" is how the wrong conclusion was reached the first time.

---

## How CI produces this evidence — see [ci-evidence-pipeline.md](ci-evidence-pipeline.md)

Everything above is about **reading** CI. How the evidence is **produced** is a separate runbook,
[ci-evidence-pipeline.md](ci-evidence-pipeline.md): the digest (channels, upsert, caps, fail-closed
redaction), the evidence bundle (what it packs, its caps, reading `mc-service.log` by `duration_ms`),
per-step durations and the generated ceilings table, the `cd-deploy` special case, the untrusted-PR
hardening, the coverage gate (and why it checks presence, not reachability), wrapping a step with
`ci-log-step.sh`, checkout-independent gates, and the maintenance notes for the scripts themselves.
It was split out of this file on 2026-10-09 to keep each source under the wiki generator's 100 KB read
limit (item #682).
