# Implementation Plan: CI Self-Serve Diagnostics

**Branch**: `042-ci-self-serve-diagnostics` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/042-ci-self-serve-diagnostics/spec.md`

## Summary

CI cannot expose logs or artifacts through its API, so the agent cannot see *why* a job failed. This
feature inverts the direction: **each job pushes a small, redacted, tail-biased digest into a channel
the API can already read** (a PR comment or a commit status), with the full evidence going to the
generic package registry. A companion read script turns "what is the state of this commit and why did
it break" into one sub-5-second call that never floods the agent's context and never prints the
tailnet host.

Research against the live forge and the existing workflows changed three things from the PRD, all
documented in [research.md](./research.md):

1. **No composite action.** `.forgejo/actions/` does not exist anywhere in the repo, and act_runner's
   composite support is unverified. The action would wrap a single `node` invocation. Dropped in
   favour of a direct `run:` step — see D1.
2. **A new dedicated CI token, not `GITHUB_TOKEN` or `CD_PUSH_TOKEN`.** `GITHUB_TOKEN` is unused in
   this repo and documented as declined by the pre-receive hook; `CD_PUSH_TOKEN` is a high-privilege
   whitelisted-user PAT currently confined to two jobs. Spreading it to ~20 would be a real privilege
   expansion — see D2.
3. **`secret-scan.mjs` cannot be reused as-is.** It is detection-only, has zero exports, and its
   regexes are non-global — `.replace()` against them would redact only the first match. The actual
   redaction primitive lives in `zap-scan.mjs`. See D4, which is the most safety-critical decision
   here.

A fourth question — whether publishing from `guardrails.yml` conflicts with feature 023's "keyless"
property — was raised, investigated, and **resolved as a non-conflict** on 2026-07-19. See
[Complexity Tracking](#complexity-tracking).

## Technical Context

**Language/Version**: Node.js ESM (`.mjs`), **Node 22 floor** — guardrails and other container jobs run
on the runner default `node:22-bookworm` without `setup-node`; the dev container is Node 24. Any API
newer than Node 22 is unavailable in CI.

**Primary Dependencies**: **Zero runtime dependencies** — `node:` built-ins only, matching every
sibling script and the "pure node built-ins; no install needed" constraint in `guardrails.yml`. No new
package is added to the workspace.

**Storage**: Forgejo **generic package registry** for evidence bundles (`ci-failures` package, one
version per run+job). No database. Digests live as PR comments / commit statuses. Local caching of raw
API payloads goes to the session scratchpad, never into the repo.

**Testing**: `node:test` via `node --test scripts/__tests__/*.test.mjs` — **CI-enforced** since feature
041 added that glob to the `guardrails / naming` job (research R8, revised). New test files are gated
automatically with no workflow edit, but must be **deterministic, offline, token-free, and
`node:`-built-ins only** (they run on every push in a container with no forge access). `--selftest`
remains as a thin smoke check, no longer a duplicate of the suite.

**Target Platform**: Forgejo Actions self-hosted runner (labels `ubuntu-latest` container and `kvm`
host) for the write side; the dev container for the read side.

**Project Type**: Repository tooling / CI infrastructure. No application code, no new service, no
runtime surface in the product.

**Performance Goals**: Status lookup < 5 s (NFR-001). Achieved by querying `?head_sha=` (measured
0.92 s vs 94 s unfiltered) and never sending `limit` without `page`.

**Constraints**:
- Link to the forge is ~135 KB/s — transfer size is a latency constraint, not just context.
- `upload-artifact@v4` is unsupported by act_runner (v3 only).
- Container jobs (`ubuntu-latest`) have **no Docker CLI**, so container-health evidence exists only on
  `kvm` jobs; the digest must degrade cleanly rather than fail.
- `~/mcm-ci-last-failure/` is written by exactly one job today (`app-ci / app-e2e`).
- Single `kvm` runner — the write path must add negligible time to a job.

**Scale/Scope**: ~20 jobs across 4 workflows; 2 new scripts + 1 refactor; 1 new runbook.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Assessment | Verdict |
|---|---|---|
| **TDD (NON-NEGOTIABLE)** | Distiller, redactor, and roll-up classifier are pure functions. Tests are written first with a Verify RED, then implementation to GREEN, per `docs/templates/feature-test-tasks-template.md`. Both `__tests__` and `--selftest` assert the same cases. | ✅ Pass |
| **Test Type Integrity** | All tests here are genuine unit tests of pure functions plus subprocess CLI tests of real scripts. Nothing lives in a `tests/integration/` directory, so the no-mocking rule for integration tests is not engaged. The one real-forge exercise (smoke test) is explicitly manual and not labelled an integration test. | ✅ Pass |
| **Secrets Management** | No credential literal anywhere. Read token via `MCM_FORGE_TOKEN` (already provisioned through the devcontainer `${localEnv}` passthrough). Write token via a Forgejo Actions secret. No `?? 'literal'` fallbacks — a missing token aborts with the variable named (FR-019b/FR-020). Secrets passed by **env, never argv** (`check-no-argv-secrets.mjs` enforces this). | ✅ Pass |
| **Principle of Least Privilege** | The design *reduces* privilege on both sides: the read side uses a read-only token instead of the write-capable credential-fill one, and the write side gets a purpose-scoped token instead of the whitelisted-user `CD_PUSH_TOKEN`. | ✅ Pass — improves posture |
| **Logging & Sensitive Data Prohibition** | The digest is a publication channel more visible than a run log. Redaction is **fail-closed**: if a credential pattern still matches after redaction, the excerpt is dropped entirely rather than published (D4). | ✅ Pass |
| **Behavior-Descriptive Identifiers** | Identifiers describe behavior (`buildDigest`, `classifyRunState`, `redactForPublication`). Requirement IDs appear only in JSDoc provenance comments, never in names. | ✅ Pass |
| **Technology Agnosticism in Specification** | `spec.md` verified free of tool/product names; all technology lives here in `plan.md`. | ✅ Pass |
| **Documentation** | New `docs/runbooks/ci-diagnostics.md`; CLAUDE.md § *Driving CI/CD to green* updated to make self-serve the primary path with out-of-band demoted to the §7 fallback. | ✅ Pass |
| **Centralized Access Control / Deny by Default** | No new application endpoint is introduced; no request-handling surface. | ➖ N/A |
| **Feature 023 FR-004 / SC-009** | Both forbid credential **literals** in workflow files and require credentials to come from the CI secret store. `${{ secrets.CI_DIGEST_TOKEN }}` is exactly that prescribed pattern — it *satisfies* FR-004 rather than violating it. Verified: `check-no-inline-secrets.mjs` scans tracked compose files only, and `secret-scan.mjs` matches credential shapes, so both gates still pass. | ✅ Pass — see Complexity Tracking |

**Gate result: PASS. No constitutional deviation and no unjustified violation.**

## Key Design Decisions

### D1 — Direct `run:` step, not a composite action

The PRD specified a shared composite action at `.forgejo/actions/failure-digest/action.yml`. Research
found **no `.forgejo/actions/` directory and zero `action.yml` files anywhere in the repo** — this would
be the first local composite action, and act_runner's support for them is unverified against the
installed runner version.

Since the action would wrap a single `node scripts/ci-failure-digest.mjs` invocation, the packaging
buys nothing but risk. **Decision: add a 4-line `if: always()` `run:` step to each job.** All logic
lives in the script, so the duplicated YAML is inert and a behavior change means editing one file.

Revisit only if the per-job step grows conditional logic.

### D2 — A new purpose-scoped `CI_DIGEST_TOKEN`

| Candidate | Verdict |
|---|---|
| `GITHUB_TOKEN` (PRD default) | **Rejected.** Never used in this repo; documented as not push-whitelisted and declined by the pre-receive hook. Its issue/package scope is unverifiable from outside a job. |
| `CD_PUSH_TOKEN` (PRD fallback) | **Rejected as the default.** A whitelisted-user PAT with `write:repository` on protected `main`, currently confined to 2 jobs. Spreading it to ~20 jobs across 4 workflows is a material privilege expansion for a diagnostics feature. |
| **New `CI_DIGEST_TOKEN`** | **Chosen.** Scoped to `write:issue` + `write:package` + `read:repository` — exactly FR-006/007/008 and nothing else. Cannot push code, cannot touch protected `main`. |

FR-010 is still honoured: the script reads its token from an env var, so swapping it is a workflow
edit. This resolves the spec's flagged open risk by *removing* the unknown rather than tolerating it —
we mint a token whose scopes we chose, instead of guessing at an auto-token's.

### D3 — Evidence bundle identity and pruning

Package `ci-failures`, one **version per run + job** (`{run_id}--{job_slug}`), satisfying the
clarified FR-006 so two jobs failing in one run cannot overwrite each other. Pruning runs
opportunistically at publish (FR-021a): list versions, delete those older than 30 days, and **never let
a pruning failure fail the publish or the job** (FR-021b).

### D4 — Redaction is a new fail-closed module, not a reuse of `secret-scan.mjs`

This is the most safety-critical decision and the PRD's assumption did not survive contact.

`scripts/secret-scan.mjs` **detects**; it does not redact. It has zero exports, and its regexes carry
no `/g` flag — a naive `.replace()` would redact only the first occurrence and silently publish the
rest. The real redaction primitive is `scrubSecretsInText` in `zap-scan.mjs`.

Plan:
1. Refactor `secret-scan.mjs` to export `RULES` and `scanText` behind the repo's standard
   main-guard idiom (`if (invokedPath === fileURLToPath(import.meta.url)) main()`), copied from
   `check-dast-findings.mjs`. Its CLI behavior and both CI invocation sites are unaffected.
2. New `scripts/ci-digest-redact.mjs` exporting `redactForPublication(text)`, which:
   - applies globalised redaction patterns (JWTs, bearer tokens, `sk-ant-…`, session cookies),
   - redacts any `*.ts.net` host to `<forge>` using the **same pattern approach as
     `check-topology-scrub.mjs` — matching the shape, never embedding the literal**, so the redactor
     itself cannot leak the host it protects,
   - then **re-runs the `secret-scan` detection rules over the redacted output as a verification
     pass**. Any surviving match means the excerpt is **dropped wholesale**, not published.

Step 3 is the point: detection and redaction disagree at the edges, and on that edge the safe failure
is losing a log excerpt, never leaking a credential.

### D5 — Graceful degradation across runner types

Only `kvm` jobs have a Docker CLI; only `app-ci / app-e2e` writes `~/mcm-ci-last-failure/`. The digest
collects whatever is present and states plainly what was absent — it must never fail a job because
evidence it hoped for did not exist (FR-009).

A follow-on benefit worth noting: `app-ci / dast` has a much weaker capture today (no health JSON, no
persistence). Standardising collection in the script lifts it for free.

### D5a — Bundle format is gzipped JSON, not tar.zst (changed during implementation)

`bundle.tar.zst` would have needed a `zstd` binary on every runner (not guaranteed on
`node:22-bookworm`) or a tar/zstd npm dependency — and this whole script family is deliberately
zero-dependency, because `guardrails` runs with nothing installed. Node ships `zlib` in core, so a
single gzipped JSON manifest carries the same content with no new dependency and no new binary.

The cost is browsability, so `ci-status failure --full` **extracts the manifest into a real directory
tree** on retrieval — a human still browses files, not JSON. See
[contracts/bundle-layout.md](./contracts/bundle-layout.md).

### D6 — Read tooling is a direct invocation, no Nx target (resolves OQ-4)

Scanners (`dast`, `sast`, `infra-scan`) have Nx targets; gates do not. `ci-status.mjs` is agent-facing
and invoked constantly, where `node scripts/ci-status.mjs --sha X` is materially better than
`pnpm nx ci-status infrastructure-as-code -- --sha X`. It follows the sanctioned `maestro-run.sh`
precedent for direct invocation. No Nx target is added, so CLAUDE.md's "never invoke directly when an
Nx target exists" rule is not violated.

## Project Structure

### Documentation (this feature)

```text
specs/042-ci-self-serve-diagnostics/
├── plan.md              # This file
├── spec.md              # Feature specification (clarified)
├── research.md          # Phase 0 — measured findings and rejected alternatives
├── data-model.md        # Phase 1 — entities, states, identity, transitions
├── quickstart.md        # Phase 1 — runnable validation guide
├── contracts/
│   ├── ci-status-cli.md        # Read-side command surface + exit codes
│   ├── digest-format.md        # Published digest structure + upsert marker
│   └── bundle-layout.md        # Package naming, bundle contents, retention
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — created by /speckit-tasks, NOT by this command
```

### Source Code (repository root)

```text
scripts/
├── ci-failure-digest.mjs        # NEW — write side: collect → distill → redact → publish → prune
├── ci-status.mjs                # NEW — read side: status / watch / failure subcommands
├── ci-digest-redact.mjs         # NEW — fail-closed redaction (D4)
├── secret-scan.mjs              # MODIFIED — add exports behind a main-guard; CLI unchanged
└── __tests__/
    ├── ci-failure-digest.test.mjs   # NEW — distillation, tail-bias, capping, upsert marker
    ├── ci-status.test.mjs           # NEW — roll-up classification, host redaction, arg handling
    └── ci-digest-redact.test.mjs    # NEW — redaction + fail-closed verification pass

.forgejo/workflows/
├── app-ci.yml               # MODIFIED — digest step in each job
├── guardrails.yml           # MODIFIED — digest step (⚠️ pending approval, see below)
├── cd-deploy.yml            # MODIFIED — digest step in each job
└── infra-image-scan.yml     # MODIFIED — digest step in each job

docs/runbooks/
└── ci-diagnostics.md        # NEW — digest format, commands, bundle retrieval, token provisioning

CLAUDE.md                    # MODIFIED — § Driving CI/CD to green: self-serve becomes primary
```

**Structure Decision**: Pure repository tooling. Everything lands in the existing `scripts/` +
`.forgejo/workflows/` + `docs/runbooks/` layout, matching how features 031/033/035 shipped their
scanners and gates. No new top-level directory, no new workspace project, no application code touched.

## Complexity Tracking

**No constitutional violations. No unjustified complexity.**

### Resolved: the `guardrails.yml` "keyless" question (2026-07-19)

An apparent conflict was raised during planning and **investigated to ground truth rather than
escalated on its face**. Recording it because the initial reading was wrong in a way that would have
cost real scope.

**The apparent conflict**: `guardrails.yml`'s header comment states *"No credential literal appears in
this file — the agent golden gate runs keyless in replay mode, so no `${{ secrets }}` is referenced
(FR-004, SC-009)."* Read quickly, that looks like a standing prohibition on referencing secrets there,
which digest publication would break.

**What the cited requirements actually say** (`specs/023-forgejo-cicd/spec.md`):

- **FR-004** — *"Any credential referenced by a workflow MUST be sourced from the forge's CI
  secret/variable store; no credential **literal** may appear in a committed workflow file."*
- **SC-009** — *"…no credential **literal** appears in any committed workflow file."*

Both govern **literals**. Neither forbids a `${{ secrets }}` reference — sourcing from the CI secret
store is the pattern FR-004 *mandates*. The comment's clause is a **descriptive observation** about how
that file currently happens to look, not a normative rule derived from the requirements it cites.

**Gate verification** (not assumed):

| Gate | Scope | Effect on `${{ secrets.CI_DIGEST_TOKEN }}` |
|---|---|---|
| `check-no-inline-secrets.mjs` | Tracked **Docker Compose files only** | Not scanned — no effect |
| `secret-scan.mjs` | Whole tree, credential **shapes** | A `${{ secrets.X }}` reference is not credential-shaped — passes |

**Decision (approved 2026-07-19)**: add the digest step with `${{ secrets.CI_DIGEST_TOKEN }}` to
`guardrails.yml`, giving full G6 coverage including the fastest and most frequently-hit failures
(secret-scan, naming, SAST, agent gates). The token is purpose-scoped (`write:issue` + `write:package`)
and cannot push code or touch protected `main`, so blast radius stays small.

**Required follow-up**: update the `guardrails.yml` header comment so it stops asserting something no
longer true. It should say that no credential *literal* appears (the actual FR-004/SC-009 property) and
that the agent golden gate remains keyless in replay mode — while noting the scoped digest token as the
one referenced secret. No amendment to feature 023 is needed; its requirements are unchanged and still
satisfied.

**Rejected alternative**: an artifact-relay (guardrails uploads keyless, a `workflow_run`-triggered
workflow holds the token and publishes). It would preserve both properties but depends on two
unverified act_runner capabilities — `workflow_run` trigger support and cross-run artifact download on
`upload-artifact@v3` — for a property that turned out not to be required.

## Residual Risks Carried Forward

- **Pre-digest failures remain uncovered** (spec §Out of Scope) — runner crash, malformed workflow
  YAML, or a fault in the digest step itself publishes nothing. Knowingly accepted; the out-of-band
  route stays documented as the fallback.
- **The digest is a new leak surface.** D4's fail-closed verification pass is the mitigation and is the
  single thing most worth reviewing carefully in implementation and code review.
- **act_runner behavior on ~20 new `always()` steps** is unmeasured. Each is one short Node process, but
  the single `kvm` runner is a known bottleneck — measure the added wall-clock on the first real run
  and cap collection work if it is not negligible.
