# PRD — CI Self-Serve Diagnostics (Agent-Readable Failure Digests from the Forge)

**Status:** Proposed

**Created:** 2026-07-18

**Context:** Today, diagnosing a CI failure requires a **human in the loop as a transport layer**: the
operator opens the Forgejo UI, finds the failed action, expands the failing step, and copy-pastes the
output into the agent session. This is slow, lossy (only what the human thought to copy arrives), and
scales badly against a capacity-1 runner where `app-e2e` alone runs ~23 min. The agent can already
see *which* job failed via the API — it cannot see *why*.

**Related:**
[.forgejo/workflows/app-ci.yml](../../.forgejo/workflows/app-ci.yml),
[.forgejo/workflows/guardrails.yml](../../.forgejo/workflows/guardrails.yml),
[.forgejo/workflows/cd-deploy.yml](../../.forgejo/workflows/cd-deploy.yml),
[docs/runbooks/e2e-testing.md](../runbooks/e2e-testing.md) (diagnosis step 6 — the `~/mcm-ci-last-failure/` bundle, feature 036),
[scripts/secret-scan.mjs](../../scripts/secret-scan.mjs) (redaction patterns this reuses),
[scripts/check-topology-scrub.mjs](../../scripts/check-topology-scrub.mjs) (the host-literal rule),
CLAUDE.md § *Driving CI/CD to green* (the operator loop this automates),
memory `reference_mcm_ci_monitor_access` (the out-of-band access this supersedes for the common case).

---

## 1. Problem Statement

The agent cannot self-serve CI failure diagnosis. The gap is precise and was **measured**, not assumed
(probes run 2026-07-18 from the dev container against the homelab forge, Forgejo `15.0.3+gitea-1.22.0`):

| Capability | Status | Evidence |
| --- | --- | --- |
| Reach the forge API from the dev container | ✅ works | `GET /api/v1/version` → 200 over the tailnet |
| Authenticate | ✅ works | `git credential fill` on `origin` yields a working token (the recipe CLAUDE.md already documents for opening PRs) |
| List runs + status/conclusion/SHA/event | ✅ works | `GET /actions/runs` → 200 |
| Identify **which job** failed | ✅ works | `GET /actions/tasks` returns per-job entries (`name`, `status`, `run_number`, `head_sha`) |
| Read **job logs** | ❌ **absent** | `GET /actions/runs/{id}/jobs` → 404 |
| Read **artifacts** | ❌ **absent** | `GET /actions/runs/{id}/artifacts` → 404 |
| Read logs via the web UI's JSON endpoint | ❌ **blocked** | `POST /{owner}/{repo}/actions/runs/{index}/jobs/{n}` → 404 under token auth; web routes require a **session cookie**, and a private repo 404s without one |

`swagger.v1.json` is authoritative and confirms the absence is by design in this build: the only
Actions endpoints are `runs`, `runs/{run_id}`, `tasks`, `runners*`, `secrets`, `variables`, and
`workflows/{file}/dispatches`. **No log, artifact, or per-run-jobs endpoint exists.**

A second, quieter problem: the run payloads are hostile to an agent context. `GET /actions/runs`
returns **12.4 MB** (886 runs, each embedding a full repository object). Naive consumption would burn
a context window to learn one job name — which is exactly the failure mode RTK exists to prevent — and
over a ~135 KB/s tailnet link it costs **94 seconds per call**. Both are solved by correct
pagination/filtering; see §4.1, which is a measured constraint on the design, not an optimization.

### Why not just fix the read path

Three alternatives were evaluated and rejected:

- **SSH to the homelab host** (read Forgejo's `actions_log/` store and `~/mcm-ci-last-failure/`
  directly) — most complete, and the only option that covers failures occurring *before* any capture
  step runs. Rejected: it requires granting the dev container new standing access to the homelab host,
  which widens the security posture for a rare failure class.
- **Session-cookie scraper** (log in with username/password, hold a web session, call the UI's log
  JSON endpoint) — no SSH, but stores a password, is fragile to UI changes, and couples the agent to
  an unversioned internal endpoint.
- **Upgrade/patch Forgejo** to expose a log API — out of scope; a self-hosted-forge change to serve a
  tooling need.

The chosen approach inverts the direction: **CI pushes a curated digest into a channel the API can
already read.** No new credentials, no scraping, config-as-code, and it forces the diagnostics to be
*distilled at the source* rather than dumped.

---

## 2. Goals / Non-Goals

### Goals

- **G1** — The agent determines *which* job failed, on which SHA/PR, without human transport.
- **G2** — The agent reads *why* it failed: failing step, tail-biased log excerpt, and the feature-036
  container-health evidence.
- **G3** — The full failure bundle remains retrievable on demand, not only the digest.
- **G4** — Diagnostics never leak credentials or the tailnet host literal.
- **G5** — The digest mechanism never masks, delays, or alters the real job failure.
- **G6** — Coverage across **all** workflows: `guardrails`, `app-ci`, `cd-deploy`, `dast`, `sast`,
  `infra-image-scan`.

### Non-Goals

- **Not** a replacement for the Forgejo UI for humans.
- **Not** SSH or any new standing access to the homelab host.
- **Not** covering failures that occur *before* the digest step is reached (see §7 Residual Risk).
- **Not** a log-shipping or observability platform; the audit/observability stacks are unaffected.
- **Not** altering the merge gate, branch protection, or required contexts.

---

## 3. Proposed Solution

Two halves meeting at the forge API.

### 3.1 Write side — CI emits the digest

A shared composite action `.forgejo/actions/failure-digest/action.yml`, invoked as an
`if: always()` step in every job across all six workflows, shelling to
`scripts/ci-failure-digest.mjs`:

1. **Collect** — the feature-036 `~/mcm-ci-last-failure/` bundle (per-container logs, each container's
   `docker inspect .State.Health`, the `docker ps -a` table), job context from the runner environment,
   and any test output present (jest, Playwright report, Maestro screenshots).
2. **Distill** — markdown, hard-capped per source, **tail-biased**. Failures surface at the *end* of a
   log; a head-truncated excerpt is worthless.
3. **Redact** — run the digest through the existing `scripts/secret-scan.mjs` patterns before it
   leaves the runner. A PR comment is far more visible than a run log, and CI logs carry env-derived
   material. **A leak here would be worse than the problem being solved.**
4. **Publish** — see §3.2.

The step is `if: always()` + `continue-on-error: true`. A broken digest must never mask or replace the
real failure.

### 3.2 Publication model — one bundle path, both event types

- **The bundle always** goes to the Forgejo **generic package registry**, keyed by run id
  (`/api/packages/{owner}/generic/ci-failures/{run_id}/bundle.tar.zst`). No repo pollution,
  independent retention. **Requires package scope on both sides** — see §3.4.
- **The digest** goes to a **PR comment** when the event is `pull_request`, **upserted** via an
  `<!-- ci-digest:job=<name> -->` marker so a retried job edits its comment rather than stacking new
  ones. Otherwise (`push`, `workflow_dispatch`) it goes to a **commit status** whose `target_url`
  points at the same package.

This was chosen over comment attachments alone: assets require a comment, and push-event failures have
no PR — two bundle paths would have resulted. One mechanism covers both.

### 3.3 Read side — `scripts/ci-status.mjs`

Node, no dependencies, matching the repo's `.mjs` script convention. Auth via a **dedicated read-only
token** (§3.4), read from a stable gitignored path with `MCM_FORGE_TOKEN` overriding for headless use.

| Command | Behavior |
| --- | --- |
| `status [--sha \| --pr \| --branch]` | Defaults to HEAD. Compact per-job table **plus the required-context roll-up that is the actual merge signal** (`guardrails*`, `app-ci / changes*`, `affected*`, `mc-service-checks*`, `app-e2e*`). |
| `watch` | Polls until settled; exits non-zero on failure. |
| `failure [--run <id>]` | Locates the digest comment or commit status for the failing job and prints it. `--full` pulls the bundle package into the scratchpad. |

Two output rules are the point of the script, not incidental:

- **Fetch to disk, print distilled.** Raw payloads (12 MB) are cached to a scratchpad file; only the
  distillation reaches the agent context.
- **Redact the forge host on output.** Every URL field carries the tailnet host literal. The script
  rewrites it to `<forge>` so transcripts and pasted output stay compliant with the topology-scrub rule
  **by construction**, not by the agent remembering to.

Two documented traps must be encoded in the roll-up or it will report wrongly:

- A **skipped** gated job settles to `success` and must count as satisfied.
- A **pending** status under a saturated capacity-1 runner is **starvation, not failure** — the poller
  must wait, not fail.

---

### 3.4 Credential model (measured 2026-07-18 — reverses an earlier decision)

The read side was **originally specified to reuse `git credential fill`** on the `origin` remote (the
recipe CLAUDE.md documents for opening PRs), on the assumption that a credential which can push and
open PRs can also read PR comments. **Probing disproved that assumption**, and the correction is the
single most important finding in this PRD:

| Endpoint | credential-fill token |
| --- | --- |
| `actions/runs`, `actions/tasks` | ✅ 200 |
| `statuses/{sha}`, `commits/{sha}/status(es)` | ✅ 200 |
| `pulls`, `pulls/{n}`, `contents/{path}` | ✅ 200 |
| `issues/{n}`, **`issues/{n}/comments`** | ❌ **403** |
| **packages** (`PUT` and `GET`) | ❌ **401** `reqPackageAccess` |
| `/user` | ❌ 403 |

This is **granular scope, not expiry** — the same token returns 200 on `actions/runs` in the same
second, and HTTP basic-auth behaves identically. Git hands out a **repository-scoped** credential;
Forgejo gates issues behind a separate `issue` scope and packages behind `read:package` /
`write:package`.

**Consequence:** a credential-fill read side could read *neither* the digest (PR comment → 403) *nor*
the bundle (package → 401). The publication model and the read credential were chosen in separate
decisions and were **mutually incompatible** — invisible until the endpoints were actually exercised.

**Resolution:** the read side uses a **dedicated read-only Forgejo token** scoped to
`read:repository` + `read:issue` + `read:package`. This is strictly *less* privilege than the
credential-fill token it replaces — that one is write-capable — while reaching the endpoints the
design needs.

It is delivered as **`MCM_FORGE_TOKEN` via the devcontainer `containerEnv` + `${localEnv}`
passthrough**, matching how `ANTHROPIC_API_KEY` / `TMDB_API_KEY` already arrive, so no token literal
enters git and it survives VS Code restarts. (Set on the Windows host with `setx`; note `setx` only
affects newly-launched processes, so VS Code must be fully quit — not merely reloaded — before the
rebuild, or `${localEnv}` resolves to empty and the token silently isn't there.) No on-disk token file
is used.

**Verified 2026-07-18** with the minted token: `issues/{n}/comments` **403 → 200**, packages list
**403 → 200**, package `GET` **401 → 404** (auth passes; the package legitimately does not exist yet),
and `actions/runs` / `actions/tasks` / `commits/{sha}/status` / `pulls/{n}` all still 200. Package
`PUT` remains **401 — correct and intended**, since the token is read-only; uploads are the CI side's
job (FR-016).

**Still open — the write side.** The scope of the Actions auto-token (`GITHUB_TOKEN`) inside a running
job **cannot be observed from outside CI** and remains unverified: it needs comment-write and
package-write. The action MUST therefore take its token as an **input defaulting to `GITHUB_TOKEN`
with a `CD_PUSH_TOKEN`-class fallback**, so the unknown is a configuration switch rather than a
redesign. Confirm on the first real run.

---

## 4. Functional Requirements

- **FR-001** — A composite action posts a failure digest from every job in all six workflows.
- **FR-002** — The digest identifies workflow, job, step, commit SHA, and PR number where applicable.
- **FR-003** — Log excerpts are tail-biased and hard-capped per source.
- **FR-004** — The digest includes the feature-036 container-health evidence when present.
- **FR-005** — All digest content passes through the `secret-scan.mjs` redaction patterns before leaving the runner.
- **FR-006** — The full bundle is uploaded to the generic package registry keyed by run id.
- **FR-007** — `pull_request` events upsert a PR comment keyed by a job marker.
- **FR-008** — Non-PR events post a commit status whose `target_url` resolves to the bundle.
- **FR-009** — The digest step never changes a job's outcome (`if: always()` + `continue-on-error`).
- **FR-010** — `ci-status.mjs` reports per-job status and the required-context merge roll-up for a given SHA/PR/branch.
- **FR-011** — The roll-up treats `skipped` as satisfied.
- **FR-012** — `watch` distinguishes runner starvation from failure and does not fail on `pending`.
- **FR-013** — No raw API payload is emitted to stdout; responses are cached to disk and distilled.
- **FR-014** — All output rewrites the forge host literal to `<forge>`.
- **FR-015** — Read auth uses a dedicated **read-only** token (`read:repository` + `read:issue` +
  `read:package`) supplied as `MCM_FORGE_TOKEN` via the devcontainer `${localEnv}` passthrough. It
  MUST NOT reuse the write-capable `git credential fill` credential, which additionally lacks issue
  and package scope (§3.4).
- **FR-016** — The composite action takes its token as an input defaulting to `GITHUB_TOKEN`, with a
  documented higher-scope fallback, so an insufficient auto-token is a config change not a redesign.
- **FR-017** — On a token lacking a required scope, tooling MUST fail with the missing scope named —
  never silently degrade. A bare `403`/`401` cost this design a full revision cycle to diagnose.
- **FR-018** — A **cancelled** run MUST be reported as *superseded*, never as a failure. The commit
  status endpoint reports a cancelled run's contexts as `failure`, so the run's own `status` field
  MUST be cross-checked before any failure is announced (§5, trap 2).

### 4.1 Non-Functional — the link budget (measured 2026-07-18)

The dev-container→forge tailnet link was measured at a consistent **~135 KB/s (≈1 Mbit/s effective)**
across three transfers (1.34 MB, 2.69 MB, 12.4 MB). Transfer size is therefore a **latency**
constraint, not merely a context-budget one, and it dictates the query strategy below.

Query-parameter behavior on `GET /actions/runs` was probed directly. **The results are
counter-intuitive and must not be re-derived by guessing:**

| Query | Honored? | Result |
| --- | --- | --- |
| *(none)* | — | 12.4 MB, **94 s**, 886 runs |
| `?limit=N` **alone** | ❌ **silently ignored** | full 12.4 MB |
| `?page=N&limit=M` | ✅ | 82 KB, **1.2 s**, 5 runs |
| `?page=N` | ✅ | 475 KB, 2.6 s (30/page default) |
| `?head_sha=<sha>` | ✅ **true server-side filter** | 64 KB, **0.92 s**, `total_count: 4` |
| `?status=`, `?event=`, `?branch=` | ❌ silently ignored | full 12.4 MB |

- **NFR-001** — Status lookups MUST query by `head_sha`, the primary read path: **94 s → 0.92 s (~100×)**.
- **NFR-002** — Run listings MUST send `page` **together with** `limit`. `limit` alone is dropped;
  omitting `page` silently degrades a 1.2 s call into a 94 s, 12.4 MB one.
- **NFR-003** — `status`, `event`, and `branch` filters MUST be applied **client-side after** a
  paginated or `head_sha` fetch; sending them server-side is a no-op that fetches everything.
- **NFR-004** — Any single read on the common path SHOULD complete in **< 5 s**. With NFR-001/002 this
  holds without response caching or conditional requests, so neither is in scope.
- **NFR-005** — Bundle size is capped so `--full` retrieval stays bounded (at 135 KB/s, 5 MB ≈ 40 s).
  This makes the §6 OQ-3 cap a **performance** requirement, not only a context one.

---

## 5. Testing Strategy

Per the constitution's TDD gate, the distiller is pure and unit-testable in `scripts/__tests__/`:

- Tail-selection and per-source capping (FR-003).
- Secret redaction against known credential shapes (FR-005).
- Host-literal redaction (FR-014).
- Upsert-marker parsing and idempotency across retries (FR-007).
- The `skipped → success` roll-up (FR-011) — **the likeliest wrong implementation**, which would report
  a green PR as pending indefinitely.
- **`cancelled → superseded`, not failure (FR-018)** — observed live on 2026-07-18: `guardrails` has
  `cancel-in-progress: true` on `guardrails-${{ github.ref }}`, so a second push within the window
  cancels the first run, and the status endpoint then reports **all four contexts as `failure`** for a
  commit that was never broken. This trap is **worse than FR-011's**: `skipped→success` fails safe
  (an unnecessary wait), while `cancelled→failure` fails loud (announcing a broken build that isn't).
  The tell is that every job dies together on a change that could not have affected them all.
- Starvation-vs-failure discrimination (FR-012).
- **Scope-failure surfacing (FR-017)** — a `401`/`403` must produce a message naming the missing scope,
  not a generic failure. This is regression-testing a real diagnostic cost already paid.

The write path additionally gets one deliberate smoke test: a throwaway branch with a failing step, to
prove a real digest and bundle land against a real PR.

---

## 6. Open Questions for Planning

- **OQ-1 — Token scope. RESOLVED for the read side (§3.4), still open for the write side.** Probing
  showed the credential-fill token reaches neither comments (403) nor packages (401), forcing a
  dedicated read-only token; the design was corrected before implementation. The Actions auto-token's
  scope is unobservable from outside CI and is de-risked by FR-016 rather than resolved on paper —
  confirm on the first real run.
- **OQ-2 — Bundle retention.** Generic packages accumulate per failing run. Decide a pruning policy
  (age- or count-based) and where it runs.
- **OQ-3 — Digest and bundle cap values.** The per-source byte/line caps need real-world calibration
  against an `app-e2e` failure, now bounded on two sides: agent context **and** the §4.1 link budget.
- **OQ-4 — Nx target.** Whether `ci-status.mjs` gets an Nx target (matching `dast` / `sast` /
  `infra-scan`) or stays a direct `node scripts/…` invocation like `maestro-run.sh`.

---

## 7. Residual Risk (named deliberately)

This closes the loop for failures a workflow **reaches**. If a job dies before the digest step runs —
runner crash, malformed workflow YAML, or a failure in the composite action itself — nothing is posted
and the operator is back to the UI for that case. The SSH option was the only design covering this
class; it was scoped out knowingly. The class is rare and its failures are usually self-evident from
the run's own status, but it is a real limit and should not be discovered mid-incident.

Secondary risk: the digest becomes a **new leak surface**. FR-005 is the mitigation, and it is the
single requirement most worth reviewing carefully during implementation.

---

## 8. Documentation Impact

- **New:** `docs/runbooks/ci-diagnostics.md` — the digest format, the `ci-status.mjs` commands, and the
  bundle-retrieval procedure.
- **Changed:** CLAUDE.md § *Driving CI/CD to green* — the instruction to read `~/mcm-ci-last-failure/`
  "out-of-band" becomes the self-serve path; the out-of-band route remains documented only as the §7
  fallback.
- **New:** the read-only token's provisioning steps (required scopes, stable path) documented in the
  runbook; the path itself gitignored, the value never committed.
- **Unchanged:** the private memory entries stay accurate and stay out of git (no forge host literal,
  token, or SSH target in any tracked file).
