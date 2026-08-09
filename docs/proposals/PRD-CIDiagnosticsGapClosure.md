# PRD — CI Diagnostics Gap Closure (make a containerized job's failure readable)

**Status:** Proposed

**Created:** 2026-08-02

**Context:** Feature 042 set out to remove the human-as-transport-layer from CI diagnosis. It
succeeded for jobs that run on the **host** executor. It does **not** work for jobs that run in the
**container** executor — which is where most failures happen. On 2026-08-01 two separate incidents
were diagnosed entirely by inference (job *durations*, a locally-reproduced stub server, and a
hand-written probe step merged into `main`) because every log channel was simultaneously blind. Both
root causes were one-line facts that a single line of job output would have named immediately.

**Related:**
[docs/runbooks/ci-diagnostics.md](../runbooks/ci-diagnostics.md),
[scripts/ci-log-step.sh](../../scripts/ci-log-step.sh),
[scripts/ci-failure-digest.mjs](../../scripts/ci-failure-digest.mjs),
[scripts/check-ci-digest-coverage.mjs](../../scripts/check-ci-digest-coverage.mjs),
[scripts/ci-status.mjs](../../scripts/ci-status.mjs),
[.forgejo/workflows/app-ci.yml](../../.forgejo/workflows/app-ci.yml),
[PRD-CISelfServeDiagnostics.md](PRD-CISelfServeDiagnostics.md) (feature 042 — this closes its gaps),
memory `project_mcm_agit_pr_no_secrets`, `project_mcm_nx_remote_cache_401_outage`.

---

## 1. Problem Statement

### 1.1 Step logs die with the container (the load-bearing gap)

`ci-log-step.sh` mirrors each wrapped step to `$HOME/mcm-ci-step-logs/<run-id>/`. Whether that
survives depends entirely on the job's executor, which is selected by its `runs-on` label:

| `runs-on` | Executor | `$HOME` | Step logs |
| --- | --- | --- | --- |
| `kvm` | host | `/home/ci` | **persist** |
| `ubuntu-latest` | container | inside the container | **destroyed at teardown** |

Measured on the runner: `~/mcm-ci-step-logs/` contains captures only from `cd-deploy/build-deploy`
and the devcontainer image build — both `kvm`. There has **never** been a single `mc-service-*` or
`affected-nx` log, because those jobs are `ubuntu-latest`.

That is inverted with respect to need. The containerized jobs are the fast, frequently-failing ones
(`affected`, `mc-service-checks`, all five `guardrails` jobs, `changes`, `trigger-cd`); the host jobs
are the slow, rarely-failing ones. **Every guardrail gate in the repo is currently undiagnosable
without a human pasting logs.**

### 1.2 The digest publishes nothing for these jobs

Across both incidents, `GET /issues/{n}/comments` returned **zero** comments for every failing PR,
despite the digest step being present and `continue-on-error`. Candidate causes, none yet confirmed:

- **The digest needs `CI_DIGEST_TOKEN`, which is an Actions secret.** On a detached-head PR
  (`refs/pull/N/head`) *all* secrets are empty — so the digest cannot authenticate precisely when a
  PR is in the state most likely to fail. This is self-silencing: the failure mode disables its own
  alarm.
- The publish gate (`ci-failure-digest.mjs`) declines on `cancelled`/superseded runs and on any
  `jobStatus !== 'failure'`. Correct behaviour, but worth confirming it is not mis-firing.
- A digest with no step logs to distil may produce nothing worth posting — the 1.1 gap feeding this
  one.

`continue-on-error` plus an unconditional `exit 0` means **a broken digest is indistinguishable from
"no digest was needed."** `ci-status failure` then reports *"no digest was published"* for both.

### 1.3 `check-ci-digest-coverage.mjs` fails on clean `main`

Measured 2026-08-01 by stashing all local changes:

```text
✗ ci-digest coverage gate FAILED: 3 job(s) not covered:
  app-ci / changes, app-ci / trigger-cd, infra-image-scan / changes
  — publishes a digest but no step is wrapped with scripts/ci-log-step.sh
```

The gate is green in CI, so either it is invoked differently there or the discrepancy is
environmental. Either way the gate does not currently hold locally, which erodes trust in it.

> **RESOLVED — feature `051-ci-diagnostics-closure`.** It was environmental, and the environment was
> **line endings**. `parseExemptions` split on `'\n'`, so on a CRLF working tree every line kept a
> trailing `\r`, and the exemption-marker pattern `#\s*<marker>:(.*)$` could not match it — `.` will
> not consume `\r` (it is a line terminator in JS regexes) and a non-multiline `$` demands
> end-of-input. The job-header pattern one line above survived the same input because its `\s*`
> absorbs the `\r`. **That asymmetry is the entire bug**: the parser saw the three jobs but not the
> markers exempting them, and reported them as uncovered. The gate was failing CLOSED — noisy and
> safe, but wrong, and it sent this document's author after the wrong diagnosis.
>
> Reproducible on Linux, so no Windows host is needed to see it:
>
> ```bash
> node -e 'import("./scripts/check-ci-digest-coverage.mjs").then(m=>{
>   const lf = "  myjob:\n    # ci-digest-exempt: because reasons\n";
>   console.log("LF  ->", m.parseExemptions(lf));
>   console.log("CRLF->", m.parseExemptions(lf.replace(/\n/g, "\r\n")));
> })'
> # before: LF -> Map(1) { 'myjob' => 'because reasons' } ; CRLF -> Map(0) {}
> ```
>
> Fixed at **both** layers: the parser now splits on `/\r?\n/`, and `.gitattributes` declares
> `eol=lf` for `*.yml`/`*.yaml`/`*.md` so the condition stops being produced. Regression cases `(k)`
> and `(l)` in `scripts/__tests__/check-ci-digest-coverage.test.mjs` assert the LF and CRLF verdicts
> are identical, feeding the parser directly rather than through a checkout.
>
> **An honest note on how this section came to be marked resolved once already.** Feature 051's spec
> initially recorded §1.3 as closed on the strength of a green Linux run — a result measured in an
> environment that never exercised the failing path, generalised into a claim about all of them. That
> is precisely the false-green this feature exists to remove, committed by the feature itself. It was
> caught by an operator's Windows sweep and is recorded here rather than quietly corrected, because
> the correction is more instructive than the fix. FR-031 — every pass claim names the platform it
> was observed on — exists because of it.
>
> **Operator action, once**: the declaration governs future checkouts only. An existing Windows clone
> needs `git rm --cached -r . && git reset --hard` to pick it up.
>
> See [research.md § R8a](../../specs/051-ci-diagnostics-closure/research.md) and
> [docs/runbooks/ci-diagnostics.md § A gate's verdict must not depend on the checkout](../runbooks/ci-diagnostics.md).

### 1.4 One test assumes a drive-letterless temp path

`scripts/__tests__/ci-status.test.mjs` `(y) a normal bundle entry resolves inside the bundle root`
expects `\tmp\bundle-root\…` and receives `E:\tmp\bundle-root\…` on Windows. CI is Linux so it is
green there, but a developer running the suite locally sees a red test that is not their fault —
which trains people to ignore red.

---

## 2. Goals / Non-Goals

### Goals

1. A failing **containerized** job leaves diagnosable output that outlives the container.
2. A digest that fails to publish says so **loudly**, and is distinguishable from "nothing to report".
3. The digest path does not depend on a credential that is empty exactly when things are broken.
4. `check-ci-digest-coverage.mjs` passes on a clean tree, or its local/CI divergence is explained.
5. The suite is green on Windows and Linux.

### Non-Goals

- Adding a log or artifact API to Forgejo — it has none, and feature 042 already inverted around that.
- Reworking the runner topology or moving jobs between executors *for their own sake*. Executor
  choice is driven by real constraints (KVM for the emulator, containers for toolchain isolation).
- Log shipping to an external service. Retention beyond a run is out of scope.

---

## 3. Proposed Solution (sketch — planning should challenge this)

### 3.1 Put the step log where the host can see it

The container executor mounts the workspace. Writing step logs **under the workspace** rather than
`$HOME` makes them visible to the host after the job, and to the digest step in the same job. A
`CI_STEP_LOG_ROOT` override already exists in `ci-log-step.sh` — the change may be as small as
defaulting it to a workspace-relative path, plus a `.gitignore` entry and a retention sweep.

**Open question for planning:** does the act container executor mount the workspace read-write and
leave it on the host after teardown? Must be verified on the runner, not assumed — the whole point of
this PRD is that an unverified assumption about where files live cost a day.

### 3.2 Make digest failure loud

Keep `continue-on-error` (a broken digest must never fail a build), but have the step **emit a
distinguishable marker** on failure, and have `ci-status failure` report *"the digest step ran and
failed"* separately from *"no digest was published"*. A silent alarm is worse than no alarm, because
it is trusted.

### 3.3 Decouple the digest from secrets where possible

Publishing to a **commit status** (which the auto token can write) rather than a PR comment for the
minimal case would keep a signal alive on a secretless run. Needs a scope check: the push-event path
already uses commit statuses, so the machinery exists.

### 3.4 Small, independent fixes

- `check-ci-digest-coverage.mjs` — wrap a step in the 3 uncovered jobs, or add a justified
  `# ci-log-step-exempt:` marker to each (the mechanism already exists).
- `ci-status.test.mjs` `(y)` — normalize the expected path, or make the assertion drive-letter aware.

---

## 4. Success Criteria

- **SC-1** A deliberately failed `mc-service-checks` (containerized) yields readable output via
  `node scripts/ci-status.mjs failure --pr <n>` with **no** human log-pasting and **no** SSH.
- **SC-2** A deliberately broken digest step produces a report that names it as broken, not as absent.
- **SC-3** `node scripts/check-ci-digest-coverage.mjs` exits 0 on a clean checkout, on Windows and Linux.
- **SC-4** `node --test scripts/__tests__/*.test.mjs` is fully green on Windows and Linux.
- **SC-5** Rehearsal: reproduce the 2026-08-01 empty-secret failure and confirm the cause is readable
  from CI output alone, inside 5 minutes.

SC-1 and SC-5 must be demonstrated by **actually breaking a job**, not by inspection. Both incidents
this closes were prolonged by treating a green run as evidence when it never exercised the failing
path.

---

## 5. Residual Risk (named deliberately)

- **Workspace-relative logs on a persistent runner can leak between runs.** `ci-log-step.sh` already
  scopes by `GITHUB_RUN_ID` and prunes at 7 days; that must survive the move, or one run's output will
  be attributed to another — a failure mode this repo has already been bitten by (memory:
  mis-attributing a stray `~/.maestro/tests/<ts>/` dir to the wrong run).
- **Logs may contain credential-shaped strings.** Anything newly persisted must pass through
  `redactForPublication` on the same terms as today's digest.
- **A commit-status digest is size-limited**, so it can carry a pointer and a short excerpt, not a
  full log. That is acceptable; the goal is to name the fault, not to replay the build.

---

## 6. Why this is worth doing now

Two incidents in one day, each traced to a one-line fact:

| Incident | Actual cause | How it was found |
| --- | --- | --- |
| Morning — nx cache 401 | secret corrupted by a trailing newline from a UI paste | guesswork, then a rotation that happened to work |
| Evening — PR #126 | AGit PR ⇒ `refs/pull/N/head` ⇒ **no Actions secrets** | a probe step merged into `main` to print the token's *length* |

Five wrong causes were proposed and confidently asserted before the evening one was found. The
tooling to prevent that is already built and 80% working — it just does not cover the jobs that fail.
