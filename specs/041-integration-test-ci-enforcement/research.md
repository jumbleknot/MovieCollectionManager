# Phase 0 Research: Integration-Test CI Enforcement

Six decisions resolve every unknown in the Technical Context. Sources: PRD, memory
`project_mcm_agent_integration_ci`, the live `.forgejo/workflows/app-ci.yml` `app-e2e` job, the three suites'
harnesses, and `mcm.compose.yaml` / `bff/compose.yaml` port mappings.

---

## D1 — TMDB bucket (4 agent tests): diagnose provisioning before touching test code

**Decision**: Treat as a **provisioning/egress** problem first, not a test problem. In an `app-e2e` run (or Claude
Code in the dev container) confirm the `movie-assistant-mcp-webapi` container has a valid `TMDB_API_KEY` and TMDB
egress: `docker exec movie-assistant-mcp-webapi printenv TMDB_API_KEY` and reproduce a live `search_title` /
`get_movie_details`. The key path is `gen-ci-env.mjs` → `mcp-servers/web-api-mcp/.env.local` from
`secrets.TMDB_API_KEY` (already a job-level env in `app-e2e`). Fix the branch that diagnosis identifies: empty/
invalid key → fix provisioning; rate limit → make the 4 tests resilient (retry/backoff or accept a rate-limited
response); genuine bug → fix `web-api-mcp`. Un-quarantine each as it is proven green.

**Rationale**: The MCP transport returns `200 OK` while the inner TMDB call fails ("That request couldn't be
completed") — a classic missing-key/egress signature, not a logic error in the test. Fixing the test first would
mask a real provisioning gap that also degrades the enrich/add E2E flows.

**Alternatives considered**: (a) Mock TMDB — **rejected**, violates §Test Type Integrity. (b) Delete the tests —
rejected, they cover a real user path (curator enrichment). (c) Mark permanently skipped — rejected, that is the
quarantine we are removing.

---

## D2 — Live-LLM tool-choice bucket (3 agent tests): prefer relocation to golden cassettes

**Decision**: Per test, in priority order: **(a) relocate** the model-decision assertion to the golden-cassette
harness (deterministic record/replay — the surface designed to test model decisions); **(b) loosen** the live
assertion to accept the valid alternative tool only where relocation is impractical; **(c) fix the supervisor/
specialist prompt** if the behavior on the runtime model is genuinely wrong. Prefer (a). The three:
`test_query_flow::test_query_find_hit_renders_movie_card` (Claude chose `render_collection_summary` over
`render_movie_card`), `test_query_flow::test_query_find_miss_says_not_in_collection` (returned a summary, not
"isn't in your"), `test_search_flow::test_search_named_collection_single_match_navigates` (chose `render_selection`
over `navigate_to_movie`).

**Rationale**: Model *decisions* are the golden surface (project memory + `project_golden_pair_cassette_harness`).
Asserting an exact tool choice in a **live** integration test is brittle by construction and is "the next
quarantine waiting to happen" (PRD Risk). Relocation removes model-sensitivity from the live gate entirely while
still verifying the behavior deterministically.

**Alternatives considered**: (a) Loosen every one — rejected as the default; a loosened live assertion re-flakes.
(b) Pin the live gate to a fixed model/seed — rejected, the runtime model in CI is Anthropic and the point is a
real live path, not a pinned one.

---

## D3 — Add-persist bucket (1 agent test): potential-bug-first

**Decision**: Reproduce `test_gateway_add_e2e::test_gateway_add_gated_until_approval_then_persists` against the
live stack and **determine real-bug vs model/timing before touching the test**. If the approval-resume path drops
the write, fix the product (gateway/add-persist code) — the already-RED test is the TDD driver. If it is a timing
flake, harden the test's wait/assert (poll mc-service for the created collection with a bounded timeout) rather
than loosen the assertion.

**Rationale**: PRD explicitly flags this as highest-value and "potential-bug-first, not test-flake-first" — a
dropped approved-add and a flake look identical here, and a masked add-persist bug is the worst outcome of the
whole quarantine.

**Alternatives considered**: Assume-flake-and-loosen — rejected outright as the exact anti-pattern the PRD warns
against.

---

## D4 — mc-service integration in CI (Workstream B): host `cargo test` against the published replica set

**Decision**: Add an `app-e2e` step (after stack bring-up, before the web/APK/emulator legs) running
`pnpm nx test:integration mc-service` on the host with:
- `MC_DB_URL=mongodb://localhost:27017/mc_db?replicaSet=rs0&directConnection=true` — the published `27017` on
  `mc-service-store-mongo`, whose replica set `rs-init` initiates with member host **`localhost:27017`**, so a
  host-run test connects (the CLAUDE.md replica-set gotcha is already satisfied; `directConnection=true` is the
  key).
- `KEYCLOAK_URL=http://localhost:8099`, `KEYCLOAK_REALM=grumpyrobot`,
  `KEYCLOAK_CLIENT_ID=movie-collection-manager` — `health_test.rs` builds the app which fetches JWKS on startup.
- Rust toolchain installed the same way `mc-service-checks` already does (rustup minimal + `build-essential
  pkg-config libssl-dev`). The Nx target is `cargo test --tests --test-threads=1` (serial — shared DB).

**Rationale**: The suite's `common/mod.rs` reads `MC_DB_URL` (default `mongodb://localhost:27017`) and
`.expect()`s the connection — so a missing DB **panics/fails**, not skips (D6 covers the residual). The stack is
already warm; this is minutes.

**Alternatives considered**: (a) Run inside a Rust container attached to `backend-network` (use the internal
`mc-service-store-mongo:27017` host) — rejected as heavier; the host path reuses the published port and the proven
`mc-service-checks` toolchain install. (b) Add it to the `mc-service-checks` job instead — rejected: that job has
no replica-set Mongo; `app-e2e` does.

---

## D5 — mcm-app BFF integration in CI (Workstream C): host `jest` against the running BFF + Keycloak + Redis

**Decision**: Add an `app-e2e` step running `pnpm nx test:integration mcm-app` on the host. The suite
(`jest.integration.config.js`, `maxWorkers:1`, `forceExit:true`) drives the live BFF over HTTP and asserts against
real dependencies via `tests/integration/setup/env.ts`:
- `BFF_BASE_URL=http://localhost:8082` (the dev-container BFF, `bff-nonsecure` profile — already up in `app-e2e`).
- Keycloak at `localhost:8099` (ROPC `E2E_ROPC_CLIENT_ID=mcm-bff-test` + the run-minted `E2E_ROPC_CLIENT_SECRET`
  already re-exported via `$GITHUB_ENV`; admin/service-account secret from the job env).
- Redis pinned to **db 1** (`redis://localhost:6379/1`) — isolated from the BFF's db 0.
- BFF Mongo `mcm-bff-store-mongo` at `localhost:27018` (`bff_db`, self-clean by test-prefixed userId in
  `afterAll`).
`env.ts` loads `.env.e2e.local` then `.env.local`; the job's `gen-ci-env.mjs` writes `.env.docker` — confirm the
values `env.ts` needs are present in the files it loads on the host (align the loaded filename or export the
handful of vars into the step env).

**Rationale**: Every real dependency is already running and the credentials already exist in the job. The suite is
already serialized and self-cleaning (constitution §Integration Test Real-Dependency Requirement: isolated
namespace + `afterAll` teardown).

**Alternatives considered**: Point the suite at Metro's `:8081` — rejected; `app-e2e` runs the containerized dev
BFF at `:8082`, not Metro.

---

## D6 — Shared skip-escalation convention (cross-cutting G4): one env flag, three language-appropriate guards

**Decision**: Reuse the single flag **`MCM_REQUIRE_LIVE_STACK=1`** (already set by `app-e2e`) as the "this run
must not skip-to-green" signal for all three suites, each enforced in the idiom of its runner, with a documented
per-suite legitimate-skip allowlist:
- **Agent (pytest)** — the existing `conftest.py` `pytest_runtest_makereport` hook escalates any non-allowlisted
  SKIP to FAIL. No change beyond removing `ci_quarantine` (D1–D3) and reverting the step filter to `-m "not
  golden"`.
- **mcm-app (jest)** — add a small **dependency preflight** in `tests/integration/setup` that, when
  `MCM_REQUIRE_LIVE_STACK=1`, asserts each required dependency answers (BFF `:8082`, Keycloak `:8099`, Redis db 1,
  Mongo `27018`) and **throws** if any is down — turning a silent all-skip into a hard suite failure. Jest has no
  skip-escalation hook, so a fail-fast precondition is the equivalent guarantee. Document the legitimate skips
  (optional profiles) in-code.
- **mc-service (cargo)** — Rust has no "skip" primitive, so a missing dep already **panics** via `.expect()`. The
  residual risk is an `#[ignore]` attribute or a conditional early-return silently shrinking the run to zero. Guard
  by asserting the run **executed** its integration tests (a non-zero executed-test count / the expected test
  files ran) so an all-ignored run cannot report green, and forbid `#[ignore]` on these tests.

Capture the convention (the flag, the three guards, the allowlist policy) as a short documented contract so B and C
do not each reinvent it (PRD 4.4 "cross-cutting").

**Rationale**: One flag + one policy, three minimal language-appropriate enforcements, is the smallest thing that
gives every newly-wired suite the same no-false-green guarantee PR #77 established for the agent suite. The pytest
hook already exists and is the reference implementation.

**Alternatives considered**: (a) A universal wrapper script that greps each runner's output for a skip — rejected
as brittle (RTK compresses output; grepping counts is exactly the anti-pattern the CI memory warns against). (b)
Leave each suite to its own ad-hoc guard — rejected; the PRD calls out reinvention as the risk.

---

## Wall-clock & job-split posture (SC-006)

**Decision**: Keep both new suites as steps in the existing `app-e2e` job, ordered **before** the web/APK/emulator
legs (same fast-fail placement as the agent step), so a failure costs minutes not the full emulator run. Only if
measured wall-clock becomes a problem, split the integration tier into its own `needs:`-gated job that **reuses the
same stack bring-up** — never drop coverage to save time (PRD Risk mitigation). No split in the first cut.
