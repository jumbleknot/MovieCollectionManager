---
description: "Task list for CI self-serve diagnostics (feature 042)"
---

# Tasks: CI Self-Serve Diagnostics

**Input**: Design documents from `specs/042-ci-self-serve-diagnostics/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md), [contracts/](./contracts/)

**Tests**: TDD is mandatory (constitution §TDD). Every test task carries the mandated **TDD checkpoint** — the acceptance scenarios it covers, a **Verify RED** command, and the expected failure output; every paired implementation task carries a **Verify GREEN** command. A Verify RED showing 0 failures means the test is trivially passing and must be fixed before implementation begins. The **expected RED** counts and messages below are predictions — they cannot be measured before the test exists. Replace each with the observed output when the task is executed; a prediction that turns out wrong is information, not a defect. All pure logic — redaction, state classification, merge roll-up, digest distillation, bundle assembly — is unit-tested RED-first via `node:test`. `scripts/__tests__/*.test.mjs` is **CI-enforced**: feature 041 added `node --test scripts/__tests__/*.test.mjs` to the `guardrails / naming` job, so new test files are gated automatically with no workflow edit (research R8, revised 2026-07-19). They must therefore be **deterministic, offline, token-free, and `node:`-built-ins only** — they run on every push in a container with no forge access, and a test needing a non-root dep is the exact `ajv` failure 041 removed. `--selftest` remains a thin smoke check, **not** a duplicate of the suite.

**Organization**: Grouped by the three user stories (US1 status roll-up · US2 failure reason · US3 full evidence) plus setup, foundational, and polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1 = know commit state · US2 = read why it failed · US3 = retrieve full evidence

## Authority notes

- **The forge API exposes no log/artifact endpoint.** That is the premise, measured (research R1). Do not spend time looking for one.
- **Query by `head_sha` always.** `?limit=N` alone is silently ignored and fetches 12.4 MB / 94 s (research R6). This is a correctness rule, not an optimization.
- **The write token's scopes are unobservable outside a running job.** T038 confirms on first real run; FR-010 keeps it a config change.

---

## Phase 1: Setup

- [ ] T001 Mint a new Forgejo access token `ci-digest-write` scoped to **`write:issue` + `write:package` + `read:repository`** and store it as the Forgejo Actions secret `CI_DIGEST_TOKEN`. **Operator task** — the token value never enters git. Deliberately NOT `CD_PUSH_TOKEN` (a whitelisted-user PAT able to push protected `main` — spreading it to ~20 jobs is a real privilege expansion, research R2) and NOT `GITHUB_TOKEN` (unused in this repo, declined by the pre-receive hook).
- [ ] T002 [P] Verify the read credential is live: `[ -n "$MCM_FORGE_TOKEN" ]` in the dev container, and confirm it reaches `issues/{n}/comments` (200), packages list (200), and package `GET` (404 = auth OK, package absent). Already provisioned via the `devcontainer.json` `${localEnv}` passthrough (commit `7ab4ff2`) — this task confirms, it does not re-provision.
- [ ] T003 [P] Capture offline API fixtures into `scripts/__tests__/fixtures/ci/` for deterministic tests. **These are load-bearing**: since feature 041, `scripts/__tests__/*.test.mjs` runs in CI on every push with no forge access and no token, so every test must be driven from fixtures. Capture: a `head_sha` runs listing, a commit-statuses payload with all-required-green, one with a skipped gated job, one with a **cancelled** run (all contexts reading `failure`), and one with a failing non-required context. Redact hosts in the fixtures themselves.

---

## Phase 2: Foundational (blocking prerequisites)

**⚠️ CRITICAL**: Redaction and the API client are the substrate all three stories build on. Redaction blocks US1 too — FR-017 host redaction applies to read-side output, not just published digests.

- [ ] T004 Refactor `scripts/secret-scan.mjs` to export `RULES` and `scanText` behind the repo's standard main-guard idiom (`const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''; if (invokedPath === fileURLToPath(import.meta.url)) main();` — copy from `scripts/check-dast-findings.mjs`). **Do not change any detection rule.** Regression-verify the live gate is unaffected: `node scripts/secret-scan.mjs --selftest` then `node scripts/secret-scan.mjs` both exit 0, and `.forgejo/workflows/guardrails.yml` still passes (it invokes the script as a subprocess and never imports it).
- [ ] T005 [P] Write unit tests FIRST (RED) in `scripts/__tests__/ci-digest-redact.test.mjs` for `redactForPublication(text)`: (a) **every** occurrence of a repeated credential is redacted, not just the first — the non-global-regex trap from research R4; (b) JWTs, `Bearer …`, `sk-ant-…`, and `mcm_*_token=` cookies are rewritten; (c) any `*.ts.net` host → `<forge>` while `tailnet`/`example` placeholder hosts are left alone; (d) **fail-closed** — text that still matches a `secret-scan` rule after redaction causes the excerpt to be dropped and replaced with the withheld-notice, not published. Verify RED (module absent).
  **Scenarios**: US2-AC6 (published summary is credential-free), US1-AC6 (no host literal in output).
  **Verify RED**: `node --test scripts/__tests__/ci-digest-redact.test.mjs`
  **Expected RED**: 4 tests failing — `Cannot find module '../ci-digest-redact.mjs'`
- [ ] T006 Implement `scripts/ci-digest-redact.mjs` to GREEN, exporting `redactForPublication(text)`. Globalise every pattern (`new RegExp(re.source, re.flags + 'g')`) — the imported `secret-scan` rules carry no `/g` and a naive `.replace()` would silently publish every occurrence after the first. Match the forge host **by shape** (`*.ts.net`), never by embedding the literal, mirroring `check-topology-scrub.mjs` so the redactor cannot leak what it protects. Run the imported detection rules over the redacted output as a verification pass and drop any still-matching excerpt. Add a thin `--selftest` smoke check (not a duplicate of T005 — `scripts/__tests__/ci-digest-redact.test.mjs` is authoritative and CI-enforced).
  **Verify GREEN**: `node --test scripts/__tests__/ci-digest-redact.test.mjs` → `# fail 0`
  **Regression**: `node scripts/secret-scan.mjs && node scripts/check-topology-scrub.mjs` → both exit 0
- [ ] T007 [P] Write unit tests FIRST (RED) in `scripts/__tests__/ci-status.test.mjs` for the API-access core (the client stays module-private inside `ci-status.mjs` per plan.md D6 — no separate module, no separate test file): (a) a lookup builds a `?head_sha=<full-sha>` query and **rejects an abbreviated SHA** (exact-match filter — a short SHA silently returns nothing, which would read as "no runs"); (b) a listing always sends `page` **with** `limit`; (c) `status`/`event`/`branch` are applied client-side, never sent; (d) a 401/403 maps to a message **naming the missing scope**, not a bare code; (e) a missing `MCM_FORGE_TOKEN` aborts naming the variable, with no fallback literal; (f) the read path **never shells to `git credential fill`** (FR-018's negative clause — that credential is write-capable yet cannot reach issues or packages). Verify RED.
  **Scenarios**: US1-AC6 (no raw payload emitted), plus FR-019b/FR-020 (named-failure contract).
  **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  **Expected RED**: 6 tests failing — `Cannot find module '../ci-status.mjs'`
- [ ] T008 Implement the forge API client core to GREEN inside `scripts/ci-status.mjs` (no shared util module — the repo has none; every script re-derives `REPO_ROOT`). Read the token from env **only, never argv** (`check-no-argv-secrets.mjs` enforces this). Cache raw responses to the session scratchpad and return parsed objects; never return raw text to a caller that prints.
  **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → `# fail 0`

**Checkpoint**: `node --test scripts/__tests__/*.test.mjs` green (the exact command CI now runs); `node scripts/ci-digest-redact.mjs --selftest` green; `node scripts/secret-scan.mjs` still exits 0 (refactor regression clean).

---

## Phase 3: User Story 1 — Know the state of a commit without a human (Priority: P1) 🎯 MVP

**Goal**: One sub-5-second call reports per-check state and the required-context merge verdict for a commit, PR, or branch.

**Independent Test**: Query a known commit; the reported per-check results and the mergeable/not-mergeable verdict match what the forge's own merge gate reports, with zero human transcription. Delivers value even if no digest is ever published.

- [ ] T009 [US1] Write unit tests FIRST (RED) in `scripts/__tests__/ci-status.test.mjs` for `classifyCheckState(context, run)` covering all five states and **both traps**: (a) `success` → `passed`; (b) `failure` on a live run → `failed`; (c) a gated job that skipped settles to `success`/`skipped` → **`skipped`, counted satisfied** (FR-012); (d) `pending` → `waiting` (FR-013); (e) contexts reading `failure` while **`run.status === 'cancelled'`** → **`superseded`, never `failed`** (FR-014). Use the T003 fixtures. Verify RED.
  **Scenarios**: US1-AC1 (all pass → mergeable), US1-AC2 (skipped → satisfied), US1-AC3 (queued → waiting), US1-AC4 (cancelled → superseded).
  **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  **Expected RED**: 5 tests failing — `classifyCheckState is not a function`
- [ ] T010 [US1] Implement `classifyCheckState` in `scripts/ci-status.mjs` to GREEN. The cancelled cross-check reads the **run's own `status`**, not the context status — the commit-status endpoint reports a cancelled run's contexts as `failure` for a commit that was never broken.
  **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → `# fail 0`
- [ ] T011 [US1] Write unit tests FIRST (RED) in `scripts/__tests__/ci-status.test.mjs` for `computeMergeVerdict(checks, requiredGlobs)`: required-only computation (FR-011a); `skipped` satisfies; a failing **non-required** context lands in `advisory` and leaves `mergeable` true (FR-011b); a **zero-match glob is treated as satisfied** (matching branch-protection behavior); `superseded` contexts are excluded entirely. Verify RED.
  **Scenarios**: US1-AC1, US1-AC2, US1-AC5 (non-required failure stays advisory, commit still mergeable).
  **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  **Expected RED**: 5 tests failing — `computeMergeVerdict is not a function`
- [ ] T012 [US1] Implement `computeMergeVerdict` in `scripts/ci-status.mjs` to GREEN with the required-context glob set (`guardrails*`, `app-ci / changes*`, `app-ci / affected*`, `app-ci / mc-service-checks*`, `app-ci / app-e2e*`). `trigger-cd` and `dast` are **not** required.
  **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → `# fail 0`
- [ ] T013 [US1] Implement the `status [--sha | --pr | --branch]` subcommand and its table renderer per [contracts/ci-status-cli.md](./contracts/ci-status-cli.md), defaulting to `HEAD`. Render REQUIRED / ADVISORY sections and the verdict line; annotate `skipped` as satisfied so it doesn't read as a gap; annotate `superseded` as `(newer push)`. Route every emitted string through `redactForPublication` so the forge host is `<forge>` **by construction** (FR-017), and print the scratchpad path instead of any raw payload (FR-016).
- [ ] T014 [US1] Implement the `watch [--timeout]` subcommand in `scripts/ci-status.mjs`: poll until settled; exit `0` mergeable, `1` genuine required failure, **`3` still-waiting at timeout** (FR-013). Default timeout 45 min (app-e2e alone is ~23 min and queues behind the single kvm runner). Exit 3 must be distinct from 1 — a poller that fails on starvation reports a saturated queue as a broken build.
- [ ] T015 [US1] Add a thin `--selftest` smoke check to `scripts/ci-status.mjs` — load the module, classify one canned cancelled-run fixture, and confirm host redaction fires. **Not** a duplicate of T009/T011: `scripts/__tests__/ci-status.test.mjs` is the authoritative suite and is CI-enforced by the feature-041 glob (research R8, revised).
- [ ] T016 [US1] Verify NFR-001 against the real forge: `time node scripts/ci-status.mjs status --sha "$(git rev-parse HEAD)"` completes in **< 5 s**. A ~90 s result means the query dropped `head_sha` and is fetching all 12.4 MB. Also confirm `node scripts/ci-status.mjs status | grep -iE '\.ts\.net|token|bearer'` returns nothing. **After US2 lands**, time the second half of SC-003 too: status → `failure` end-to-end must complete in **< 1 min**.

**Checkpoint**: US1 is independently shippable — status and watch work against the real forge, all four classification traps behave, nothing leaks. **This is the MVP.**

---

## Phase 4: User Story 2 — Read why a job failed (Priority: P2)

**Goal**: Every job publishes a small, redacted, tail-biased digest that the agent reads through the channel it already uses for status.

**Independent Test**: Cause a deliberate failure on a throwaway branch; retrieve the failing step's name and a usable output excerpt entirely via the API, with no web UI and no human relay.

- [ ] T017 [US2] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for the pure distiller: (a) excerpts are drawn from the **end** of a source (FR-003 — a head-biased excerpt is worthless, failures surface last); (b) the per-source cap (200 lines / 32 KB) is enforced **per source**, not globally; (c) truncation is **stated** (`4,812 → 200 lines`), never silent; (d) absent evidence is listed under **Not collected** rather than omitted; (e) the upsert marker `<!-- ci-digest:job=<slug> -->` is emitted and re-parsed idempotently across retries (FR-007); (f) the digest carries **all five identity fields** — workflow, job, failing step, commit SHA, and PR number where applicable (FR-002). Verify RED.
  **Scenarios**: US2-AC1 (identifies pipeline/job/step/commit/PR), US2-AC2 (tail-biased and capped), US2-AC3 (health evidence included), US2-AC4 (retry replaces in place).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Expected RED**: 6 tests failing — `Cannot find module '../ci-failure-digest.mjs'`
- [ ] T018 [US2] Implement the distiller in `scripts/ci-failure-digest.mjs` to GREEN, producing the markdown in [contracts/digest-format.md](./contracts/digest-format.md). Pass **every** field through `redactForPublication` before it leaves the runner (FR-005).
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [ ] T019 [US2] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for the publish guard: a job whose run is **cancelled/superseded publishes nothing** — no digest, no bundle (FR-001a). Without this, one rapid re-push upserts a failure comment for every cancelled job on a commit that was never broken. Verify RED.
  **Scenarios**: US2-AC5 (no-PR failures still published), US2-AC7 (job outcome unchanged), FR-001a (cancelled publishes nothing).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Expected RED**: 3 tests failing — `shouldPublish is not a function`
- [ ] T020 [US2] Implement publish routing to GREEN: cross-check the run's own state and suppress on cancelled; then route by event — `pull_request` → **upsert** a PR comment matched by marker (list comments, edit if found, create if not); `push`/`workflow_dispatch` → commit status with `target_url` pointing at the bundle (FR-007, FR-008). Auth from `CI_DIGEST_TOKEN` via env.
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [ ] T021 [US2] Implement opportunistic collection: the feature-036 `~/mcm-ci-last-failure/` bundle, per-container `docker logs` + `docker inspect .State.Health` + `docker ps -a`, and any test output present (jest, Playwright report, Maestro screenshots). **Degrade cleanly** — container jobs (`ubuntu-latest` / `node:22-bookworm`) have **no Docker CLI**, and `~/mcm-ci-last-failure/` is written by exactly one job today (`app-ci / app-e2e`, research R7). Record what was absent; never fail because expected evidence was missing.
- [ ] T022 [US2] Add a thin `--selftest` smoke check to `scripts/ci-failure-digest.mjs` — build one digest from a canned fixture and confirm the redaction pass and upsert marker fire. **Not** a duplicate of T017/T019, which are CI-enforced via `scripts/__tests__/`.
- [ ] T023 [US2] Add an `if: always()` + `continue-on-error: true` digest step to every job in `.forgejo/workflows/app-ci.yml` (`changes`, `affected`, `mc-service-checks`, `app-e2e`, `dast`, `trigger-cd`), invoking `node scripts/ci-failure-digest.mjs` with `CI_DIGEST_TOKEN` in `env:`. **A direct `run:` step, not a composite action** — `.forgejo/actions/` does not exist and act_runner's composite support is unverified (research R3). On `app-e2e`, place it **after** the existing feature-036 capture so the bundle exists.
- [ ] T024 [US2] Add the same step to every job in `.forgejo/workflows/guardrails.yml` (`secret-scan`, `naming`, `agent-gates`, `sast`) **and correct the file's header comment**, which currently asserts *"no `${{ secrets }}` is referenced (FR-004, SC-009)"* — no longer true, and it overstated those requirements, which govern credential **literals** only. Rewrite to: no credential *literal* appears; the agent golden gate remains keyless in replay mode; the scoped `CI_DIGEST_TOKEN` is the one referenced secret. No feature-023 amendment is needed (plan.md § Complexity Tracking).
- [ ] T025 [US2] [P] Add the same step to every job in the remaining **four** workflow files, so all **six** in `.forgejo/workflows/` are covered and FR-001 admits no exception list: `cd-deploy.yml` (`build-deploy`, `prod-apk`), `infra-image-scan.yml` (`changes`, `infra-image-scan`), `devcontainer-image.yml`, and `renovate.yml`. The last two are a build and a maintenance bot rather than check pipelines, but their failures are equally undiagnosable today and covering them is cheaper than maintaining a carve-out.
- [ ] T026 [US2] Implement the `failure [--sha | --run] [--job]` subcommand in `scripts/ci-status.mjs`: locate the digest (PR comment by marker, else commit status) for each genuinely failed job and print it. When no digest exists, say so and name the likely cause — the pre-digest residual risk — rather than reporting an empty result as "no failure".
- [ ] T027 [US2] Smoke-test the write path on a throwaway branch per [quickstart.md](./quickstart.md) §5: deliberate failing step → PR → confirm (1) the job still fails and the digest did **not** mask it (FR-009), (2) the comment appears with its marker, (3) a re-run **edits rather than duplicates**, (4) `ci-status failure` prints it, (5) no credential and no `.ts.net` host appears, (6) an immediate second push cancels the run and **publishes nothing** (FR-001a). Delete the branch, PR, and test artifacts afterward.

**Checkpoint**: A real CI failure is diagnosable end-to-end without opening the web UI or asking a human.

---

## Phase 5: User Story 3 — Retrieve the complete evidence on demand (Priority: P3)

**Goal**: The full bundle for a failed job is retrievable through the same read channel, with no new standing access to the build host.

**Independent Test**: For a known failure, fetch the complete evidence set and confirm it contains material beyond the digest excerpt.

- [ ] T028 [US3] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for bundle assembly: (a) the version key is **`{runId}--{jobSlug}`**, so two jobs failing in the same run yield **two** bundles and neither overwrites the other (clarified FR-006 — jobs fail together routinely, most notably when a cancelled run fails every context at once); (b) the 5 MB cap truncates **largest-source-first** and records the truncation in `meta.json`, so a bundle never silently misrepresents itself as complete. Verify RED.
  **Scenarios**: US3-AC1 (bundle retrieved to disk), US3-AC2 (summary points to it), US3-AC3 (size capped).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Expected RED**: 2 tests failing — `buildBundle is not a function`
- [ ] T029 [US3] Implement bundle assembly and upload to GREEN per [contracts/bundle-layout.md](./contracts/bundle-layout.md): build `meta.json` + `logs/` + `health/` + `ps.txt` + `test-output/`, compress, and `PUT` to the generic package registry as `ci-failures/{runId}--{jobSlug}/bundle.tar.zst` using `CI_DIGEST_TOKEN` (`write:package`). Redaction applies to bundle contents too — it is as publishable as the digest.
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [ ] T030 [US3] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for retention: versions older than **30 days** are selected for pruning; a pruning failure is **swallowed** and never fails the publish or the job (FR-021b). Verify RED.
  **Scenarios**: no direct acceptance scenario — covers FR-021/021a/021b (retention window and swallowed pruning failure).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Expected RED**: 2 tests failing — `pruneExpiredBundles is not a function`
- [ ] T031 [US3] Implement opportunistic pruning in `scripts/ci-failure-digest.mjs` to GREEN — at publish time, list versions and delete those past the 30-day window (FR-021a). **No new scheduled workflow.** Accepted trade-off, already recorded: if failures stop entirely, expired bundles linger until the next failure publishes.
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [ ] T032 [US3] Implement `failure --full` in `scripts/ci-status.mjs`: download the bundle to the session scratchpad and print **the path, not the contents** (FR-016). At the measured ~135 KB/s, the 5 MB cap is ≈40 s — report progress rather than appearing hung.
- [ ] T033 [US3] Verify SC-010 against the real forge: induce two jobs failing in one run and confirm **two** independently retrievable bundles exist with neither overwriting the other.

**Checkpoint**: Full evidence retrievable on demand; retention bounded; no new standing host access.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T034 [P] Write `docs/runbooks/ci-diagnostics.md`: the digest format, the `ci-status.mjs` command surface and exit codes (including **why exit 3 ≠ failure**), bundle retrieval, the four classification traps, read-token provisioning (required scopes; `setx` on the host — noting that `setx` affects only newly-launched processes, so VS Code must be **fully quit**, not reloaded), and `CI_DIGEST_TOKEN` provisioning. No forge host literal, no token value.
- [ ] T035 [P] Update `CLAUDE.md` § *Driving CI/CD to green*: self-serve becomes the primary path; the out-of-band `~/mcm-ci-last-failure/` route is demoted to the documented fallback for the pre-digest failure class. Keep the measured `head_sha`/`page`+`limit` query guidance — it remains true and load-bearing.
- [ ] T036 Calibrate the caps (OQ-3) against a real `app-e2e` failure: confirm 200 lines / 32 KB per source actually captures the failing assertion, and that the 5 MB bundle cap holds. Adjust and record the measured basis in the runbook. Bounded on two sides — agent context **and** the ~135 KB/s link.
- [ ] T037 Measure the write path's added wall-clock across ~20 new `always()` steps, especially on the capacity-1 `kvm` runner. If not negligible, cap collection work. Record the measurement.
- [ ] T038 Confirm `CI_DIGEST_TOKEN`'s scopes on the first real run (OQ-1's remaining half — unobservable outside a running job). A `401`/`403` must name the missing scope (FR-020), not surface a bare code. If insufficient, it is a token-scope config change, not a redesign (FR-010).
- [ ] T039 Run the full validation checklist in [quickstart.md](./quickstart.md) §7 and update `specs/042-ci-self-serve-diagnostics/checklists/requirements.md` if any spec drift surfaced during implementation (constitution: artifacts must stay aligned). Record the platform-parity table as **N/A** — this feature has no web/mobile client surface.

---

## Dependencies

```text
Phase 1 (Setup)
   └─> Phase 2 (Foundational: redaction + API client)   ← blocks everything
          ├─> Phase 3  US1  (status + watch)             ← MVP, independently shippable
          ├─> Phase 4  US2  (digest publish + read)      ← needs T001 CI_DIGEST_TOKEN
          │      └─> Phase 5  US3  (bundle + retention)  ← needs US2's publish path
          └─> Phase 6 (Polish)
```

**Story independence**:
- **US1 depends on nothing but Phase 2.** It reads status straight from the API and ships alone.
- **US2 depends on Phase 2 + T001** (the write token). It does not depend on US1 — but `ci-status failure` (T026) reuses US1's client, so building US1 first avoids duplication.
- **US3 depends on US2**, since the bundle is published by the same write path. `--full` retrieval (T032) is meaningless before bundles exist.

**Critical path**: T004 → T006 → T008 → T010 → T012 → T013 (MVP)

## Parallel Opportunities

| Phase | Parallelizable | Why safe |
|---|---|---|
| Setup | T002, T003 | Different concerns; T001 is an operator action that can run alongside |
| Foundational | T005 ∥ T007 | Different test files, no shared module yet |
| US1 | *(none)* | T009/T011 share `ci-status.test.mjs`; T010/T012 share `ci-status.mjs` — sequential |
| US2 | T025 ∥ T023/T024 | Different workflow files. T017/T019 share `ci-failure-digest.test.mjs` — sequential |
| US3 | *(none)* | T028/T030 share `ci-failure-digest.test.mjs` — sequential |
| Polish | T034 ∥ T035 | Different documents |

**Note**: T023, T024, T025 all add the same step to different workflow files — parallel-safe, but keep the step body identical so a future change is one edit.

**`[P]` discipline**: a task is only `[P]` if it touches a file no concurrent task touches. Several test tasks that looked parallel share a single test file and are therefore sequential — the marker was corrected rather than the definition loosened.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1).** That alone removes most human round-trips: the agent learns whether a commit is green, broken, waiting, or superseded without anyone opening the web UI. It ships and delivers value before a single digest is ever published.

**Increment 2 = Phase 4 (US2)** — the feature's core value, answering *why*. Requires the operator to have completed T001.

**Increment 3 = Phase 5 (US3)** — the fallback for failures the excerpt cannot explain. Genuinely optional; most diagnoses will end at US2.

**Two rules that outrank velocity**:

1. **FR-009 — never change a job's outcome.** Every write-side step is `if: always()` + `continue-on-error: true`, and every internal error is caught and swallowed after being reported. This must hold even if everything else in the feature is wrong.
2. **FR-005 — the digest is a new leak surface.** A PR comment is far more visible than a run log. The fail-closed verification pass (T006) is the mitigation and is the single thing most worth scrutinising in code review. Losing a log excerpt is acceptable; leaking a credential is not.
