# CI Self-Serve Diagnostics

**Feature 042.** Diagnose a CI failure without a human copy-pasting logs into the session.

The forge API exposes **no log, artifact, or per-run-jobs endpoint** — measured, and `swagger.v1.json`
confirms the absence is by design in this build. So this inverts the direction: **CI pushes a curated
digest into a channel the API can already read**, and `scripts/ci-status.mjs` reads it back.

> **No forge host literal, token, or SSH target belongs in this file** (topology-scrub rule). Every
> command below resolves the host from the `origin` remote at runtime.

---

## Quick reference

```bash
node scripts/ci-status.mjs status                      # HEAD — is this commit mergeable?
node scripts/ci-status.mjs status --sha <full-sha>     # a specific commit (full 40 chars)
node scripts/ci-status.mjs status --pr 82              # a pull request
node scripts/ci-status.mjs watch --pr 82               # poll until settled
node scripts/ci-status.mjs failure --pr 82             # why did it fail?
node scripts/ci-status.mjs failure --pr 82 --full      # + fetch the full evidence bundle
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

---

## The four states that are reported wrong

Two of the five check states are **misreported by the raw API** and must be derived. Both wordings
below were **measured**, not guessed — an earlier version of this tool matched `/^skipped/i` because a
hand-authored fixture said `"Skipped"`, so a path-gated job rendered as `passed` and an operator would
have believed it ran. The forge says `"Has been skipped"` and `"Has been cancelled"`.

| State | What the API says | What it means | Failure mode if you get it wrong |
|---|---|---|---|
| `skipped` | `success`, description `"Has been skipped"` | path-gated out → **satisfied** | Fails **safe** — a green PR looks blocked forever |
| `waiting` | `pending` | queued behind the single runner | Fails **safe** — an unnecessary wait |
| `superseded` | **`failure`** | run cancelled by a newer push | Fails **LOUD** — announces a broken build that isn't |
| advisory | `failure` on a non-required context | `dast`, `prod-apk`, `trigger-cd` | Either a false "blocked", or a silently dropped regression |

**The superseded trap is the dangerous one.** On a real cancelled commit, **13 of 16 contexts read
`status: "failure"`** for a commit that was never broken. The tell: *every job dies together on a
change that could not have affected them all.* It is detected two independent ways — the status
description is literally `"Has been cancelled"`, and the owning run's `status` is `cancelled`. Either
alone suffices, so a UI wording change cannot silently turn it back into `failed`.

### The event-suffix rule

Context strings carry an event suffix, and **the same job appears once per event with outcomes that
can disagree**:

```text
guardrails / secret-scan     push=success   pull_request=failure
```

A required-context glob like `guardrails*` matches **both**. A roll-up that ignores the event reports
failure for a commit whose push run was entirely green. `ci-status` selects the event matching the
query — `pull_request` contexts for a PR, `push` for a branch or bare commit.

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
and spreading it across ~20 jobs to publish diagnostics would be a real privilege expansion. Also not
the auto `GITHUB_TOKEN`, which is unused in this repo and declined by the pre-receive hook.

**Missing scopes fail loudly, naming the scope.** A bare `401`/`403` is indistinguishable from an
expired credential and cost this design a full revision cycle to diagnose.

---

## Opening a pull request

**Use an AGit push. Do not use the API.**

```bash
git push origin HEAD:refs/for/main \
  -o topic="<short-topic>" \
  -o title="<conventional-commit title>"
```

The remote prints the PR URL. Pushing the same `topic` again **updates** that PR rather than opening
a second one.

This works because the `git credential fill` credential is write-capable at repository scope — the
same property the read-token section above describes. It needs no API token at all.

**`POST /api/v1/…/pulls` does not work from a session**, and neither does `PATCH` on an existing PR:

```
403 token does not have at least one of required scope(s): [write:repository]
```

`MCM_FORGE_TOKEN` is the **read** token (scopes above); it can inspect PRs but never create or edit
one. The repo's own forge client — `forgejoClient()` in `scripts/wiki-maintain.mjs` — reads a
*different* variable, `FORGE_TOKEN`, which exists only in CI. That asymmetry is deliberate, and it is
why the maintenance loop can open its proposal PR while a developer session cannot.

**Two limits of the AGit route, both measured:**

- **Push options cannot contain newline characters.** `git push` rejects them outright
  (`fatal: push options must not have new line characters`), so there is no way to pass a rich
  markdown body this way.
- **The PR body is taken from the tip commit's message _at creation time only_.** On a multi-commit
  branch the PR therefore describes whichever commit happened to be last when the PR was opened — and
  **later pushes to the same topic do NOT refresh it.** Measured: pushing a new tip to an existing
  topic updated the diff and left the original body untouched. So the body is effectively write-once
  from a session, since editing it afterwards needs `write:repository`.

  Practical consequence: **get the tip commit's message right before the first push**, or accept that
  the body will be wrong for the life of the PR and let the commit list carry the detail. Do not plan
  to "fix the description afterwards" — from a session, you cannot.

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

---

## The digest

Published per failing job, `if: always()` + `continue-on-error: true` in **all six workflows**
(16 jobs). Channel depends on the event:

| Event | Channel | Identity |
|---|---|---|
| `pull_request` | PR comment, **upserted** | `<!-- ci-digest:job=<job> -->` |
| `push` / other | **inside the bundle** as `digest.md` | derived: `{runId}--{jobSlug}` |
| **cancelled run** | **nothing published** | suppressed (see below) |

> **There is no commit status.** `POST /repos/…/statuses/{sha}` returns **403** for
> `CI_DIGEST_TOKEN` — it needs `write:repository`, which is most of the privilege that made
> `CD_PUSH_TOKEN` unacceptable across 16 jobs. Since the status only ever *named* the bundle and the
> reader already knows the run and job, it derives `{runId}--{jobSlug}` itself. Measured 2026-07-20.
>
> Use **`run.id`**, not `index_in_repo` — they differ (986 vs 985 on the run that proved this), and
> only `run.id` matches the `GITHUB_RUN_ID` the bundle was keyed with.

- **Upsert is keyed by job**: one job failing three times leaves **one** comment, edited twice. Two
  different jobs leave two comments.
- **Excerpts are tail-biased and capped** (200 lines / 32 KB per source). Failures surface at the
  *end*; a head-biased excerpt shows the boot banner. Truncation is always stated.
- **A cancelled run publishes nothing.** Its contexts read as `failure`, so without this a single
  rapid re-push would upsert a failure comment for every cancelled job.
- **Degradation is stated, not silent.** Container jobs have no Docker CLI, and only `app-ci/app-e2e`
  writes `~/mcm-ci-last-failure/` today, so "no container health" is normal — it appears under
  **Not collected** rather than as an empty section.

### Redaction is fail-closed

A PR comment is a **far more visible surface than a run log**, so everything published is redacted
first, then **verified**: the `secret-scan` detection rules are re-run over the redacted output, and
any surviving match **drops that excerpt entirely**. Losing a log excerpt is acceptable; leaking a
credential is not. The forge host is matched by *shape* (`*.ts.net`) and never embedded as a literal,
so the redactor cannot leak the host it protects.

---

## The evidence bundle

The digest is deliberately small. For a failure the excerpt cannot explain:

```bash
node scripts/ci-status.mjs failure --pr 82 --full
```

- Stored in the generic package registry as `ci-failures` / **`{runId}--{jobSlug}`** — **per run *and*
  job**, so two jobs failing in one run keep separate bundles rather than overwriting each other.
- **5 MB cap** — sized for **agent context**, not link time. (It was ≈40 s to retrieve while the
  tailnet was throttled to ~135 KB/s; post-fix that is under a second, so context is the only
  binding constraint.) Overflow trims the **largest source first**, keeps the
  tail, and records the truncation — a bundle never misrepresents itself as complete.
- **30-day retention**, pruned opportunistically at publish time. No scheduled pipeline exists for it.
  If failures stop entirely, expired bundles linger until the next failure publishes.
- `--full` writes the bundle to the scratchpad **and prints the path, not the contents**.

---

## `cd-deploy` is a special case

`cd-deploy` is `workflow_dispatch`-only, so it **posts no commit status**. `ci-status status --sha`
and `ci-status failure --sha` therefore show only the `guardrails` / `app-ci` contexts and report
"no failed jobs" for a cd-deploy failure — they enumerate commit-status jobs, and cd-deploy has none.

- **Find its per-job state** via `GET /actions/tasks` (filter `name` = `build-deploy` / `prod-apk`).
  `prod-apk` is non-blocking (nothing `needs` it — a flaky APK build never blocks the deploy).
- **Read its failure digest** by fetching the bundle **directly by run + job**, not via a commit
  status: `{server}/api/packages/{owner}/generic/ci-failures/<runId>--build-deploy/bundle.json.gz`
  with `MCM_FORGE_TOKEN` (read:package). Every build/scan/promote/webhook/probe/rollback step is now
  wrapped with `ci-log-step.sh`, so the digest names the failing step + shows its output (before
  that it fell back to stale app-e2e evidence).
- **Trivy `build-deploy` blocks on a FIXABLE Critical.** A recurring class: the vulnerable package is
  **not an app dependency** — it is `node-tar` bundled by BOTH npm and corepack's pnpm inside the
  `node:*-alpine` base of the mcm-bff image. `pnpm why <pkg> --prod -r` prints nothing ⇒ it is a
  base-image/manager bundle. Fix = remove the unused managers from the BFF **runner** stage (the
  runtime is `node server.js`, invoking neither) — a real elimination, not a Trivy suppression.
  Verify a Docker-image fix locally with `docker run aquasec/trivy image --exit-code 1 --severity
  CRITICAL --ignore-unfixed`.
- **Dispatch it directly to DEPLOY** when app-e2e flaked but the code is already green on its PR:
  `POST /actions/workflows/cd-deploy.yml/dispatches` `{"ref":"main","inputs":{"deploy":"true"}}`
  (the `git credential fill` token works). `app-ci`'s `trigger-cd` blocks on a *failed* app-e2e, so a
  flake stops the auto-deploy; a direct dispatch bypasses the gate. Success ⇒ a `chore(cd): promote …
  [skip ci]` commit pins the new `*_DIGEST` in `infrastructure-as-code/docker/*/.env.deploy`, and with
  `deploy=true` the health probe already passed (no rollback-revert commit on `main`).

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

---

## Hardening (untrusted-PR threat model)

CI logs and bundle contents are attacker-influenceable (a PR author controls what runs in CI), the
digest is published to a more-visible surface (a PR comment), and it's read on a developer's machine.
So (added 2026-07-21 after a security review):

- **`--full` refuses a decompression bomb** — the reader caps gunzip output (64 MB) and the download
  (16 MB); the 5 MB writer cap is not trusted.
- **Reader output strips terminal control characters** — a log line or spoofed PR comment can't
  inject ANSI/OSC escapes (cursor-rewrite, clipboard, hyperlink spoof) into your terminal.
- **Digest authenticity is not assumed** — any PR commenter can type the `<!-- ci-digest:job=X -->`
  marker. The reader only treats a marker at the **start** of a comment as a digest, and surfaces the
  **comment author** so an unexpected one is visible. Marker presence is not proof.
- **Injection defences in the published digest** — excerpts use a dynamically-sized code fence (a
  printed ``` can't break out into live markdown) and embedded `ci-digest` markers are defanged (a
  log echoing another job's marker can't hijack that job's comment).
- **Redaction is broadened** — the fail-closed pass also withholds excerpts containing provider-token
  prefixes (ghp_/github_pat_/glpat-/xox/AKIA/AIza/PEM), and health + bundle-meta fields now run
  through it too. Still a residual: a novel secret shape in an uncovered form. FR-005 remains the
  requirement most worth scrutinising.
- **`CI_DIGEST_TOKEN` is reachable by PR CI** (standard secrets-on-PR exposure), mitigated by its
  narrow scope (write:issue + write:package, never `write:repository` / push-to-main). Consider
  requiring review approval before secrets-bearing PR jobs run.

## Coverage is enforced

The digest is one `if: always()` step per job, so it decays the moment a new job or workflow is added
without it. `scripts/check-ci-digest-coverage.mjs` (a `guardrails / naming` gate) fails CI if any job
lacks a guarded digest step — turning silent erosion into a red build with the job named. A job may
opt out only with a visible, justified marker:

```yaml
  some-job:
    # ci-digest-exempt: <why this job cannot meaningfully publish a digest>
```

A blank reason is rejected. So adding a CI job now forces a choice: give it a digest step, or write
down why it doesn't need one.

## Maintenance notes

- **All scripts are zero-dependency**, `node:` built-ins only. `guardrails` runs them with nothing
  installed, and a test needing a non-root dep is the exact `ajv` failure feature 041 removed.
- **`scripts/__tests__/*.test.mjs` runs in CI** (`guardrails / naming`, added by feature 041). New
  tests are gated automatically, but must be deterministic, offline and token-free.
- **Do not "tidy" the fragmented string literals.** Test fixtures assemble planted credentials and
  tailnet-shaped hosts from fragments at runtime, because `secret-scan` and `check-topology-scrub`
  scan the whole tree and cannot distinguish a test fixture from a real leak. Collapsing them into
  single strings fails the gates — this happened three times while building this feature.
- **Only INSTRUMENTED steps mirror their output.** A step wrapped with `scripts/ci-log-step.sh`
  writes its combined stdout+stderr to a per-run directory the collector reads at the HIGHEST
  priority — the failing step's own output outranks any container log. Wrap a step like this:

  ```yaml
  run: bash scripts/ci-log-step.sh <log-name> <command> [args...]
  ```

  Instrumented steps: `app-e2e` (agent-integration, mc-service-integration, web-e2e,
  maestro-agent-flows) and `guardrails` (secret-scan, agent-gates lint/test/golden, naming script
  tests, sast gate). The wrapper also records **which** wrapped step failed, so the digest names it
  instead of `_not reported_`. **A step that is not wrapped contributes no output**, and the digest says so
  under *Not collected* rather than staying silent. Add the wrapper to any step whose failure you
  would otherwise have to read in the web UI.

  > ⚠️ The wrapper sets `pipefail` deliberately. `cmd | tee` returns **tee's** exit status, so
  > without it a FAILING step reports SUCCESS and CI goes silently green — strictly worse than
  > missing logs. `scripts/__tests__/ci-log-step.test.mjs` pins this; removing `pipefail` fails it.
- **The digest is size-capped for the comment channel.** A PR comment / commit status has a ~64 KB
  limit; a full `app-e2e` digest measured 90 KB. The digest markdown is trimmed to fit with a note,
  while the bundle keeps every log as a separate file — so nothing is lost, only relocated.
- **A failed publish is recorded in the bundle** (`meta.publish = {published, channel, reason}`).
  The bundle is readable over the API; the job log is not. Without this, a publish failure is visible
  only to a human in the web UI — which is how T040's cause stayed unproven across two smoke runs.
- **The digest is also echoed to the job log** inside a `::group::`, so a human can read it in the
  browser even when publication fails entirely.
- **`--selftest` is a thin smoke check**, not a duplicate of the suite. `scripts/__tests__/` is
  authoritative.
