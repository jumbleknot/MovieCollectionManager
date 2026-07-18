# Quickstart: Validate Integration-Test CI Enforcement

How to run each suite locally against the same real stack CI uses, and how to prove each gate actually bites. This
is a validation guide — implementation belongs in `tasks.md`.

## Prerequisites

- The `app-e2e` stack up locally (or the dev container): `auth` stack (Keycloak `:8099` + realm) and `mcm` stack
  `--profile app --profile bff-nonsecure` (mc-service, replica-set `mc-service-store-mongo` `:27017`,
  `mcm-bff-store-mongo` `:27018`, `mcm-bff-cache-redis` `:6379`, dev BFF `:8082`), plus the agent stack
  (`pnpm nx up-agents-prod infrastructure-as-code`) for the agent suite.
- `node scripts/gen-dev-secrets.mjs` run once; the per-suite creds available (`E2E_ROPC_CLIENT_SECRET`,
  `KEYCLOAK_SERVICE_CLIENT_SECRET`, `E2E_TEST_USER/PASSWORD`).
- RTK active (`rtk gain` > 80%). Rust toolchain for the mc-service suite.

---

## Story 1 — Agent suite fully enforced (no quarantine)

```bash
# All 8 formerly-quarantined tests now pass under the live gate (no `not ci_quarantine`):
MCM_REQUIRE_LIVE_STACK=1 KEYCLOAK_URL=http://localhost:8099 MC_SERVICE_URL=http://localhost:3001 \
  pnpm nx test:integration movie-assistant -- -m "not golden"

# Prove the marker is gone (AC1):
grep -r ci_quarantine agents/movie-assistant/tests   # expect: no matches
grep -n ci_quarantine .forgejo/workflows/app-ci.yml  # expect: step reads `-m "not golden"` only
```

**Expected**: exit 0; the ~43 previously-passing plus the 8 remediated tests all run and pass; 0 deselected as
quarantine.

**Per-bucket local checks**:
- **TMDB (A)**: `docker exec movie-assistant-mcp-webapi printenv TMDB_API_KEY` returns a valid key; a live
  `search_title` returns data (not "That request couldn't be completed").
- **Tool-choice (B)**: the relocated assertions run green in the golden harness
  (`pnpm nx test:integration movie-assistant -- -m golden` in replay); the live tests no longer assert an exact
  tool.
- **Add-persist (C)**: an approved add creates the collection — poll mc-service and confirm the record exists.

---

## Story 2 — mc-service integration in CI

```bash
MC_DB_URL='mongodb://localhost:27017/mc_db?replicaSet=rs0&directConnection=true' \
KEYCLOAK_URL=http://localhost:8099 KEYCLOAK_REALM=grumpyrobot KEYCLOAK_CLIENT_ID=movie-collection-manager \
  pnpm nx test:integration mc-service
```

**Expected**: exit 0; collections/movies/health integration binaries pass against the real replica set.

**Prove it bites (AC2/SC-003)**: temporarily break the cascade-delete transaction in
`collection_repository.rs` → the suite fails → revert.

**Prove no false-green (AC4/SC-004)**: stop `mc-service-store-mongo` → the run **panics/fails** (not skips).

---

## Story 3 — mcm-app BFF integration in CI

```bash
BFF_BASE_URL=http://localhost:8082 REDIS_URL='redis://localhost:6379/1' \
  pnpm nx test:integration mcm-app
# (E2E_ROPC_*, KEYCLOAK_SERVICE_CLIENT_SECRET, MONGO_URL:27018 loaded from .env.e2e.local/.env.local by env.ts)
```

**Expected**: exit 0; suite drives the live BFF and asserts against real Redis (db 1) / Keycloak / Mongo; no
residual test data after `afterAll` (SC-005).

**Prove it bites (AC3/SC-003)**: temporarily break session eviction or the rate-limit counter → the suite fails →
revert.

**Prove no false-green (AC4/SC-004)**: with `MCM_REQUIRE_LIVE_STACK=1`, stop `mcm-bff-cache-redis` → the
dependency preflight throws → the run fails (does not skip to green).

---

## Story 4 — No-false-green, every suite (the shared convention)

For each suite, with the stack partially down and `MCM_REQUIRE_LIVE_STACK=1`:

| Suite | Take down | Expected |
|---|---|---|
| agent | Keycloak or an MCP server | conftest hook escalates the SKIP → FAIL |
| mc-service | `mc-service-store-mongo` | `.expect()` panic → FAIL; an all-`#[ignore]` run → executed-count guard FAIL |
| mcm-app | `mcm-bff-cache-redis` | jest preflight throws → FAIL |

A legitimately optional profile being down (e.g. `--profile observability` not up) must NOT fail the default gate.

---

## Full CI validation

The real proof is an `app-e2e` run on the branch: Steps A/B/C all green before the emulator legs, wall-clock
increase small and justified (SC-006), and the secret/naming/collision gates still green. Read
`~/mcm-ci-last-failure/` out-of-band (private memory `reference_mcm_ci_monitor_access`) if any step fails.
