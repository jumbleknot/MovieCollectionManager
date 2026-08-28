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

### `--run N --full` resolves the wrong commit — use the `--pr`/`--job` form

Item #226, reconfirmed 2026-08-28. The command every digest footer prints:

```bash
node scripts/ci-status.mjs failure --run 2147 --full     # answered "No failed jobs on this commit."
node scripts/ci-status.mjs failure --pr 263 --job naming --full   # ✅ fetched the bundle correctly
```

on a run that had definitively failed, with the branch head verified unmoved first. **The wrong answer
is a confident negative, not an error** — "No failed jobs on this commit" reads as "CI is fine", which
is the worst possible reading mid-triage. `watch --branch main` has the same shape: it reported green
on a commit that was two merges stale.

**Prefer `--sha $(git rev-parse <ref>)` or `--pr N`.** An abbreviated sha is refused outright, which is
the tool behaving well — the forge's `head_sha` filter is exact-match, so a short sha would return zero
runs and look like "no CI ran".

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
and spreading it across ~20 jobs to publish diagnostics would be a real privilege expansion.

> **Correction (feature 051 T034).** This section used to add "also not the auto `GITHUB_TOKEN`,
> which is unused in this repo and declined by the pre-receive hook". The second half conflated two
> different things: the pre-receive hook governs **git pushes**, not **API writes**. A temporary probe
> on guardrails run #1627 measured the run-provisioned token successfully writing
> `POST /repos/{owner}/{repo}/statuses/{sha}` — it left a real `probe-051-t034` status behind. It is
> still not used for the primary channel (it cannot write issues or packages), but it is no longer
> "unused", and it is not declined.

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

**This section used to end**: "to read counts for a green run today you must make it fail, which is not
a plan." That follow-up is closed — see *Reading a PASSING run's counts* above. The in-job gates stay
regardless: a gate that runs where it cannot be forgotten is stronger than a number somebody has to
remember to go and read.

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

⚠️ **A dispatched run posts NO commit status** (the same property already documented for
`cd-deploy`). `ci-status status --sha` will therefore keep saying *waiting* no matter how the run
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

**`POST /pulls` DOES work from a session** — measured 2026-08-01, four consecutive `201 Created`
(#125, #127, #128, #129). An earlier revision of this runbook said it did not, citing:

```text
403 token does not have at least one of required scope(s): [write:repository]
```

That 403 is real but comes from using the **wrong credential**. `MCM_FORGE_TOKEN` is the *read* token
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

## Step logs are read IN-JOB — they do not need to survive teardown

This corrects a diagnosis that reached a PRD and nearly cost a redesign.

**The tempting wrong story.** `ci-log-step.sh` writes to `$HOME/mcm-ci-step-logs/`, which for a
container-executor job lives inside the container and is destroyed at teardown. So — the reasoning
went — containerized jobs must be undiagnosable, and the fix is to relocate the logs somewhere the
host can read them.

**What is actually true.** The digest is **not a host-side reader**. `Publish failure digest` is a
step *inside the same job*, and in the container executor every step of a job runs in the **same
container**. The digest therefore reads the step logs from the same `$HOME`, before teardown, and
pushes the evidence out over the forge API — a PR comment, plus a generic-package bundle for the
full evidence. Nothing in that path requires the files to outlive the container.

Reproduce it end to end rather than taking this on trust:

```bash
tmp=$(mktemp -d)
HOME="$tmp" GITHUB_RUN_ID=999 bash scripts/ci-log-step.sh probe sh -c 'echo "REAL FAILURE"; exit 3'
T="$tmp" node -e 'import("./scripts/ci-failure-digest.mjs").then(m=>{
  const home=process.env.T, env={HOME:home,GITHUB_RUN_ID:"999"};
  console.log(m.readFailingStep(env,home));
  console.log(m.collectEvidence({home,cwd:process.cwd(),env}).excerpts);})'
# -> probe ; [ { source: 'step:probe', text: 'REAL FAILURE\n' } ]
```

**The `T=` assignment must come BEFORE `node`.** Written after it, it is argv, `process.env.T` reads
back undefined, the probe prints nothing, and it looks like it disproved the point.

**The measurement that misled.** "`~/mcm-ci-step-logs/` on the runner contains captures only from
`cd-deploy/build-deploy` and the devcontainer image build" is **true, and irrelevant**. Host-executor
jobs leave their logs lying on the host; container jobs consume theirs in-job and take them with
them. The absence of container-job leftovers on the host is evidence about **leftovers**, not about
**diagnosability**. Reading it as the latter is the whole mistake.

### The real requirement is per-STEP instrumentation

If the digest can read the logs, why was every guardrail failure undiagnosable? Because **most steps
were never wrapped**, so there was no log to read. Measured before feature 051: **85 of 136 `run:`
steps** produced no capture. `guardrails / naming` had 16 `run:` steps with 2 wrapped, and **neither
of the two was a gate** — so a naming-gate failure published the logs of two unrelated steps.

The old coverage gate passed all of it because it asked only "does this job publish a digest, and is
**at least one** step wrapped?". One was enough. It never asked whether the step that can actually
fail is wrapped. `check-ci-digest-coverage.mjs` now requires **every** `run:` step to be wrapped or
to carry a justified `# ci-log-step-exempt:` marker of its own.

### Wrapping a step

```yaml
# one command
- name: Resource-naming gate
  run: bash scripts/ci-log-step.sh naming-resource-naming-gate node scripts/check-resource-naming.mjs

# several plain commands — wrap each; they append to one log named for the step
- name: Inline-secret gate
  run: |
    bash scripts/ci-log-step.sh naming-inline-secret-gate node scripts/check-no-inline-secrets.mjs --selftest
    bash scripts/ci-log-step.sh naming-inline-secret-gate node scripts/check-no-inline-secrets.mjs

# a body that needs a shell (conditionals, loops, pipes, assignments)
- name: Verify KVM is available
  run: |
    bash scripts/ci-log-step.sh app-e2e-verify-kvm-available bash -e /dev/stdin <<'CI_LOG_STEP'
    if [ -e /dev/kvm ]; then ls -l /dev/kvm; else echo "::error::no kvm"; exit 1; fi
    CI_LOG_STEP
```

The heredoc form needs **no escaping** — the body passes through byte-for-byte, so quotes, `${{ }}`
expressions and shell constructs survive. Use **`bash -e`**, matching the runner default, *not*
`-euo pipefail`: adding `-u` and `pipefail` to a block that never had them can turn a green step red
on an unset variable or a SIGPIPE. Exit codes, `::error::` workflow commands and the `_failed-step`
marker all propagate through the wrapper — verified by execution, not by inspection.

**Choose a short, descriptive log name.** It becomes the digest excerpt's `source`, which is the
first thing a reader sees. Not a slugified copy of a 90-character step title.

**"It is only a setup step" is not a legitimate exemption.** `pnpm install --frozen-lockfile` failing
on a lockfile mismatch and `apt-get install` failing on a mirror are recurring CI failure modes whose
one-line cause is exactly what this machinery exists to surface. The legitimate exemptions are: steps
that run before `actions/checkout` (the script is not on disk yet), the digest step itself (wrapping
the reporter in what it reports on is circular), and `uses:`-only steps (no command to capture).

### Two costs of instrumenting a HOST-executor job, accepted deliberately

Container-job captures die with the container. Host-executor captures (`app-e2e`, `dast`,
`cd-deploy/build-deploy`, `devcontainer-image`) land in `$HOME/mcm-ci-step-logs/<run-id>/` on the
**persistent** runner and stay there:

- **They are unredacted.** Redaction happens at *publication* time in the digest, not at capture
  time — `ci-log-step.sh` does no redaction at all. Raw output sits on the runner for up to 7 days
  (a best-effort `find -mtime +7` prune inside the wrapper). These jobs handle real credentials.
- **Disk.** The wrapper writes the **full** output; the 200-line / 32 KB caps apply only to the
  digest *excerpt*. `app-e2e` already runs a "Free daemon disk space" step, so this adds to pressure
  that job is already managing.

Both were weighed and accepted for the diagnostic value — `app-e2e` is the longest and most
failure-prone job in the repository, and its stack bring-up and teardown failures were previously
invisible. If runner disk becomes a problem, the lever is the retention window in `ci-log-step.sh`,
not un-instrumenting the steps.

## A gate's verdict must not depend on the checkout

**The invariant**: a gate parses repository text, so its answer must be a property of the *commit* —
never of the contributor's `core.autocrlf`, working tree, or operating system. Two gates in this
repository violated that at the same time, in **opposite directions**, and one of them stayed hidden
for months because the direction it failed in was silence.

**The worked example — `check-ci-digest-coverage.mjs`, failing CLOSED.** The gate reported three jobs
as uncovered — `app-ci / changes`, `app-ci / trigger-cd`, `infra-image-scan / changes` — that are all
correctly exempt. It reproduced on a Windows checkout and never on Linux, so it was written up as an
unexplained local/CI divergence (PRD §1.3) and briefly recorded as *resolved* on the strength of a
green Linux run. The cause:

```js
const lines = text.split('\n');                          // leaves a trailing \r on a CRLF checkout
const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/;          // SURVIVES — \s* absorbs the \r
const markerRe  = new RegExp(`#\\s*${marker}:(.*)$`);    // FAILS — . will not consume \r,
                                                         //         and non-multiline $ wants EOF
```

The asymmetry is the whole bug. `\r` is a **line terminator** in JavaScript regular expressions, so
`.` refuses it and a non-multiline `$` refuses it — but `\s*` swallows it without complaint. The
parser therefore saw the jobs and not their exemptions, and nothing about the output looked wrong.

**The other direction — `check-openwiki-okf.mjs`, failing OPEN.** Its drift check guarded on
`Date.parse(fields.timestamp)` applied to the *untrimmed* value. On CRLF the timestamp arrives as
`…Z\r`, parses to `NaN`, and the guard concludes "no usable timestamp" — so the staleness comparison
silently never ran and the gate printed `✅ conformant`. The neighbouring validator escaped the
identical bug only because it happened to call `.trim()` first. **A gate reporting green while not
checking is the worse of the two failures**, and it is much harder to notice: a false red gets
investigated, a false green gets merged.

**The two rules that follow.**

1. **Split on `/\r?\n/`, never `'\n'`** — and fix it *at the split*, not by bolting `\r?` or the `m`
   flag onto whichever pattern happens to be broken today. The next pattern added to the file would
   inherit the trap. `check-komodo-sync.mjs`, `check-topology-scrub.mjs` and
   `check-no-argv-secrets.mjs` already do this; `check-openwiki-governance.mjs` takes the equivalent
   route of `.replace(/\r\n?/g, '\n')` before splitting.
2. **Normalize a value where it is READ, once — not at each use.** A second `.trim()` at the call site
   fixes one validator and leaves the asymmetry in place for the next one. The okf gate now trims
   every front-matter value in `extractFrontMatter`, and the pre-existing per-call trims were removed
   so they cannot drift apart again.

**`.gitattributes` is a second layer, not a substitute.** It declares `eol=lf` for `*.sh`, `*.yml`,
`*.yaml` and `*.md`, which stops the condition being produced — but it governs **future checkouts
only**. It cannot reach a working tree that already exists, so an existing Windows clone must be
re-normalized once:

```powershell
git rm --cached -r .
git reset --hard
git status        # expect clean; if not, the normalization IS the diff
```

**Prove it by feeding the parser directly.** A test that writes a fixture file and reads it back
proves whatever the checkout happened to do, which is the thing under suspicion. Build the LF string,
derive the CRLF variant with `.replace(/\n/g, '\r\n')`, and assert both reach the same verdict —
asserting the **LF** side finds something first, or a regression to "finds nothing either way" passes
as a fix. Both cases are RED on Linux against the unfixed code; no Windows host is needed.

**And name the platform.** Both of these were misread because a result measured on one operating
system was reported as a general one. A pass claim that does not say where it was observed is not yet
a pass claim.

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
