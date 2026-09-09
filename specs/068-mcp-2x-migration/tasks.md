---

description: "Task list for feature 068 — MCP SDK 2.x migration on an audited baseline"
---

# Tasks: MCP SDK 2.x migration on an audited baseline

**Input**: Design documents from `/specs/068-mcp-2x-migration/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: REQUIRED. The constitution makes TDD non-negotiable. Every test task below names the
scenarios it covers and a **Verify RED** command with its expected failure; every paired
implementation task carries a **Verify GREEN**. A Verify RED showing 0 failures means the test is
trivially passing and must be fixed before implementation begins.

**Organization**: Three user stories across two pull requests. US1 ships alone as PR #1; US2 and US3
ship together as PR #2 (R4 permits separate commits, R1's ambiguity argument does not apply within
Phase 2).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3, mapping to `spec.md`

---

> ⚠️ **Four instrument traps specific to this feature. Read before starting — each one produces a
> confident green that means nothing.**
>
> 1. **`node --test <file> --test-name-pattern 'x'` silently runs EVERYTHING.** Everything after the
>    script path becomes the script's own `argv`, so the filter is ignored while appearing to work.
>    Put node's flags **before** the path. This will turn a Verify RED into "all green".
> 2. **`api.osv.dev` does not resolve in this dev container** (research R0). The gate's instrument
>    cannot be run locally. Use `pip-audit -s pypi` and say which you ran; CI's OSV pass is the
>    authority.
> 3. **Zero findings and a scanner that never ran look identical.** Always read
>    `findings.json`'s `scanners[]` for `ran: true` / `error: null`, never just the finding count.
> 4. **A skipped test reads as a pass.** `MCM_REQUIRE_LIVE_STACK=1`, `E2E_REQUIRE_AGENT_STACK=1` and
>    `MCM_REQUIRE_LIVE_MODEL=1` turn a skip into a failure. Set them, and read the SKIP COUNT.

---

## Phase 1: Setup

**Purpose**: Get the four environments usable and prove the instrument before trusting any result.

- [X] T001 Sync all four Python environments: `uv sync` in `agents/movie-assistant`,
  `mcp-servers/movie-mcp`, `mcp-servers/spreadsheet-mcp`, `mcp-servers/web-api-mcp`
  - A "cannot scan this project" error is almost always a missing **file** (an unsynced venv, an
    absent gitignored `.env.local`), not a missing capability. Name the absent input before
    concluding the environment cannot do the job.

- [X] T002 Bring the local stacks up, and make an absent stack **fail** rather than skip
  - **DONE 2026-09-08.** Baseline on `mcp` 1.29.1 with `MCM_REQUIRE_LIVE_STACK=1`: movie-mcp **20
    passed**, web-api-mcp **9 passed**, zero skips. The flag did its job — it first turned 20 silent
    skips into 20 errors.
  - **Two missing inputs, not a missing capability.** (1) web-api-mcp needed the TMDB key —
    `gen-dev-env.mjs` supplied it (0 → 9 passed). (2) movie-mcp's ROPC 401 was a **stale**
    `E2E_ROPC_CLIENT_SECRET` in `frontend/mcm-app/.env.e2e.local`, which `gen-dev-env.mjs` does
    **not** resync; fixed by reading `mcm-bff-test`'s real secret from the running realm via the
    Keycloak admin API. Worth a follow-up item on the generator.
  - Per [local-dev.md](../../docs/runbooks/local-dev.md). The Verify REDs in Phases 4 and 5 call a
    live `mc-service`, `movie-mcp` and `web-api-mcp`. Without them those suites fail for an unrelated
    reason and the RED proves nothing — a tool's "no" is about the tool, not about your question.
  - Export `MCM_REQUIRE_LIVE_STACK=1` and `E2E_REQUIRE_AGENT_STACK=1` for every later Verify so a
    missing stack is a failure, not a silent skip. Read the SKIP COUNT before believing any green.
  - If a suite reports missing credentials, look for an absent gitignored `.env.local` before
    concluding the environment cannot run the tier — `gen-dev-env.mjs` skips them silently.

- [X] T003 Confirm the substitute advisory instrument is sensitive, per research R0
  - Run `pip-audit` with `-s pypi` and confirm it reports `PYSEC-2026-2132` for `click 8.2.0`
    carrying its `CVE-2026-7246` / `GHSA-47fr-3ffg-hgmw` aliases. If it does not, **stop** — every
    "zero advisories" result below would be meaningless.

- [X] T004 Capture the pre-change `sast` baseline on `main` into the scratch directory
  - `pnpm nx sast infrastructure-as-code`, then keep `security/sast/reports/findings.json`. This is
    what T020 and T046 compare against.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Record the numbers every later Verify asserts against, and refresh the one research
finding with a short shelf life. Nothing below changes repository code.

**⚠️ CRITICAL**: T006's result can invalidate research R7's table. Do it before any bound is bumped.

- [X] T005 [P] Record the pre-change measurements into the scratch baseline file
  - Four-surface installed-venv package counts (measured: 195 / 77 / 80 / 77); the **15** camelCase field reads
    (`grep -rn "isError\|structuredContent\|inputSchema" --include=*.py agents/ mcp-servers/`);
    the **15** `@mcp.tool()` return annotations, all precise. SC-005 and the US2/US3 Verify GREENs
    are stated relative to these.

- [X] T006 Re-run research R7's resolution comparison in a **scratch copy**, never in the repo
  - `mcp 2.2.0` and `mcp 1.30.0` were both published 2026-09-07; upstream is shipping fast. Copy each
    project out, bump the bound, `uv lock --upgrade-package mcp`, and diff `uv export` against
    `main`. A package in the delta that R7 does not list is a finding — raise it before proceeding,
    do not absorb it.

**Checkpoint**: baselines recorded, resolution delta confirmed or corrected. User story work may begin.

---

## Phase 3: User Story 1 — Every Python dependency graph is scanned (Priority: P1) 🎯 MVP — **PR #1**

**Goal**: `pip-audit` covers all four Python surfaces, findings say which project they came from, and
a suppression that matches nothing fails loudly. Ships on `mcp` 1.29.1.

**Independent Test**: land this alone with `mcp` unchanged. The `sast` gate passes and its report
shows four `pip-audit` surfaces. Measured installed-venv counts, 2026-09-08: 195 gateway,
77 movie-mcp, 80 spreadsheet-mcp, 77 web-api-mcp.

### Tests for User Story 1 ⚠️ write first, see them fail

- [X] T007 [P] [US1] Assert every `pip-audit` finding's location is project-qualified, in
  `scripts/__tests__/sast-scan.guard.test.mjs`
  - **Scenarios covered**: US1-AC1, US1-AC2; FR-003; contract INV-1
  - **Verify RED**: `node --test --test-name-pattern 'project-qualified' scripts/__tests__/sast-scan.guard.test.mjs`
  - **NATURAL RED**: `normalizePipAudit` emits `click@8.5.0`, so the assertion fails on a location
    with no `<project>:` prefix. Expect the failure to name the unqualified value.

- [X] T008 [P] [US1] Assert the same advisory in two projects yields two distinct, separately
  suppressible findings, in `scripts/__tests__/sast-scan.guard.test.mjs`
  - **Scenarios covered**: US1-AC2, US1-AC3; FR-004, SC-004; contract INV-2
  - **Verify RED**: `node --test --test-name-pattern 'separately suppressible' scripts/__tests__/sast-scan.guard.test.mjs`
  - **NATURAL RED**: both findings currently render the same location string, so the
    distinctness assertion fails and the one-suppresses-the-other assertion proves the defect.

- [X] T009 [US1] Assert a `pip-audit` suppression entry naming an **unknown surface** fails the gate,
  naming the entry, in `scripts/__tests__/sast-scan.guard.test.mjs`
  - **Scenarios covered**: US1-AC4; FR-005; contract INV-3
  - **Do not build a second unmatched-entry detector.** `selectUnmatched` in
    `scripts/allowlist-expiry.mjs` (feature 057) already catches "matched nothing *this run*" — but
    it is report-only, runs under `--check-expiring` in `infra-image-scan.yml` rather than the
    blocking gate, and is deliberately suppressed when its scanner produced no findings
    (`scannersWithFindings`, selftest case g5). pip-audit's healthy state here is **zero findings**,
    so that suppression is active exactly when things are fine. Case g5 is correct design and must
    not be relaxed.
  - This task is the complementary **static** half: an entry's `locationPattern` must anchor to one
    surface in the surface list (`^agents/movie-assistant:`, `^mcp-servers/movie-mcp:`, …) or carry
    an explicit justified declaration that it spans surfaces. A pattern naming a surface that does
    not exist can never match and is a defect detectable from the entry's own text.
  - **Verify RED**: `node --test --test-name-pattern 'unknown surface' scripts/__tests__/sast-scan.guard.test.mjs`
  - **NATURAL RED**: no static shape check exists, so the assertion has nothing to call.

- [X] T010 [P] [US1] Assert the other three scanners' location formats are unchanged, in
  `scripts/__tests__/sast-scan.guard.test.mjs`
  - **Scenarios covered**: contract INV-4
  - **Verify RED**: this is a **control** and should pass from the start. A control's job is to keep
    passing; if it fails, the change has leaked beyond `pip-audit`.

- [X] T011 [US1] Assert a Python project present on disk but absent from the surface list **fails**
  the scan, naming it, in `scripts/__tests__/sast-scan.guard.test.mjs`
  - **Scenarios covered**: US1-AC6; FR-021; SC-008; spec Edge Cases ("a future project is added
    under the MCP server directory")
  - **Verify RED**: `node --test --test-name-pattern 'unlisted project' scripts/__tests__/sast-scan.guard.test.mjs`
  - **NATURAL RED**: no such check exists, so the assertion has nothing to hook onto and the test
    errors. That is the finding this task exists for: a static four-entry list has no opinion about
    a fifth directory, so implementing US1 without this would rebuild — one directory over — exactly
    the blind spot the feature exists to close.

- [X] T012 [US1] Extend the gate selftest to cover a project-qualified suppression, in
  `scripts/check-sast-findings.mjs`
  - **Scenarios covered**: US1-AC3; FR-004
  - **Verify RED**: `node scripts/check-sast-findings.mjs --selftest`
  - **INDUCED RED**: the selftest's fixture entry (`g5allow`, `locationPattern: '.*'`) is
    project-agnostic. Add the qualified-form case and see it fail before T014 lands.

### Implementation for User Story 1

- [X] T013 [US1] Generalize `runPipAudit` from one hardcoded directory to four surfaces, each with
  its own `agentSet` and `runtimeSet`, in `scripts/sast-scan.mjs`
  - **Scenarios covered**: US1-AC1; FR-001, FR-002
  - Per data-model.md, `runtimeSet` comes from that project's own `uv export --no-dev`. Borrowing
    the gateway's would misclassify a server's dev-only package as runtime.
  - **Verify GREEN**: `node --test scripts/__tests__/sast-scan.guard.test.mjs`

- [X] T014 [US1] Prefix the finding location with its project in `normalizePipAudit`, in
  `scripts/sast-scan.mjs`
  - **Scenarios covered**: US1-AC2; FR-003; contract INV-1, INV-2, INV-4
  - **Verify GREEN**: `node --test scripts/__tests__/sast-scan.guard.test.mjs` and
    `node scripts/check-sast-findings.mjs --selftest`

- [X] T015 [US1] Make a surface whose environment is unsynced or whose advisory lookup fails **fail
  the scan**, never skip it, in `scripts/sast-scan.mjs`
  - **Scenarios covered**: FR-008; spec Edge Cases ("must not turn a fetch failure into a silent
    partial scan of three")
  - **Verify GREEN**: unsync one server venv, run the scan, confirm a non-zero exit naming that
    project — then re-sync.

- [X] T016 [US1] Validate the surface list against the Python project directories on disk, in
  `scripts/sast-scan.mjs`
  - **Scenarios covered**: US1-AC6; FR-021; SC-008
  - Enumerate directories under `agents/` and `mcp-servers/` that carry a `uv.lock`. A directory not
    in the surface list **fails** the scan, naming it.
  - **Do not silently auto-scan an unknown project.** An unreviewed dependency graph entering a merge
    gate unannounced is its own surprise, and its runtime-vs-dev classification has never been
    looked at. Fail, and let a human add the surface deliberately.
  - **Verify GREEN**: `node --test scripts/__tests__/sast-scan.guard.test.mjs`; then create a
    throwaway `mcp-servers/_probe/uv.lock`, confirm the scan fails naming `_probe`, and delete it.

- [X] T017 [US1] Retire the stale `click` suppression and correct the comment asserting the MCP
  servers are deliberately unscanned, in `security/sast/allowlist.yaml`
  - **Scenarios covered**: FR-006, FR-009; contract "Migration of existing entries"
  - `click` resolves to 8.5.0 in all four locks and PyPI reports 8.5.0 clean, so the entry suppresses
    nothing and its stated premise no longer holds. **Delete** rather than re-anchor — a dead entry
    absorbs a genuine regression until its 2026-10-12 expiry.
  - **Verify GREEN**: `node scripts/check-sast-findings.mjs` exits 0, and T009's guard passes with
    no unmatched entry.

- [X] T018 [US1] Add three `uv sync --frozen` steps to the `sast` job, one per MCP server, beside the
  existing gateway step, in `.forgejo/workflows/guardrails.yml`
  - **Scenarios covered**: FR-007
  - Use the same `ci-log-step.sh` wrapper and `working-directory:` shape as the existing step.

- [X] T019 [P] [US1] Correct the scanner table's Python surface from one project to four, in
  `docs/runbooks/sast-scanning.md`
  - **Scenarios covered**: US1-AC5; FR-009

### Verification for User Story 1

- [X] T020 [US1] Run the full scan locally and read the scanner metadata, not the finding count
  - **RESOLVED BY CI, PR #391 / 5e8637a6**: `guardrails / sast` PASSED with the four-surface scanner
    against the real OSV feed. The local half stayed blocked (below); CI is the authority, as planned.
  - **BLOCKED LOCALLY, 2026-09-08**: `api.osv.dev` does not resolve here, so `pip-audit` fails closed
    and no `findings.json` is produced. Not a regression — equally unreproducible before this change.
    The fail-closed paths WERE verified live (the `_probe` rejection; the surface-named OSV error).
    **CI's OSV run on PR #391 is the authority for the four-surface confirmation.**
  - **Scenarios covered**: SC-001
  - **Verify**: four distinct project prefixes among `pip-audit` findings; `ran: true` and
    `error: null` for `pip-audit`. Expected result is **zero** advisories across all four
    (measured 2026-09-08) — which is why trap #3 matters here more than anywhere.
  - Note which advisory feed you used (`-s pypi` locally; see trap #2).

- [X] T021 [US1] Open **PR #1** with US1 alone and confirm `sast` green in CI
  - Push a real branch (`git push origin HEAD:<branch>`), then `POST …/pulls` with the
    `git credential fill` credential — never an AGit push, which yields a head that runs with **no**
    Actions secrets.
  - CI's OSV run is the authority for SC-002. This green is the baseline PR #2 is measured against.

**Checkpoint**: US1 is on `main` and green. Phase 2 of the feature may begin (SC-007).

---

## Phase 4: User Story 2 — The three MCP tool servers run on the 2.x SDK (Priority: P2) — **PR #2**

**Goal**: the three servers construct through `MCPServer`, keep their transport posture exactly as it
is, and preserve tool-result semantics.

**Independent Test**: each server's unit and integration suites pass, and a containerized server
answers a call addressed to its Docker service-name host.

### Tests for User Story 2 ⚠️ write first, see them fail

- [X] T022 [P] [US2] Assert every `@mcp.tool()` return annotation is precise (not bare `dict`/`list`/
  `Any`/absent) across the three servers, in a new guard under `scripts/__tests__/`
  - **Scenarios covered**: US2-AC3; FR-018; contract INV-5
  - Must **AST-parse**, not regex: a decorator and its signature span lines, and a regex over
    `@mcp.tool()` followed by `def` misses multi-line parameter lists — measured, it found 7 of 9
    tools in `movie-mcp` and 2 of 4 in `spreadsheet-mcp`.
  - **Verify RED**: run the guard with node's flags before the path (trap #1).
  - **INDUCED RED**: all 15 tools are precise today, so temporarily loosen one to bare `dict`, see
    the guard fail naming that tool, then restore it.

- [X] T023 [P] [US2] Port the `movie-mcp` integration suite to the public `Client(server)` harness and
  the snake_case result fields, in `mcp-servers/movie-mcp/tests/integration/test_server.py`
  - **Scenarios covered**: US2-AC2, US2-AC4; FR-016, FR-017, FR-019; contract INV-1..INV-4
  - Use **public** `mcp.client.Client`, not the private `mcp.client._memory` module.
  - **Verify RED**: `pnpm nx test:integration movie-mcp`
  - **NATURAL RED**: on `mcp` 1.29.1 neither `mcp.client.Client` nor `is_error` exists, so the suite
    fails at import/attribute access. That failure is the proof the port targets 2.x.

- [X] T024 [P] [US2] Port the `web-api-mcp` integration suite likewise, in
  `mcp-servers/web-api-mcp/tests/integration/test_server.py`
  - **Scenarios covered**: US2-AC2, US2-AC4; FR-016, FR-017, FR-019
  - **Verify RED**: `pnpm nx test:integration web-api-mcp` — same natural failure as T023.

- [X] T025 [US2] Assert structured-content semantics explicitly: a mapping-returning tool yields the
  mapping as-is, a sequence-returning tool yields it wrapped under `result`
  - **Scenarios covered**: US2-AC2; FR-019; contract INV-1, INV-2
  - These are asserted today only implicitly, via `_payload()` happening to work. Make them explicit
    — they are the contract the migration must not shift, and R8 shows one annotation shape silently
    breaks them.

### Implementation for User Story 2

- [X] T026 [US2] Bump the bound to `mcp>=2,<3` and regenerate the lockfiles for the three servers, in
  `mcp-servers/*/pyproject.toml` and `mcp-servers/*/uv.lock`
  - **Scenarios covered**: FR-010
  - Confirm the resolved delta matches T006's refreshed table.

- [X] T027 [P] [US2] Migrate to `MCPServer` and move `stateless_http`, `json_response` and
  `transport_security` from the constructor onto `streamable_http_app()` in `build_app()`, in
  `mcp-servers/movie-mcp/src/server.py`
  - **Scenarios covered**: US2-AC1; FR-011, FR-012; contract INV-10, INV-11
  - The `TokenCaptureMiddleware` wrap stays where it is.
  - **Verify GREEN**: `pnpm nx test movie-mcp`

- [X] T028 [P] [US2] Same migration in `mcp-servers/spreadsheet-mcp/src/server.py`
  - **Scenarios covered**: US2-AC1; FR-011, FR-012
  - **Verify GREEN**: `pnpm nx test spreadsheet-mcp`

- [X] T029 [P] [US2] Same migration in `mcp-servers/web-api-mcp/src/server.py`
  - **Scenarios covered**: US2-AC1; FR-011, FR-012
  - The `TmdbKeyMiddleware` wrap stays where it is.
  - **Verify GREEN**: `pnpm nx test web-api-mcp`

- [X] T030 [US2] Record why the SDK's new `host` parameter is left unset, beside each server's
  existing DNS-rebinding comment, in the three `src/server.py` files
  - **Scenarios covered**: FR-013; contract INV-12; research R6
  - `host` is consulted only inside `if transport_security is None` — the auto-enable branch. These
    servers pass `transport_security` explicitly, so it is never read. It is **not** a bind address;
    that stays `MC_MCP_HOST`. Setting a value would imply an effect it does not have.

- [X] T031 [US2] Verify no 1.x field name survives in the two integration suites
  - **Scenarios covered**: FR-016; contract INV-4
  - **Verify GREEN**: the grep from T005 returns no matches under `mcp-servers/`.

### Verification for User Story 2

- [X] T032 [US2] Run every tier the diff touches for all three servers
  - `pnpm nx test <p>` **and** `pnpm nx lint <p>` for each — they are separate targets, and a Python
    lint tier that was never run has hidden findings here before. Then
    `pnpm nx run-many -t test:integration -p movie-mcp,web-api-mcp`.

- [X] T033 [US2] Prove the Docker service-name host still resolves, in the containerized run
  - **Scenarios covered**: US2-AC1; contract INV-10
  - A unit test cannot show this. With the stacks up, a call addressed to `movie-mcp:8000` (not
    `localhost`) must be served, not rejected with a host mismatch. The dev-container mode is the
    deterministic baseline.

---

## Phase 5: User Story 3 — The gateway calls MCP tools on 2.x with token custody intact (Priority: P2) — **PR #2**

**Goal**: the gateway lists and calls tools on 2.x, forwarding both per-call credentials exactly as
today, releasing the client it now owns, and persisting neither credential.

**Independent Test**: the gateway's integration tests against a live `movie-mcp` and `web-api-mcp`
pass, including the cases asserting a call carries **no** bearer where it should not.

**⚠️ This is the only code in the feature that carries a credential.** The constitution's Identity
Propagation rule is non-negotiable.

### Tests for User Story 3 ⚠️ write first, see them fail

- [X] T034 [P] [US3] Assert credential independence in **both** directions, in the gateway's
  integration tests
  - **Scenarios covered**: US3-AC1, US3-AC2; FR-014; contract INV-6, INV-9
  - A movie-server call carries a bearer and **no** `X-TMDB-Key`; an external-API call carries the
    key and **no** bearer. A test asserting only the positive case passes even if the transport
    started defaulting a stale credential onto every request — which is precisely the regression the
    caller-owned client makes newly possible.
  - **Verify RED**: `pnpm nx test:integration movie-assistant`

- [X] T035 [P] [US3] Assert the HTTP client the gateway creates is released on **both** the success
  and the failure path, in the gateway's tests
  - **Scenarios covered**: US3-AC3; FR-015; contract INV-8
  - This invariant has no 1.x counterpart — the transport owned the client, so there was nothing to
    leak. Assert the failure path explicitly; a leaked client keeps a credential-bearing auth object
    alive.
  - **Verify RED**: no such assertion exists; the test fails to find the seam it needs.

- [X] T036 [US3] Assert no credential reaches checkpointed state, traces or logs
  - **Scenarios covered**: US3-AC3; FR-020; contract INV-7 (constitutional)

- [X] T037 [US3] Assert the result conversion still populates error flag, structured payload and text
  - **Scenarios covered**: US3-AC4; FR-019; contract INV-1..INV-3
  - Include the `{"result": ...}` unwrap for sequence-returning tools — R8 confirms 2.x still wraps
    them, so the unwrap must survive and must not be "simplified" away.

### Implementation for User Story 3

- [X] T038 [US3] Bump the bound to `mcp>=2,<3` and regenerate the lockfile, in
  `agents/movie-assistant/pyproject.toml` and `agents/movie-assistant/uv.lock`
  - **Scenarios covered**: FR-010
  - Expected delta per R7: `mcp 1.29.1→2.2.0`, `+mcp-types`, `−httpx-sse`, and **nothing else** —
    `httpx2` is already present via `anthropic` and `langsmith`. A larger delta is a finding.

- [X] T039 [US3] Rebase `DownscopedTokenAuth` from `httpx.Auth` to `httpx2.Auth`, in
  `agents/movie-assistant/src/tools/mcp_tools.py`
  - **Scenarios covered**: FR-014; contract INV-6, INV-9
  - `httpx2.Auth` exposes the same `auth_flow` contract (verified), so the class ports by changing
    its base and its `httpx.Request` / `httpx.Response` annotations. The ContextVar reads are
    unchanged — keep them per-request, not baked into client defaults.

- [X] T040 [US3] Replace `streamablehttp_client(url, auth=…)` with
  `streamable_http_client(url, http_client=…)` under an owned `async with` lifecycle, and unpack the
  2-tuple `TransportStreams`, at **both** call sites in
  `agents/movie-assistant/src/tools/mcp_tools.py`
  - **Scenarios covered**: US3-AC1..AC3; FR-014, FR-015; contract INV-8
  - Both `call_mcp_tool` and `list_mcp_tools`. `as (read, write, _)` becomes `as (read, write)`.
  - **Verify GREEN**: `pnpm nx test movie-assistant`

- [X] T041 [US3] Rename the camelCase field reads to snake_case in
  `agents/movie-assistant/src/tools/mcp_tools.py`
  - **Scenarios covered**: FR-016; contract INV-4
  - Includes the docstring on `list_mcp_tools` that names `inputSchema`.

### Verification for User Story 3

- [X] T042 [US3] Run every tier the gateway diff touches
  - **DONE 2026-09-08.** `lint` clean (44 files); unit **1189 passed / 2 skipped**; the new
    credential-custody suite **11 passed**.
  - Integration (three MCP servers on 8765/8766/8767, `MCM_REQUIRE_LIVE_STACK=1`): **52 passed,
    4 failed**, down from 42 failed before the servers were up.
  - **One of those failures was MINE and is fixed** — see research R5a. `httpx2`'s exceptions are a
    separate hierarchy, so `_is_transient_exc()` stopped classifying connect failures as transient
    and the dead-letter path was skipped. Four unit regressions added.
  - **The remaining 4 are not caused by the migration — but they are NOT "pre-existing on `main`",
    which is what an earlier revision of this file claimed. The CI record contradicts that.**
    - Measured here: all four fail identically with the gateway re-synced to **`mcp` 1.29.1** (branch
      stashed), so the version bump is not the cause.
    - Measured in CI: `app-ci / app-e2e` **passed** on `main` at `96fa99dc` (2026-09-08 04:59), and
      its `agent-integration` step — `nx test:integration movie-assistant -- -m "not golden"`, the
      exact command — **ran for 65s** inside that green job.
    - So they pass in CI and fail in this dev container: an **environment** limitation, not a code
      state. `ollama list` is empty here and `registry.ollama.ai` is **not in
      `.devcontainer/egress-allowlist.json`**, so models cannot be pulled at all; the integration
      conftest carries an "ollama not reachable" skip path for exactly this.
    - **The lesson is the claim, not the tests.** "Fails identically at 1.29.1" proves the bump is
      innocent. It does **not** prove "fails on `main`" — that needed the CI record, which was one
      query away and says the opposite.
  - `pnpm nx test movie-assistant` **and** `pnpm nx lint movie-assistant`, then
    `pnpm nx test:integration movie-assistant` against a live `movie-mcp` and `web-api-mcp`.

- [X] T043 [US3] Prove zero 1.x field names remain anywhere
  - **Scenarios covered**: SC-005
  - **Verify**: the T005 grep returns **no matches** under `agents/` or `mcp-servers/`. There were 15.

---

## Phase 6: Polish & Cross-Cutting

- [X] T044 Run the golden tier: `pnpm nx test:golden movie-assistant`
  - **RESOLVED BY CI, PR #393 / 922cbf69**: `guardrails / agent-gates` PASSED — that job owns the
    golden tier (app-ci defers to it: "guardrails already runs them").
  - **BLOCKED — host egress policy, not disk and not choice.** `ollama list` is empty and
    `ollama pull qwen2.5` fails: `lookup registry.ollama.ai ... no such host`.
    `registry.ollama.ai` is **not in `.devcontainer/egress-allowlist.json`** — the same class of
    block as `api.osv.dev` (research R0). No model can be installed in this container by any means,
    so this tier cannot run here. CI is the authority, and it is where the tier gates anyway.
  - Cassettes are keyed on model + normalized prompt; a miss must fail, never become a skip.

- [X] T045 Run the merge-gating E2E tier: `E2E_TIER=gate pnpm nx e2e mcm-app`
  - **RESOLVED BY CI, PR #393 / 922cbf69**: `app-ci / app-e2e` PASSED, and its `web-e2e` step ran
    193s with `E2E_TIER=gate` — the blocking merge signal. SC-006 satisfied.
  - **BLOCKED — same egress block on `registry.ollama.ai`** (see T044). CI is the authority for
    SC-006.
  - **Scenarios covered**: SC-006
  - Select tiers with `E2E_TIER`, **not** `--grep-invert` — Playwright accepts that flag here and
    silently ignores it. Read the SKIP COUNT (trap #4).

- [X] T046 Re-run the four-surface scan and confirm **zero new advisories** against T020's baseline
  - **DONE 2026-09-08 — SC-003 satisfied, zero new advisories.** Measured both sides with the same
    instrument (PyPI feed; OSV unreachable locally, research R0):
    gateway 195→195 pkgs, movie-mcp 77→78, spreadsheet-mcp 80→79, web-api-mcp 77→78; **0 → 0 vulns
    on every surface**.
  - **Scenarios covered**: SC-003
  - This is the whole point of the two-phase ordering: any advisory appearing now is attributable to
    the migration, because Phase 1 already proved the three servers clean on 1.x.

- [X] T047 Record the measured 2.x traps where `openwiki/INSTRUCTIONS.md` says they belong
  - Recorded at source rather than in a generated page: the `httpx2` exception-hierarchy rationale
    sits in a comment on `_is_transient_exc()` itself, and research.md gains **R5a** (with R5's
    "five breakages" claim corrected to six).
  - The five-breakage surface, the inert `host` parameter, and the bare-annotation trap. A concept
    citing a `resource` is a derived summary — write into the **cited source**
    (`docs/runbooks/sast-scanning.md` for the scanner change), not into the concept, and never into
    `CLAUDE.md`.

- [X] T048 Open **PR #2** with US2 and US3
  - Real branch push then `POST …/pulls` with the `git credential fill` credential; never AGit.
  - One PR, not two: R4 permits separate commits, but a red inside Phase 2 is the migration's either
    way, and a second ~35-minute E2E cycle buys nothing.

- [X] T049 File the out-of-scope follow-up: `api.osv.dev` is absent from
  `.devcontainer/egress-allowlist.json`, so the `sast` gate cannot be reproduced locally
  - Research R0. A standing cost, not a one-off — but not this feature's job.
  - Check for a duplicate first; `backlog.mjs create` refuses rather than filing a second copy.
  - **DONE 2026-09-08 — three filed**, all measured during this feature rather than suspected:
    - **#394** (p2, tech-debt) — `api.osv.dev` **and** `registry.ollama.ai` both absent from the
      egress allowlist, so two merge-gating tiers cannot be reproduced locally. Body records the
      three defects CI caught that no local tier could have.
    - **#395** (p3, bug) — `gen-dev-env.mjs` does not resync a **stale** `E2E_ROPC_CLIENT_SECRET`
      and reports success anyway. Sibling of #227 (missing-file variant), distinct failure mode.
    - **#396** (p3, bug) — `ci-status.mjs` labels a dependency-skipped job `path-gated`, asserting a
      cause it cannot know; it misdirected the diagnosis of PR #393 once.

- [ ] T050 Close backlog item **#310** — only after verifying its acceptance criteria are met
  - Its four criteria: all four projects import and run on 2.x; bounds at `>=2,<3` with lockfiles
    regenerated; the full agent tier passes (golden + `@gate`); an SDD set exists. Closure is an
    explicit act after verification, not a consequence of a merged PR.

---

## Dependencies

```text
Phase 1 (T001-T004)  ──►  Phase 2 (T005-T006)  ──►  Phase 3 / US1  ──►  PR #1 green on main
                                                                              │
                                                    ┌─────────────────────────┘
                                                    ▼
                                    Phase 4 / US2 ──┬──► Phase 6 ──► PR #2
                                    Phase 5 / US3 ──┘
```

- **US1 blocks US2 and US3** — by process, not mechanically. SC-007 requires PR #1 green on `main`
  first, so a Phase 2 advisory is attributable.
- **US2 and US3 are mutually independent.** Research R4 measured all four client/server version
  combinations as interoperable, so they may be separate commits and a partial rollout is safe. They
  still ship in one PR.
- Within US2, T027/T028/T029 are parallel (three different files). Within US1, T007/T008/T010 are
  parallel; T009 and T012 touch shared fixtures and are not.

## Parallel execution examples

```bash
# Phase 3 — three guard tests, three independent assertions in one file's test suite
T007, T008, T010 in parallel   # then T009, T012 sequentially (shared fixtures)

# Phase 4 — three server modules, no shared file
T027 (movie-mcp), T028 (spreadsheet-mcp), T029 (web-api-mcp) in parallel

# Phase 4/5 — the two stories are independent (R4)
T022-T033 (US2) and T034-T043 (US3) may proceed concurrently
```

## Implementation strategy

**MVP is US1 alone.** It delivers standing value — three previously unscanned dependency graphs enter
the merge gate — whether or not the SDK migration ever happens, and it ships on `mcp` 1.x with no
migration risk at all. If the migration is deferred again, PR #1 is not wasted work.

**Then US2 + US3 together**, measured against the baseline US1 established.

**If Phase 2 goes wrong**, R4 says it can be bisected safely: revert the gateway or the servers
independently and the remaining half still interoperates with the un-migrated other half.
