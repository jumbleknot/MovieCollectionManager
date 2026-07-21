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

- [X] T001 Mint a new Forgejo access token `ci-digest-write` scoped to **`write:issue` + `write:package` + `read:repository`** and store it as the Forgejo Actions secret `CI_DIGEST_TOKEN`. **Operator task** — the token value never enters git. Deliberately NOT `CD_PUSH_TOKEN` (a whitelisted-user PAT able to push protected `main` — spreading it to ~20 jobs is a real privilege expansion, research R2) and NOT `GITHUB_TOKEN` (unused in this repo, declined by the pre-receive hook). ⛔ **BLOCKED — operator action.** Everything else is built and unit-tested; the write path degrades to printing the digest inline until this exists.
  **DONE 2026-07-19** — operator minted `ci-digest-write` and stored it as the Actions secret `CI_DIGEST_TOKEN`. Confirmed present in the repo secret list.
- [X] T002 [P] Verify the read credential is live: `[ -n "$MCM_FORGE_TOKEN" ]` in the dev container, and confirm it reaches `issues/{n}/comments` (200), packages list (200), and package `GET` (404 = auth OK, package absent). Already provisioned via the `devcontainer.json` `${localEnv}` passthrough (commit `7ab4ff2`) — this task confirms, it does not re-provision.
- [X] T003 [P] Capture offline API fixtures into `scripts/__tests__/fixtures/ci/` for deterministic tests. **These are load-bearing**: since feature 041, `scripts/__tests__/*.test.mjs` runs in CI on every push with no forge access and no token, so every test must be driven from fixtures. Capture: a `head_sha` runs listing, a commit-statuses payload with all-required-green, one with a skipped gated job, one with a **cancelled** run (all contexts reading `failure`), and one with a failing non-required context. Redact hosts in the fixtures themselves.

---

## Phase 2: Foundational (blocking prerequisites)

**⚠️ CRITICAL**: Redaction and the API client are the substrate all three stories build on. Redaction blocks US1 too — FR-017 host redaction applies to read-side output, not just published digests.

- [X] T004 Refactor `scripts/secret-scan.mjs` to export `RULES` and `scanText` behind the repo's standard main-guard idiom (`const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''; if (invokedPath === fileURLToPath(import.meta.url)) main();` — copy from `scripts/check-dast-findings.mjs`). **Do not change any detection rule.** Regression-verify the live gate is unaffected: `node scripts/secret-scan.mjs --selftest` then `node scripts/secret-scan.mjs` both exit 0, and `.forgejo/workflows/guardrails.yml` still passes (it invokes the script as a subprocess and never imports it).
- [X] T005 [P] Write unit tests FIRST (RED) in `scripts/__tests__/ci-digest-redact.test.mjs` for `redactForPublication(text)`: (a) **every** occurrence of a repeated credential is redacted, not just the first — the non-global-regex trap from research R4; (b) JWTs, `Bearer …`, `sk-ant-…`, and `mcm_*_token=` cookies are rewritten; (c) any `*.ts.net` host → `<forge>` while `tailnet`/`example` placeholder hosts are left alone; (d) **fail-closed** — text that still matches a `secret-scan` rule after redaction causes the excerpt to be dropped and replaced with the withheld-notice, not published. Verify RED (module absent).
  **Scenarios**: US2-AC6 (published summary is credential-free), US1-AC6 (no host literal in output).
  **Verify RED**: `node --test scripts/__tests__/ci-digest-redact.test.mjs`
  **Observed RED** (2026-07-19): `ℹ pass 0 / ℹ fail 1` — `ERR_MODULE_NOT_FOUND` for
  `scripts/ci-digest-redact.mjs`. The predicted "4 tests failing" was wrong in shape: a missing
  module aborts the whole file before individual tests register, so the count is 1, not per-test.
  **Observed GREEN**: `ℹ tests 8 / ℹ pass 8 / ℹ fail 0`.
- [X] T006 Implement `scripts/ci-digest-redact.mjs` to GREEN, exporting `redactForPublication(text)`. Globalise every pattern (`new RegExp(re.source, re.flags + 'g')`) — the imported `secret-scan` rules carry no `/g` and a naive `.replace()` would silently publish every occurrence after the first. Match the forge host **by shape** (`*.ts.net`), never by embedding the literal, mirroring `check-topology-scrub.mjs` so the redactor cannot leak what it protects. Run the imported detection rules over the redacted output as a verification pass and drop any still-matching excerpt. Add a thin `--selftest` smoke check (not a duplicate of T005 — `scripts/__tests__/ci-digest-redact.test.mjs` is authoritative and CI-enforced).
  **Verify GREEN**: `node --test scripts/__tests__/ci-digest-redact.test.mjs` → `# fail 0`
  **Regression**: `node scripts/secret-scan.mjs && node scripts/check-topology-scrub.mjs` → both exit 0
- [X] T007 [P] Write unit tests FIRST (RED) in `scripts/__tests__/ci-status.test.mjs` for the API-access core (the client stays module-private inside `ci-status.mjs` per plan.md D6 — no separate module, no separate test file): (a) a lookup builds a `?head_sha=<full-sha>` query and **rejects an abbreviated SHA** (exact-match filter — a short SHA silently returns nothing, which would read as "no runs"); (b) a listing always sends `page` **with** `limit`; (c) `status`/`event`/`branch` are applied client-side, never sent; (d) a 401/403 maps to a message **naming the missing scope**, not a bare code; (e) a missing `MCM_FORGE_TOKEN` aborts naming the variable, with no fallback literal; (f) the read path **never shells to `git credential fill`** (FR-018's negative clause — that credential is write-capable yet cannot reach issues or packages). Verify RED.
  **Scenarios**: US1-AC6 (no raw payload emitted), plus FR-019b/FR-020 (named-failure contract).
  **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  **Observed RED** (2026-07-19): `ℹ pass 0 / ℹ fail 1` — ERR_MODULE_NOT_FOUND. **Observed GREEN**: 12/12.
- [X] T008 Implement the forge API client core to GREEN inside `scripts/ci-status.mjs` (no shared util module — the repo has none; every script re-derives `REPO_ROOT`). Read the token from env **only, never argv** (`check-no-argv-secrets.mjs` enforces this). Cache raw responses to the session scratchpad and return parsed objects; never return raw text to a caller that prints.
  **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → `# fail 0`

**Checkpoint**: `node --test scripts/__tests__/*.test.mjs` green (the exact command CI now runs); `node scripts/ci-digest-redact.mjs --selftest` green; `node scripts/secret-scan.mjs` still exits 0 (refactor regression clean).

---

## Phase 3: User Story 1 — Know the state of a commit without a human (Priority: P1) 🎯 MVP

**Goal**: One sub-5-second call reports per-check state and the required-context merge verdict for a commit, PR, or branch.

**Independent Test**: Query a known commit; the reported per-check results and the mergeable/not-mergeable verdict match what the forge's own merge gate reports, with zero human transcription. Delivers value even if no digest is ever published.

- [X] T009 [US1] Write unit tests FIRST (RED) in `scripts/__tests__/ci-status.test.mjs` for `classifyCheckState(context, run)` covering all five states and **both traps**: (a) `success` → `passed`; (b) `failure` on a live run → `failed`; (c) a gated job that skipped settles to `success`/`skipped` → **`skipped`, counted satisfied** (FR-012); (d) `pending` → `waiting` (FR-013); (e) contexts reading `failure` while **`run.status === 'cancelled'`** → **`superseded`, never `failed`** (FR-014). Use the T003 fixtures. Verify RED.
  **Scenarios**: US1-AC1 (all pass → mergeable), US1-AC2 (skipped → satisfied), US1-AC3 (queued → waiting), US1-AC4 (cancelled → superseded).
  **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  **Observed RED** (2026-07-19): SyntaxError — no export named `classifyCheckState`. **Observed GREEN**: 21/21.
- [X] T010 [US1] Implement `classifyCheckState` in `scripts/ci-status.mjs` to GREEN. The cancelled cross-check reads the **run's own `status`**, not the context status — the commit-status endpoint reports a cancelled run's contexts as `failure` for a commit that was never broken.
  **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → `# fail 0`
- [X] T011 [US1] Write unit tests FIRST (RED) in `scripts/__tests__/ci-status.test.mjs` for `computeMergeVerdict(checks, requiredGlobs)`: required-only computation (FR-011a); `skipped` satisfies; a failing **non-required** context lands in `advisory` and leaves `mergeable` true (FR-011b); a **zero-match glob is treated as satisfied** (matching branch-protection behavior); `superseded` contexts are excluded entirely. Verify RED.
  **Scenarios**: US1-AC1, US1-AC2, US1-AC5 (non-required failure stays advisory, commit still mergeable).
  **Verify RED**: `node --test scripts/__tests__/ci-status.test.mjs`
  **Observed RED** (2026-07-19): SyntaxError — no export named `REQUIRED_CONTEXT_GLOBS`. **Observed GREEN**: 30/30.
- [X] T012 [US1] Implement `computeMergeVerdict` in `scripts/ci-status.mjs` to GREEN with the required-context glob set (`guardrails*`, `app-ci / changes*`, `app-ci / affected*`, `app-ci / mc-service-checks*`, `app-ci / app-e2e*`). `trigger-cd` and `dast` are **not** required.
  **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs` → `# fail 0`
- [X] T013 [US1] Implement the `status [--sha | --pr | --branch]` subcommand and its table renderer per [contracts/ci-status-cli.md](./contracts/ci-status-cli.md), defaulting to `HEAD`. Render REQUIRED / ADVISORY sections and the verdict line; annotate `skipped` as satisfied so it doesn't read as a gap; annotate `superseded` as `(newer push)`. Route every emitted string through `redactForPublication` so the forge host is `<forge>` **by construction** (FR-017), and print the scratchpad path instead of any raw payload (FR-016).
- [X] T014 [US1] Implement the `watch [--timeout]` subcommand in `scripts/ci-status.mjs`: poll until settled; exit `0` mergeable, `1` genuine required failure, **`3` still-waiting at timeout** (FR-013). Default timeout 45 min (app-e2e alone is ~23 min and queues behind the single kvm runner). Exit 3 must be distinct from 1 — a poller that fails on starvation reports a saturated queue as a broken build.
- [X] T015 [US1] Add a thin `--selftest` smoke check to `scripts/ci-status.mjs` — load the module, classify one canned cancelled-run fixture, and confirm host redaction fires. **Not** a duplicate of T009/T011: `scripts/__tests__/ci-status.test.mjs` is the authoritative suite and is CI-enforced by the feature-041 glob (research R8, revised).
- [X] T016 [US1] Verify NFR-001 against the real forge: `time node scripts/ci-status.mjs status --sha "$(git rev-parse HEAD)"` completes in **< 5 s**. A ~90 s result means the query dropped `head_sha` and is fetching all 12.4 MB. Also confirm `node scripts/ci-status.mjs status | grep -iE '\.ts\.net|token|bearer'` returns nothing. **After US2 lands**, time the second half of SC-003 too: status → `failure` end-to-end must complete in **< 1 min**.

**Checkpoint**: US1 is independently shippable — status and watch work against the real forge, all four classification traps behave, nothing leaks. **This is the MVP.**

---

## Phase 4: User Story 2 — Read why a job failed (Priority: P2)

**Goal**: Every job publishes a small, redacted, tail-biased digest that the agent reads through the channel it already uses for status.

**Independent Test**: Cause a deliberate failure on a throwaway branch; retrieve the failing step's name and a usable output excerpt entirely via the API, with no web UI and no human relay.

- [X] T017 [US2] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for the pure distiller: (a) excerpts are drawn from the **end** of a source (FR-003 — a head-biased excerpt is worthless, failures surface last); (b) the per-source cap (200 lines / 32 KB) is enforced **per source**, not globally; (c) truncation is **stated** (`4,812 → 200 lines`), never silent; (d) absent evidence is listed under **Not collected** rather than omitted; (e) the upsert marker `<!-- ci-digest:job=<slug> -->` is emitted and re-parsed idempotently across retries (FR-007); (f) the digest carries **all five identity fields** — workflow, job, failing step, commit SHA, and PR number where applicable (FR-002). Verify RED.
  **Scenarios**: US2-AC1 (identifies pipeline/job/step/commit/PR), US2-AC2 (tail-biased and capped), US2-AC3 (health evidence included), US2-AC4 (retry replaces in place).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Observed RED** (2026-07-19): `ℹ pass 0 / ℹ fail 1` — ERR_MODULE_NOT_FOUND. **Observed GREEN**: 19/19.
- [X] T018 [US2] Implement the distiller in `scripts/ci-failure-digest.mjs` to GREEN, producing the markdown in [contracts/digest-format.md](./contracts/digest-format.md). Pass **every** field through `redactForPublication` before it leaves the runner (FR-005).
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [X] T019 [US2] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for the publish guard: a job whose run is **cancelled/superseded publishes nothing** — no digest, no bundle (FR-001a). Without this, one rapid re-push upserts a failure comment for every cancelled job on a commit that was never broken. Verify RED.
  **Scenarios**: US2-AC5 (no-PR failures still published), US2-AC7 (job outcome unchanged), FR-001a (cancelled publishes nothing).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Observed RED** (2026-07-19): SyntaxError — no export named `publishDigest`. **Observed GREEN**: 26/26.
- [X] T020 [US2] Implement publish routing to GREEN: cross-check the run's own state and suppress on cancelled; then route by event — `pull_request` → **upsert** a PR comment matched by marker (list comments, edit if found, create if not); `push`/`workflow_dispatch` → commit status with `target_url` pointing at the bundle (FR-007, FR-008). Auth from `CI_DIGEST_TOKEN` via env.
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [X] T021 [US2] Implement opportunistic collection: the feature-036 `~/mcm-ci-last-failure/` bundle, per-container `docker logs` + `docker inspect .State.Health` + `docker ps -a`, and any test output present (jest, Playwright report, Maestro screenshots). **Degrade cleanly** — container jobs (`ubuntu-latest` / `node:22-bookworm`) have **no Docker CLI**, and `~/mcm-ci-last-failure/` is written by exactly one job today (`app-ci / app-e2e`, research R7). Record what was absent; never fail because expected evidence was missing.
- [X] T022 [US2] Add a thin `--selftest` smoke check to `scripts/ci-failure-digest.mjs` — build one digest from a canned fixture and confirm the redaction pass and upsert marker fire. **Not** a duplicate of T017/T019, which are CI-enforced via `scripts/__tests__/`.
- [X] T023 [US2] Add an `if: always()` + `continue-on-error: true` digest step to every job in `.forgejo/workflows/app-ci.yml` (`changes`, `affected`, `mc-service-checks`, `app-e2e`, `dast`, `trigger-cd`), invoking `node scripts/ci-failure-digest.mjs` with `CI_DIGEST_TOKEN` in `env:`. **A direct `run:` step, not a composite action** — `.forgejo/actions/` does not exist and act_runner's composite support is unverified (research R3). On `app-e2e`, place it **after** the existing feature-036 capture so the bundle exists. **Found during implementation**: `trigger-cd` performs no checkout of its own, so the script would not exist on disk there — a scoped `if: always()` checkout was added immediately before its digest step.
- [X] T024 [US2] Add the same step to every job in `.forgejo/workflows/guardrails.yml` (`secret-scan`, `naming`, `agent-gates`, `sast`) **and correct the file's header comment**, which currently asserts *"no `${{ secrets }}` is referenced (FR-004, SC-009)"* — no longer true, and it overstated those requirements, which govern credential **literals** only. Rewrite to: no credential *literal* appears; the agent golden gate remains keyless in replay mode; the scoped `CI_DIGEST_TOKEN` is the one referenced secret. No feature-023 amendment is needed (plan.md § Complexity Tracking).
- [X] T025 [US2] [P] Add the same step to every job in the remaining **four** workflow files, so all **six** in `.forgejo/workflows/` are covered and FR-001 admits no exception list: `cd-deploy.yml` (`build-deploy`, `prod-apk`), `infra-image-scan.yml` (`changes`, `infra-image-scan`), `devcontainer-image.yml`, and `renovate.yml`. The last two are a build and a maintenance bot rather than check pipelines, but their failures are equally undiagnosable today and covering them is cheaper than maintaining a carve-out.
- [X] T026 [US2] Implement the `failure [--sha | --run] [--job]` subcommand in `scripts/ci-status.mjs`: locate the digest (PR comment by marker, else commit status) for each genuinely failed job and print it. When no digest exists, say so and name the likely cause — the pre-digest residual risk — rather than reporting an empty result as "no failure".
- [X] T027 [US2] Smoke-test the write path on a throwaway branch per [quickstart.md](./quickstart.md) §5: deliberate failing step → PR → confirm (1) the job still fails and the digest did **not** mask it (FR-009), (2) the comment appears with its marker, (3) a re-run **edits rather than duplicates**, (4) `ci-status failure` prints it, (5) no credential and no `.ts.net` host appears, (6) an immediate second push cancels the run and **publishes nothing** (FR-001a). Delete the branch, PR, and test artifacts afterward. ⛔ **BLOCKED on T001** — needs a real `CI_DIGEST_TOKEN` to publish against a real PR.
  **RUN 2026-07-19** on throwaway branch `042-digest-smoke-DELETEME` (a deliberately failing test file
  → `guardrails / naming` red in 25s). Pushed, not PR'd, so `app-ci` did not trigger and no `kvm` time
  was spent. Results:
  - ✅ **FR-009 held** — only the intended job went red; the other three guardrails jobs passed.
  - ✅ **Bundle published**: `ci-failures:984--naming`, retrievable with the read token (200, 384 B).
    `write:package` + `read:package` both confirmed, and the `{runId}--{jobSlug}` key works.
  - ❌ **No `ci-digest` commit status appeared** — see T040.
  - ❌ **The bundle contained NO log content** — see T041.
  Branch deleted afterwards. The test bundle remains and will age out via the 30-day retention path.

**Checkpoint**: A real CI failure is diagnosable end-to-end without opening the web UI or asking a human.

---

## Phase 5: User Story 3 — Retrieve the complete evidence on demand (Priority: P3)

**Goal**: The full bundle for a failed job is retrievable through the same read channel, with no new standing access to the build host.

**Independent Test**: For a known failure, fetch the complete evidence set and confirm it contains material beyond the digest excerpt.

- [X] T028 [US3] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for bundle assembly: (a) the version key is **`{runId}--{jobSlug}`**, so two jobs failing in the same run yield **two** bundles and neither overwrites the other (clarified FR-006 — jobs fail together routinely, most notably when a cancelled run fails every context at once); (b) the 5 MB cap truncates **largest-source-first** and records the truncation in `meta.json`, so a bundle never silently misrepresents itself as complete. Verify RED.
  **Scenarios**: US3-AC1 (bundle retrieved to disk), US3-AC2 (summary points to it), US3-AC3 (size capped).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Observed RED** (2026-07-19): SyntaxError — no export named `BUNDLE_CAP_BYTES`. **Observed GREEN**: 36/36.
- [X] T029 [US3] Implement bundle assembly and upload to GREEN per [contracts/bundle-layout.md](./contracts/bundle-layout.md): build `meta.json` + `logs/` + `health/` + `ps.txt` + `test-output/`, compress, and `PUT` to the generic package registry as `ci-failures/{runId}--{jobSlug}/bundle.tar.zst` using `CI_DIGEST_TOKEN` (`write:package`). Redaction applies to bundle contents too — it is as publishable as the digest.
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [X] T030 [US3] Write unit tests FIRST (RED) in `scripts/__tests__/ci-failure-digest.test.mjs` for retention: versions older than **30 days** are selected for pruning; a pruning failure is **swallowed** and never fails the publish or the job (FR-021b). Verify RED.
  **Scenarios**: no direct acceptance scenario — covers FR-021/021a/021b (retention window and swallowed pruning failure).
  **Verify RED**: `node --test scripts/__tests__/ci-failure-digest.test.mjs`
  **Observed RED** (2026-07-19): same SyntaxError (shared file). **Observed GREEN**: 36/36.
- [X] T031 [US3] Implement opportunistic pruning in `scripts/ci-failure-digest.mjs` to GREEN — at publish time, list versions and delete those past the 30-day window (FR-021a). **No new scheduled workflow.** Accepted trade-off, already recorded: if failures stop entirely, expired bundles linger until the next failure publishes.
  **Verify GREEN**: `node --test scripts/__tests__/ci-failure-digest.test.mjs` → `# fail 0`
- [X] T032 [US3] Implement `failure --full` in `scripts/ci-status.mjs`: download the bundle to the session scratchpad and print **the path, not the contents** (FR-016). At the measured ~135 KB/s, the 5 MB cap is ≈40 s — report progress rather than appearing hung.
- [X] T033 [US3] Verify SC-010 against the real forge: induce two jobs failing in one run and confirm **two** independently retrievable bundles exist with neither overwriting the other. ⛔ **BLOCKED on T001** — identity logic is unit-proven (test m2); the live two-bundle check needs a real upload.
      **Note:** the two-jobs-one-run collision case (SC-010) remains **unit-proven only** — no live run has yet had two jobs fail in the same run to exercise it end-to-end.
  **PARTIAL 2026-07-19** — the key scheme is proven live (`984--naming` uploaded and retrieved). The two-jobs-one-run case is still only unit-proven; it needs a run where two jobs fail together.

**Checkpoint**: Full evidence retrievable on demand; retention bounded; no new standing host access.

---

## Phase 6: Polish & Cross-Cutting

- [X] T034 [P] Write `docs/runbooks/ci-diagnostics.md`: the digest format, the `ci-status.mjs` command surface and exit codes (including **why exit 3 ≠ failure**), bundle retrieval, the four classification traps, read-token provisioning (required scopes; `setx` on the host — noting that `setx` affects only newly-launched processes, so VS Code must be **fully quit**, not reloaded), and `CI_DIGEST_TOKEN` provisioning. No forge host literal, no token value.
- [X] T035 [P] Update `CLAUDE.md` § *Driving CI/CD to green*: self-serve becomes the primary path; the out-of-band `~/mcm-ci-last-failure/` route is demoted to the documented fallback for the pre-digest failure class. Keep the measured `head_sha`/`page`+`limit` query guidance — it remains true and load-bearing.
- [X] T036 Calibrate the caps (OQ-3) against a real `app-e2e` failure: confirm 200 lines / 32 KB per source actually captures the failing assertion, and that the 5 MB bundle cap holds. Adjust and record the measured basis in the runbook. Bounded on two sides — agent context **and** the ~135 KB/s link. ⛔ **BLOCKED on T027** — needs a real `app-e2e` failure to calibrate against.
      **CALIBRATED 2026-07-20 against real failures.** Per-source 200 lines / 32 KB holds; the finding
      was at the DIGEST total, not per source: run 1000's digest.md was 90 KB, over Forgejo's ~64 KB
      comment limit. Fixed by T050 (COMMENT_MAX_BYTES = 60 KB), the bundle keeping full logs as files.
- [X] T037 Measure the write path's added wall-clock across ~20 new `always()` steps, especially on the capacity-1 `kvm` runner. If not negligible, cap collection work. Record the measurement. **Measured locally 2026-07-19** (the dominant term — process startup + collection, not network): **success path 23 ms** (the common case: every job runs it, most jobs pass), cancelled/suppressed 22 ms, failure with a 5,000-line log 33 ms, failure with a 200,000-line log 57 ms. Across all 16 jobs that is **< 0.5 s added to a full CI run** — negligible, so the plan's "cap collection work" contingency is NOT needed. Verified on Node 20 (below CI's Node 22 floor) as well as 24. The remaining unmeasured piece is publish latency to the forge, which needs T001.
- [X] T038 Confirm `CI_DIGEST_TOKEN`'s scopes on the first real run (OQ-1's remaining half — unobservable outside a running job). A `401`/`403` must name the missing scope (FR-020), not surface a bare code. If insufficient, it is a token-scope config change, not a redesign (FR-010). ⛔ **BLOCKED on T001** — the write token's scopes are unobservable outside a running job.
  **ANSWERED 2026-07-19, and the answer is "insufficient".** `write:package` works (bundle uploaded).
  The commit-status POST did not publish — see T040. So the scopes chosen for `CI_DIGEST_TOKEN` cover
  the bundle and (untested) the PR-comment path, but NOT the commit-status path. Exactly the risk
  FR-010 was written to absorb: a config/design change, not a redesign.
- [X] T039 Run the full validation checklist in [quickstart.md](./quickstart.md) §7 and update `specs/042-ci-self-serve-diagnostics/checklists/requirements.md` if any spec drift surfaced during implementation (constitution: artifacts must stay aligned). Record the platform-parity table as **N/A** — this feature has no web/mobile client surface.
      **DONE.** Every scope verified on REAL production failures (PRs #85/#86): write:issue (2 digest
      comments upserted on #85), write:package (bundles 1000–1004), collector fixes (run 1000: 13
      logs, 11 health files, _mcm-stack.log un-zeroed), FR-009 (nothing broke). The gaps that survived
      are closed in Phase 9.

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


---

## Phase 7: Follow-ups from the T027 smoke test (2026-07-19)

Both were found by running the write path for real. Neither is a regression — the code does what it
was specified to do; the specification was incomplete.

- [X] T040 **Replace the commit-status pointer with a derived bundle reference (FR-008 change).**
      **RESOLVED 2026-07-20 on evidence, after three smoke runs.** Run 986's bundle captured the
      actual reason: `403 for POST /repos/…/statuses/{sha}`. Two of my own bugs had to be cleared
      first — an empty `target_url` (never assigned), and a 403 message that named `write:package`,
      a scope that was granted and working. Option B implemented: commit status dropped, `digest.md`
      added to the bundle, reader derives `{runId}--{jobSlug}`. FR-008 amended in spec.md.
      Verified `run.id` === `GITHUB_RUN_ID` (986) so the derivation resolves — `index_in_repo` (985)
      is a different identifier and would NOT have worked.
      The `ci-digest / <job>` status never published. Leading hypothesis: `POST /repos/…/statuses/{sha}`
      needs `write:repository`, which was deliberately NOT granted — package upload succeeded in the
      same run, so the token is valid. This is inference, not proof: the job log that would confirm it
      is unreadable, which is the very gap this feature exists to close, biting the feature itself.
      **Do not fix by adding `write:repository`** — that is most of the privilege that made
      `CD_PUSH_TOKEN` unacceptable. The status was only ever a *pointer*, and the read side already
      carries `runId` per check, so it can derive `bundleVersion(runId, job)` and fetch the bundle
      directly. Simpler, no new scope. Requires amending FR-008 in spec.md.
- [X] T041 **Capture the failing job's own stdout.** The bundle for `guardrails / naming` contained
      **DONE 2026-07-20.** `scripts/ci-log-step.sh` wraps a step and mirrors its combined
      stdout+stderr to `$HOME/mcm-ci-step-logs/$GITHUB_RUN_ID/<name>.log`; the collector reads that
      at rank 0, above every container log. Instrumented in `app-e2e`: agent-integration,
      mc-service-integration, web-e2e, maestro-agent-flows.
      **The `pipefail` detail is load-bearing**: `cmd | tee` returns tee's status, so without it a
      failing step reports success and CI goes silently green — worse than the problem being fixed.
      Pinned by a test and mutation-verified (removing `pipefail` fails it).
      Motivated by three consecutive `app-e2e` failures (TMDB drift, then a provider 529) that each
      needed a human to paste the log, because the evidence was in stdout and nothing collected it.
      `files: (NONE)` and `absent: ["no log output was captured for this job"]` — predicted before the
      run, and confirmed. The collector reads `~/mcm-ci-last-failure/` and test-output dirs; it never
      sees the job's own output, which is where a container job's failure actually lives. This affects
      **10 of 16 jobs**, including the fast-feedback guardrails failures an agent hits most. Without
      it, US2 delivers job identity and little else on those jobs. Likely approach: have high-value
      steps `tee` to a known path the collector reads. Needs design.


---

## Phase 8: Collector fixes from the first REAL diagnosis (2026-07-20)

Feature 042 merged, then `app-ci / app-e2e` failed on the post-merge `main` push (run 992). The read
path worked perfectly — derived `992--app-e2e`, fetched, printed. The **bundle was useless**: 4 MB of
MongoDB noise with none of the failing services in it. Three defects, all found by using the feature
for its actual purpose.

- [X] T042 **Collect every container log, ranked by diagnostic value.** `MAX_COLLECTED_SOURCES = 6`
      took the first six `.log` files *alphabetically* out of the 13 feature-036 writes. It kept
      keycloak and mongo and dropped `mc-service.log`, `mcm-bff-service-nonsecure.log` and every
      `movie-assistant-*.log` — exactly the services reporting unhealthy. Now `selectSources()`
      collects all of them ordered: container status table → unhealthy containers → compose-level
      logs → the rest.
- [X] T043 **Max-min fair cap allocation.** The old loop trimmed the largest source by half per pass;
      `min(size - excess, size/2)` goes negative once the excess exceeds a file's size, so the target
      became 0 and the file was **zeroed**. On run 992 mongo's 20 MB crowded the 5 MB cap and
      `_mcm-stack.log` — the most useful source present — was trimmed to nothing while mongo kept
      megabytes. `allocateFairly()` guarantees every source an equal share; anything under its share
      keeps all its content. Replaying run 992's real shape: 13/13 sources present, only mongo
      trimmed, `_mcm-stack.log` restored from 0 to its full 250 KB.
- [X] T044 **Collect `_ps.txt`.** Only `.log` and `.health.json` were read, so the one table showing
      which containers *exited* was in no bundle.
- [X] T045 **Cap the digest at 3 sources while the bundle keeps all 13.** A direct consequence of
      T042: 13 x 200 lines is an unreadable PR comment. The digest states how many sources it held
      back rather than silently dropping them.


---

## Phase 9: Digest usefulness — found by reading REAL digest comments (2026-07-20)

All scopes were proven on real failures, but the digests those failures produced were near-useless:
PR #85's own lint failure said "Failing step: _not reported_ · no log output was captured." Three
fixes.

- [X] T046 **Name the failing step.** `CI_DIGEST_FAILING_STEP` was never set, so every digest said
      `_not reported_`. `ci-log-step.sh` now records the first wrapped step to fail to a `_failed-step`
      marker; the digest reads it. The name comes free from the same instrumentation that captures the
      output.
- [X] T047 **Instrument the guardrails jobs.** Only the four `app-e2e` steps were wrapped, so the
      fastest, most-common failures (lint, gates, unit tests) produced empty digests. Wrapped the six
      real failure points: secret-scan, agent-gates lint/test/golden, naming script-tests, sast gate.
      End-to-end verified: a lint failure now yields a digest naming `agent-gates-lint` and carrying
      the lint error.
- [X] T048 **Cap the digest for the comment channel.** Real data: run 1000's digest was 90 KB, over
      Forgejo's ~64 KB comment limit — a PR `app-e2e` failure comment would be rejected. `buildDigest`
      now caps its markdown at `COMMENT_MAX_BYTES` (60 KB) with a note; the bundle keeps the full logs.


---

## Phase 10: Durability + security hardening (post-merge review, 2026-07-21)

Recorded here because these shipped without task IDs (an honesty gap the completeness audit caught).

- [X] T049 **Failure-digest coverage gate** — `scripts/check-ci-digest-coverage.mjs` (guardrails/naming):
      every job must publish a guarded digest step **and** wire `CI_DIGEST_JOB_STATUS`, or carry a
      justified `# ci-digest-exempt:` marker. Prevents the feature decaying by omission.
- [X] T050 **Security hardening** from a 3-pass post-merge review (code + security + completeness):
      decompression-bomb cap on `--full` (`gunzipSync maxOutputLength` + download/​file bounds);
      markdown-fence-breakout + cross-job-marker-injection defences (dynamic fences, marker defang,
      anchored `findExistingComment`); terminal control-char stripping + comment-author surfacing on
      the reader; broadened fail-closed redaction (provider-token prefixes; health/meta now run
      through the fail-closed pass; more key-names); `fetch` timeouts on both sides; malformed
      manifest entries skipped not fatal; `shouldPublish` defaults to no-publish on unknown status.
