# Contract: Skip-Escalation Convention (No False Green)

The cross-cutting guarantee (spec Story 4 / FR-006/FR-007/FR-012, PRD 4.4): when the CI stack is up, a
misconfigured integration run must **fail loudly**, never skip-to-green. One signal, three language-appropriate
enforcements, one allowlist policy. This is the reference each newly-wired suite reuses instead of reinventing.

---

## Signal

- **Env flag**: `MCM_REQUIRE_LIVE_STACK`
  - `"1"` → "the full stack and credentials are supposed to be up; a skip means a broken harness" (set by
    `app-e2e`).
  - unset → local/credential-less behavior unchanged (skip-clean preserved, so a bare checkout stays green).

---

## Enforcement by runner

### pytest (agent) — EXISTS, reference implementation

`agents/movie-assistant/tests/integration/conftest.py` `pytest_runtest_makereport` (hookwrapper): when the flag is
set, any `report.skipped` whose reason does **not** match `_LEGITIMATE_SKIPS` is rewritten to `report.outcome =
"failed"` with an explanatory message. No change needed beyond removing `ci_quarantine`.

- **Input**: a test that would SKIP (stack/creds/MCP absent).
- **Output**: FAIL, unless the reason is allowlisted.

### jest (mcm-app) — NEW → **IMPLEMENTED** `tests/integration/setup/preflight.global.js`

A dependency **preflight** wired as jest `globalSetup` (`jest.integration.config.js`): when
`MCM_REQUIRE_LIVE_STACK=1`, probe each required dependency and **throw** if any is unreachable, so the whole suite
errors (fails) once before any test — instead of individual tests silently skipping. No-op when the flag is unset
(local / credential-less dev unchanged). Dependency-free (raw `node:http`/`node:net` probes — the feature adds no
new deps).

- **Required deps probed**: BFF `http://localhost:8082` (any HTTP response), Keycloak `http://localhost:8099`
  (realm `.well-known/openid-configuration` → 200), Redis `redis://localhost:6379/1` (TCP + `PING`→`+PONG`), BFF
  Mongo `localhost:27018` (TCP connect).
- **Input**: flag set + a required dep down → **Output**: `globalSetup` throws → jest reports the run as failed.
- **Legitimate skips**: none at the preflight level — all four probed deps are ALWAYS required by this suite. The
  env-gated optional profiles (observability: OPA/LangFuse/OTel; audit: OpenSearch) are gated on their own per-test
  flags, not this preflight; do NOT weaken the preflight for them.

### cargo (mc-service) — NEW guard `scripts/mc-service-integration-guard.mjs` (the `test:integration` runner)

Rust has no skip primitive: the integration test bodies `.unwrap()`/`.expect()` their Mongo/Keycloak calls, so a
missing dep **panics/fails** the run (verified: with Mongo down, `create_returns_dto_with_generated_id` panics
"index creation failed: … connection refused"). The residual false-green vectors are an UNDOCUMENTED `#[ignore]`
and a wholesale-disabled suite that executes zero tests yet exits 0. The guard (the Nx `test:integration` command)
runs the integration binaries declared in `Cargo.toml` `[[test]]` and enforces:

- **Executed-count guard**: every integration binary must EXECUTE ≥1 test (`passed+failed > 0`) and produce a
  `test result:` line. An all-ignored / zero-executed run is treated as **failure**, not green.
- **Bare-ignore ban**: a BARE `#[ignore]` (no reason) is forbidden. A **documented `#[ignore = "reason"]` is
  ALLOWED** — the suite legitimately ignores ~24 full-stack HTTP tests (`"requires Keycloak JWKS timing; verified
  in E2E"`), 2 process-global-conflict tests (tracing subscriber / `is_pending()`), and 2 wrong-layer tests
  (`"enforced in CreateMovieHandler … verified in http_create_update_test.rs"`).
  **DEVIATION from the original plan** (which said "`#[ignore]` is forbidden"): a blanket ban was infeasible —
  these documented ignores pre-exist for real reasons, and un-ignoring them wholesale is out of scope + risky
  (in-process JWKS/tracing conflicts). The executed-count guard is the genuine no-false-green protection; the
  documentation requirement keeps teeth. **Follow-up opportunity**: the ~24 full-stack HTTP tests could now run in
  app-e2e against the live Keycloak (they were only "verified in E2E" because the old Mongo-only `test:integration`
  had no Keycloak) — the mc-service analog of the agent-suite rot. Not wired here (flakiness risk); tracked.
- **Input**: flag set + DB down → `.unwrap()`/`.expect()` panic → FAIL. Someone `#[ignore]`s a whole binary →
  executed-count guard → FAIL. Someone adds a bare `#[ignore]` → bare-ignore ban → FAIL.

---

## Legitimate-skip allowlist policy

A skip stays legitimate (NOT escalated) only if it is on the suite's explicit, deliberately-curated allowlist:

- Env-gated **optional profiles** the default gate never brings up: OPA (`--profile observability`),
  LangFuse/OTel, Unleash, OpenSearch (`--profile audit`).
- Golden-cassette paths (covered separately + keyless in guardrails).
- Genuine **data-conditions** (e.g. TMDB returns no ambiguous match this run).
- The runtime model has no Ollama (`ollama not reachable`) — CI runs the model as Anthropic.

Adding an entry is a **deliberate act** — the red CI is the prompt to make that call, never a reflex to silence a
flake. `ci_quarantine` is NOT a legitimate-skip category; it is being removed.

---

## Acceptance (AC4 / SC-004)

For each newly-wired suite: a run with the stack **intentionally partially down** (e.g. Redis stopped for mcm-app,
Mongo stopped for mc-service) MUST fail — proving the guard bites — while a fully-up run passes. Demonstrated at
least once per suite.
