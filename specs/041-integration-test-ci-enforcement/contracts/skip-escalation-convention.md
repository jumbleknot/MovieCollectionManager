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

### jest (mcm-app) — NEW

A dependency **preflight** in `tests/integration/setup` (run via `globalSetup` or an early `setupFiles` guard):
when `MCM_REQUIRE_LIVE_STACK=1`, probe each required dependency and **throw** if any is unreachable, so the whole
suite errors (fails) instead of individual tests silently skipping.

- **Required deps probed**: BFF `http://localhost:8082` (health/any 2xx-or-auth response), Keycloak
  `http://localhost:8099` (realm well-known), Redis `redis://localhost:6379/1` (PING), BFF Mongo `localhost:27018`
  (connect).
- **Input**: flag set + a required dep down.
- **Output**: `globalSetup` throws → jest reports the run as failed (no green).
- **Legitimate skips**: documented in-code (env-gated optional profiles only); jest has no per-test escalation, so
  the preflight is the enforcement point.

### cargo (mc-service) — NEW guard, no new escalation needed

Rust has no skip primitive: `common/mod.rs` `.expect()`s the Mongo connection, so a missing dep **panics/fails**.
The only false-green vector is an `#[ignore]` attribute or a conditional early-`return` shrinking the run to zero.

- **Guard**: assert the integration run **executed** its tests — a non-zero executed count / the expected test
  binaries ran. An all-`#[ignore]` or zero-executed run is treated as **failure**, not success.
- **Rule**: `#[ignore]` is forbidden on `mc-service/tests/integration/**`.
- **Input**: flag set + DB down → `.expect()` panic → FAIL (already correct).
- **Input**: someone `#[ignore]`s the suite → executed-count guard → FAIL.

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
