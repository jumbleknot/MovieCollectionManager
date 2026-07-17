# Phase 1 Data Model: Integration-Test CI Enforcement

This feature is CI-enablement, not a data feature. The "entities" are the configuration and test artifacts the
change manipulates, plus the shape of the shared skip-escalation convention. No persisted domain data is added.

---

## Entity: Integration suite (per project)

The unit of coverage being enforced. Three instances.

| Attribute | agent (movie-assistant) | mc-service | mcm-app (BFF) |
|---|---|---|---|
| Nx target | `test:integration movie-assistant` | `test:integration mc-service` | `test:integration mcm-app` |
| Runner | pytest (`uv`) | `cargo test --tests --test-threads=1` | `jest --config jest.integration.config.js` |
| Real deps | Keycloak, mc-service, 3 MCP servers, gateway, runtime model | replica-set Mongo (`27017`), Keycloak JWKS (`8099`) | BFF (`8082`), Keycloak (`8099`), Redis db 1 (`6379`), BFF Mongo (`27018`) |
| Currently in CI? | Yes (PR #77) with 8 excluded | No | No |
| Skip-escalation guard | `conftest.py` hook (exists) | executed-test-count guard + no `#[ignore]` | dependency preflight (new) |
| Selection filter (CI step) | `-m "not golden"` (after un-quarantine) | none | none |

**State transition (agent suite)**: `wired-with-8-excluded` → *(remediate each of A/B/C)* → `wired-all-running`
→ *(remove marker registration + revert filter)* → `enforced` (definition of done for Story 1).

**State transition (mc-service, mcm-app)**: `unrun` → *(add step + skip guard)* → `wired` → *(broken-on-purpose
proves it bites)* → `enforced`.

---

## Entity: Quarantine marker (`ci_quarantine`)

The mechanism being **removed**, not evolved.

- **Registration**: `agents/movie-assistant/pyproject.toml` `[tool.pytest.ini_options] markers` entry.
- **Applications**: 8 `@pytest.mark.ci_quarantine` decorators across 4 files (`test_curator_enrich.py` ×3,
  `test_resolution_realistic.py` ×1, `test_query_flow.py` ×2, `test_search_flow.py` ×1, `test_gateway_add_e2e.py`
  ×1) — each with an explanatory comment.
- **CI reference**: `app-ci.yml` `app-e2e` step `-m "not golden and not ci_quarantine"`.
- **Invariant on completion (AC1)**: `grep -r ci_quarantine agents/movie-assistant/tests` returns nothing; the
  marker registration is deleted; the step filter is `-m "not golden"`. Removing a decorator re-enters that test
  into the gate automatically.
- **Remediation buckets**: A = TMDB (4), B = tool-choice (3), C = add-persist (1) — see `research.md` D1–D3.

---

## Entity: Skip-escalation convention (the shared no-false-green contract)

Not a data record — a policy with a concrete shape per runner. One signal, three enforcements, one allowlist
policy. Full behavioral contract in `contracts/skip-escalation-convention.md`.

- **Signal**: env flag `MCM_REQUIRE_LIVE_STACK` (`"1"` in `app-e2e`; unset locally → skip-clean preserved).
- **Legitimate-skip allowlist (policy, per suite)**: an explicit, deliberately-curated set of skip reasons that
  remain legitimate even with the flag set — the env-gated optional profiles (OPA, LangFuse/OTel, Unleash,
  OpenSearch), golden-cassette paths, genuine data-conditions, and "runtime model has no Ollama". Adding an entry
  is a deliberate act (the red CI is the prompt). Agent: `_LEGITIMATE_SKIPS` tuple in `conftest.py` (exists).
  mcm-app: documented in the preflight module. mc-service: N/A (no skip primitive; `#[ignore]` forbidden instead).
- **Enforcement by runner**:
  - pytest → escalate non-allowlisted SKIP to FAIL (existing hook).
  - jest → preflight throws on any required-dep-down (fail-fast; no silent all-skip).
  - cargo → executed-test-count guard (an all-`#[ignore]`/zero-run cannot pass green) + no `#[ignore]`.

---

## Entity: CI step wiring (`app-e2e` job)

The change surface in `.forgejo/workflows/app-ci.yml`. Full contract in
`contracts/app-e2e-integration-steps.md`.

- **Reverted step (A)**: "Agent integration tests" — filter `not golden and not ci_quarantine` → `not golden`.
- **New step (B)**: "mc-service integration tests" — after bring-up, before web/APK/emulator; env `MC_DB_URL`,
  `KEYCLOAK_URL`/`_REALM`/`_CLIENT_ID`, `MCM_REQUIRE_LIVE_STACK=1`; needs Rust toolchain on the host.
- **New step (C)**: "BFF integration tests" — same placement; env `BFF_BASE_URL=http://localhost:8082`, Keycloak +
  ROPC creds (from job env / `$GITHUB_ENV`), Redis db 1, BFF Mongo `27018`, `MCM_REQUIRE_LIVE_STACK=1`.
- **Ordering invariant (SC-006)**: both new steps run *before* the emulator legs (fast-fail preserved).

---

## Entity: Relocated model-decision assertion (golden destination)

For bucket B tests resolved by relocation (D2): the exact-tool-choice assertion moves from the live integration
test into a golden-cassette pair (`agents/movie-assistant/tests/golden/…`), recorded against the runtime model.
The live test either goes away or is loosened to a behavior-level (not exact-tool) assertion. No new schema — the
golden harness's existing cassette format.
