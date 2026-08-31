---
type: Runbook
title: CI self-serve diagnostics
description: How ci-status.mjs answers "is this commit mergeable" without a human pasting CI logs into the session — the superseded-vs-failed misclassification trap, the live-fetched required-check list, and the query shape that keeps a lookup fast instead of pulling a multi-megabyte payload.
resource: docs/runbooks/ci-diagnostics.md
tags: [ci, forgejo, diagnostics, tooling, runbook]
timestamp: 2026-08-31T17:33:17+00:00
---

# CI self-serve diagnostics

The forge's API exposes no log, artifact, or per-run-jobs endpoint, so `scripts/ci-status.mjs`
inverts the usual direction: CI pushes a curated status digest somewhere the API can already read,
and the script reads it back to answer "is this commit/PR mergeable" and "why did it fail" without a
human copy-pasting logs into the session. It resolves the forge host from the `origin` remote at
runtime rather than any literal configured value.

## Gotchas

- **Two of the five reported check states are misreported by the raw API and must be derived, not
  trusted literally.** A path-gated-out job reads `success` with description "Has been skipped"
  (fine); a cancelled-by-newer-push run reads `failure` on **every** job it touched, even though
  nothing was actually broken — the tell is that unrelated jobs die together on a change that
  couldn't have affected them all, confirmed by the literal "Has been cancelled" description or the
  owning run's `cancelled` status.
- **There is no re-run endpoint — measured 2026-08-31.** All three plausible shapes answer `404`:
  `actions/runs/{id}/rerun`, `actions/tasks/{id}/rerun`, `actions/runs/{id}/rerun-failed-jobs`.
  Nothing can re-run a job in place, and there is no way to re-run *one* failed job at all.
  Re-triggering means producing a **new head sha** — `git commit --amend --no-edit` (same tree, new
  committer timestamp) plus a force-push re-fires the whole `pull_request` run. Budget for the full
  suite, not for the one job that failed; on this runner a re-run costs ~35 minutes of capacity-1
  time, so it is worth spending only when the evidence says the failure is not about your diff.
- **"Every job died together" has a SECOND cause: a broken `pnpm install`.** A supply-chain policy
  rejecting a fresh transitive produces the identical board shape — every job that installs
  dependencies goes red, with no relationship to the diff. Measured 2026-08-28 on PR #263:
  `affected`, `mc-service-checks`, `naming`, `okf`, `agent-gates`, and `sast` all failed on a
  one-line `@ag-ui/client` bump; the cause was `zod@4.5.1` published 1.7 hours earlier. **When the
  whole board goes red: check `status` for `cancelled` FIRST, then open any one failing job's digest
  and look at which STEP failed.** If it is the install step, the other digests will say the same
  thing — reading all six is wasted effort. See [Renovate](renovate.md) for the cooldown/transitive
  interaction.
- **"Does this branch still contribute?" is a two-dot diff question, not three-dot.**
  `git diff main...branch` reports what the branch adds since the merge base — changes `main` already
  has by another route will appear as still-live work. `git diff main branch` shows what the trees
  actually differ by. Measured on PR #262: three-dot said "three version moves remain unique to this
  PR"; two-dot showed merging it would have downgraded crates, and Renovate autoclosed it minutes
  later.
- **`--run N --full` resolves the wrong commit — use `--pr N --job <name>` or `--sha`.** The command
  every digest footer prints (`failure --run 2147 --full`) answered "No failed jobs on this commit"
  on a run that had definitively failed (item #226, reconfirmed 2026-08-28). The wrong answer is a
  **confident negative**, not an error — "No failed jobs on this commit" reads as "CI is fine". Use
  `--sha $(git rev-parse <ref>)` or `--pr N`. An abbreviated sha is refused outright; a short sha
  returns zero runs and reads as "no CI ran".
- **The "superseded" trap is the dangerous direction: it fails loud, announcing a broken build that
  isn't.** The other misreport (skipped) fails safe. Both were measured against real API responses,
  not inferred from documentation.
- **`cd-dispatch / trigger-cd` is NOT a CI result — it is the deploy gate's own answer, and it is
  the ONLY place a declined deploy is visible.** Before item #230, a run that declined to dispatch
  and a run that deployed looked identical from outside — both were advisory, both silent. A commit
  went undeployed for a day because of this (measured 2026-08-22: PR #217's changes reached `main`
  and were never deployed; the advisory job gave no signal). `scripts/cd-dispatch-gate.mjs` now
  publishes its decision as a `cd-dispatch / trigger-cd` commit status: `superseded — <sha> is the
  tip …` and `nothing deployable changed since the last deploy` are `success` (correct non-deploys);
  a guardrails failure, an unfinished run, or no guardrails at all are `failure` and also red the
  job. **Read this status before concluding a deploy was lost.**
- **The required-check list is fetched live from branch protection, never hand-maintained.** It
  previously drifted (a hardcoded array missed a check added by a later feature) and let the tool
  report "mergeable" for a PR the forge then rejected outright — over-reporting mergeable is the
  dangerous direction here, because a wrapper that chains a status check into an actual merge call
  will attempt a merge that cannot succeed.
- **A context string carries an event suffix, and the same job can disagree between events** (e.g.
  green on `push`, red on `pull_request`) — a required-check glob that ignores the event can report
  failure for a commit whose relevant run was entirely green. The tool selects the event matching the
  query type.
- **Query shape is a correctness rule here, not a performance tweak.** Filtering by the full commit
  SHA is server-side honored and returns a small payload; several other filter parameters are
  silently ignored by the API and fall back to a payload roughly 800x larger — using the wrong query
  doesn't just make a lookup slower, it can make it impractically slow.
- **Exit code `3` (still waiting when `watch` timed out) is deliberately distinct from exit `1` (a
  required context failed).** There is a single CI runner in this homelab, so a saturated queue is
  expected and must never be conflated with an actual build failure.
- **Do NOT open a PR with an AGit push (`HEAD:refs/for/main`).** AGit creates a PR with no backing
  branch — its `head.ref` is `refs/pull/<n>/head`. Forgejo treats a non-branch head as untrusted
  and runs it **without Actions secrets**: every `${{ secrets.* }}` arrives as the empty string.
  The failure does not mention secrets. `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` is empty, the
  cache server rejects the request, and nx reports `Misconfigured remote cache endpoint: Requests
  should respond with text/plain on 401s` — which reads as a cache or credential fault. The cache
  server, the token, the MinIO bucket, and the nx wrapper are all healthy; the tell is measuring the
  secret's **length inside the job** — `0`, sha256 `e3b0c44298fc` (empty string) — versus `64` on a
  branch-backed PR. This cost two sessions most of a day on PR #126. `ci-status.mjs` now prints a
  **DETACHED HEAD** warning for this case. Always use `git push origin HEAD:<branch>` (a real
  branch), then open the PR via `POST /pulls` with the **`git credential fill`** credential (not
  `MCM_FORGE_TOKEN`, which is read-only and 403s).
- **`GET /pulls/{n}` reports `head.sha` as the branch's current tip, not the commit that was
  merged.** After a PR is merged, further pushes to the same branch update `head.sha`, so
  `merged: true` can co-exist with a `head.sha` that is newer than `main` — the PR page reads as
  though it shipped those commits, but `main` does not contain them. Use
  `git merge-base --is-ancestor <sha> origin/main` to verify, not the API `merged` flag.
- **Container-executor step logs are read in-job, before teardown — they do not need host
  persistence.** The wrong mental model ("`$HOME/mcm-ci-step-logs/` disappears when the container
  dies → containerized jobs are undiagnosable") is tempting and false. `Publish failure digest` is
  a step *in the same container*, so it reads the logs before teardown and pushes the evidence
  over the forge API. The absence of leftover files on the host is evidence about leftovers,
  not about diagnosability.
- **Per-STEP instrumentation is the real requirement — per-job coverage was never enough.**
  Before feature 051, 85 of 136 `run:` steps produced no capture. The old coverage gate passed
  if *any one step* was wrapped; `guardrails / naming` had 2 wrapped steps, neither a gate, so a
  naming failure published logs from two unrelated steps. `check-ci-digest-coverage.mjs` now
  requires every `run:` step to be wrapped or carry a justified `# ci-log-step-exempt:` marker.
  Every new CI job forces a choice: instrument it, or write down why it does not need
  instrumentation.
- **Per-COMMAND coverage is the follow-on trap — a substring test is not a parse (item #177 variant 4).**
  "Every `run:` step must be wrapped" was checked by testing whether `ci-log-step.sh` appeared
  anywhere in the block — so a multi-line block passed if the wrapper appeared at the bottom, and
  every command above it ran unwrapped: no log, no `_failed-step` marker, digest names nothing.
  Measured 2026-08-29 on three live steps: `cd-deploy / prod-apk` (`exit 1` on the BASE_DOMAIN
  guard), `devcontainer-image / build-publish` (`: "${REGISTRY:?…}"`), `wiki-maintain / maintain`
  (`exit 2` on a malformed dispatch input). Fix: wrap the whole multi-command block with the heredoc
  idiom so every command runs inside the wrapper. The gate checks PRESENCE, not REACHABILITY — it
  reads YAML and shell as text and cannot verify the wrapper can actually execute where it is placed.
  When a job dies in seconds with no digest content, suspect wrapper preconditions first.
- **The step-log directory is scoped by run AND job — a run-scoped directory causes sibling-job contamination (item #180).**
  `app-e2e` and `dast` run as two jobs of one run on the same self-hosted runner (shared `$HOME`).
  A run-scoped directory gave them one `_failed-step` file and one pool of step logs; whichever
  failed first wrote the marker, and the other published it as its own. Measured on run **#1683**:
  `app-e2e` digest reported `dast-install-latest-docker`, a step in the `dast` job. The fix is
  `$HOME/mcm-ci-step-logs/<run-id>/<job>/`. There is deliberately no run-scoped fallback — one
  would keep reading the sibling's marker on exactly the overlapping runs the scoping is for.
  Writer (`ci-log-step.sh`) and reader (`stepLogDir` in `ci-failure-digest.mjs`) derive the path
  independently and must move together.
- **On a red `app-e2e`, read the `Run health` row FIRST (item #173).** Roughly one run in seven
  *collapses*: every agent/dock spec fails at once, `flaky=0`, and the gateway receives about a
  quarter of its usual turns because the client stops sending them. `scripts/e2e-turn-tally.sh`
  labels this, and its verdict is now a digest field. `verdict=collapsed` means the failures say
  nothing about your diff — the one case where the re-run reflex is correct. `indeterminate` is
  normal on a pull request (gate tier only, feature 056). A collapsed run always fails, so a run
  that produced no digest was not a collapse.
- **Gate verdicts must not depend on line endings.** Two gates violated this in opposite
  directions at the same time. `check-ci-digest-coverage.mjs` was failing CLOSED on Windows
  checkouts (reporting exempt jobs as uncovered) because `\r` broke the exemption-marker regex
  while `\s*` in the job-header pattern swallowed it silently. `check-openwiki-okf.mjs` was
  failing OPEN (timestamp comparison silently skipped) because `.split('\n')` left `\r` on
  values, making `Date.parse` return `NaN`. **A false green is the worse failure; it merges.**
  Fix: split on `/\r?\n/`, normalize at the point of reading, not per-pattern.
- **When `CI_DIGEST_TOKEN` is empty the digest degrades, not fails.** `CI_DIGEST_TOKEN` is an
  Actions secret, so it is blank exactly when a run is most confusing (e.g. an AGit-headed push
  where every `${{ secrets.* }}` arrives empty). The digest now falls back: if the run-provisioned
  token is present it posts a commit status `ci-digest/<job>` with the failing step name and a
  truncated excerpt (`published`, `degraded: true`); if both are absent, `failed:no-credential`.
  **Residual:** T034 proved the run token *can* write statuses but did NOT prove it is populated on
  a secretless run — that requires an AGit-headed push, which is forbidden. If a secretless run
  still publishes nothing, check this first.
- **A passing run publishes no bundle — the result gate is how CI judges its own counts.** The
  digest publishes only on failure, so on a green run `failed=` / `skipped=` / `passed=` are
  unreadable from outside. `app-ci` now runs `node scripts/e2e-failure-set.mjs gate <web-e2e.log>`
  right after the web E2E: it fails on `skipped > 0`, `did not run > 0`, or a log with no summary
  at all. A second gate (`scripts/e2e-contention-tally.sh --gate`) fails on `refresh_429 > 0` or
  `session_evicted > 0`. **Neither gate may carry `continue-on-error`** — adding it back makes the
  step invisible in the log while the job passes regardless. `flaky` is still NOT observable on a
  green run; do not claim "no flakes" from a green tick.
- **`--job` filter was fail-open — "no digest published" under a filter is a claim about the filter,
  not about the digest.** Measured 2026-08-30 on PR #289: `failure --pr 289 --job "infra-image-scan /
  infra-image-scan"` (the context form this tool prints in its own status table) reported "1 job(s)
  failed, but no digest was published for them". The digest was on the PR the whole time, naming all
  five blocking findings. The marker carries the **bare** job name (`job=infra-image-scan`); the
  filter compared against the `workflow / job` context string, matched nothing, and an unmatched filter
  rendered as absence — the same fail-open shape as the backlog tool's unknown-label bug. That sent a
  session into an hour of local Trivy reproduction to re-derive what the digest already stated.
  Fixed: `--job` now accepts either form, and a filter that excludes every digest names what IS
  available instead of claiming absence. The habit is the durable protection: **if absence is reported
  under a `--job` filter, drop the filter and look again before concluding no digest was published.**
- **A session merging through the API must pass `delete_branch_after_merge: true` every time — the
  repo setting does not cover API merges.** `default_delete_branch_after_merge: true` (enabled
  2026-08-29) is the default for the **web UI merge button only**. An API merge omitting the flag
  leaves the branch behind regardless. Measured the same evening: PRs #287 and #293 passed the flag
  and their branches were gone; PR #291 omitted it and had to be cleaned up by hand. This is not mere
  housekeeping: a surviving `renovate/*` branch makes Renovate reuse the stale commit instead of
  regenerating — `renovate/lock-file-maintenance` in particular is hard-exempt from Renovate's own
  pruning, so nothing will ever clean it up. Two branches **not** to delete: an open PR's head (same
  consequence as hand-closing it), and automation-owned branches like `openwiki-maintenance` (their
  workflow recreates them each scheduled run; a lingering ref is normal working state, not debris).
- **Verifying a branch without opening a PR: `workflow_dispatch` works, but posts no commit
  status.** Feature branches trigger almost nothing on `push:` (guardrails and app-ci scope their
  push trigger to `main`). Both workflows expose `workflow_dispatch`, so a branch can be fully
  verified without a PR — dispatch with the `git credential fill` credential, not `MCM_FORGE_TOKEN`
  (read-only, 403s). Two traps: (1) a dispatched run posts **no commit status**, so
  `ci-status status --sha` keeps saying *waiting* no matter the outcome — read `/actions/tasks`
  instead; (2) **`run_number` in `/actions/tasks` is NOT the bundle ID** — the bundle name comes
  from `GITHUB_RUN_ID` (repository-wide counter), not `run_number` (per-workflow counter). Fetching
  `<run_number>--<job>` returns 404, which looks like "no bundle published". List package versions
  (`GET /api/v1/packages/{owner}?type=generic&limit=10`) and take the newest for the job.
- **Zero checks on a new commit? Read the commit MESSAGE before anything else.** The forge scans
  the **entire** commit message for a CI-skip marker and skips every workflow when it finds one:
  `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`. It applies to `push`,
  `pull_request`, and `pull_request_sync` alike, and it reads the whole message — so a marker
  quoted in a body paragraph, inside a bullet, or in a code fence silently disables CI for that
  commit. Measured 2026-08-31 on PR #322: a commit whose body *described* cd-deploy's `[skip ci]`
  promotion commit produced zero runs on both the push and the pull request. The tell that separates
  this from a dead runner: `/actions/tasks?limit=40` still shows recent tasks for *other* branches
  (a dead runner starves everything; a skip marker starves exactly one commit). Fix: reword the
  message with `git commit --amend`, then force-push. Quote the marker as `` `skip`-`ci` `` or name
  it in prose when a commit needs to discuss one — never disable the feature.

Full exit-code table, the exact API endpoints and payload measurements, the required-check
fetch/fallback logic, the PR creation recipe, and the evidence-bundle hardening details:
`docs/runbooks/ci-diagnostics.md`.
