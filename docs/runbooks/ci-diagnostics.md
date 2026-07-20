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

---

## Why a lookup is fast (and how to keep it that way)

Measured over the ~135 KB/s dev-container→forge link. **These are correctness rules, not
optimizations** — the wrong query is 100× slower and returns 12.4 MB:

| Query | Honoured? | Result |
|---|---|---|
| `?head_sha=<full-sha>` | ✅ true server-side filter | **0.48 s / 15 KB** |
| `?page=N&limit=M` | ✅ | 1.2 s / 82 KB |
| `?limit=N` **alone** | ❌ **silently ignored** | 94 s / 12.4 MB |
| `?status=` `?event=` `?branch=` | ❌ silently ignored | 94 s / 12.4 MB |

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
- **5 MB cap** (≈40 s to retrieve at 135 KB/s). Overflow trims the **largest source first**, keeps the
  tail, and records the truncation — a bundle never misrepresents itself as complete.
- **30-day retention**, pruned opportunistically at publish time. No scheduled pipeline exists for it.
  If failures stop entirely, expired bundles linger until the next failure publishes.
- `--full` writes the bundle to the scratchpad **and prints the path, not the contents**.

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
