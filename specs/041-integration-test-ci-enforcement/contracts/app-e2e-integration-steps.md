# Contract: `app-e2e` Integration-Test Steps

Defines the CI steps this feature adds to / changes in the `app-e2e` job of
[.forgejo/workflows/app-ci.yml](../../../.forgejo/workflows/app-ci.yml). The job already brings up the `auth`
stack (Keycloak + realm), the `mcm` stack (`--profile app --profile bff-nonsecure` → mc-service, replica-set
`mc-service-store-mongo`, `mcm-bff-store-mongo`, `mcm-bff-cache-redis`, dev BFF `:8082`), and the agent stack.
All three steps run **after** bring-up and **before** the Web E2E / APK build / emulator steps (fast-fail).

---

## Step A (revert) — Agent integration tests

- **Command**: `pnpm nx test:integration movie-assistant -- -m "not golden"`
  *(was `-m "not golden and not ci_quarantine"`)*
- **Precondition**: all 8 `@pytest.mark.ci_quarantine` decorators removed and the marker registration deleted from
  `pyproject.toml` (else the filter errors on an unknown marker / silently no-ops).
- **Env**: unchanged from PR #77 — `MCM_REQUIRE_LIVE_STACK=1`, `KEYCLOAK_URL=http://localhost:8099`,
  `MC_SERVICE_URL=http://localhost:3001`, `E2E_ROPC_CLIENT_ID=mcm-bff-test`, the run-minted
  `E2E_ROPC_CLIENT_SECRET` (from `$GITHUB_ENV`), `E2E_TEST_USER`/`E2E_TEST_PASSWORD`/`ANTHROPIC_API_KEY`/
  `TMDB_API_KEY` (job env).
- **Pass**: exit 0 with **0 deselected-as-quarantine** tests; the ~43 that passed plus the newly-fixed 8 all run.
- **Fail**: any of the 8 still failing; any non-allowlisted SKIP (escalated by the conftest hook).

---

## Step B (new) — mc-service integration tests

- **Command**: `pnpm nx test:integration mc-service`
  *(Nx target = `cargo test --manifest-path backend/mc-service/Cargo.toml --tests -- --test-threads=1`)*
- **Host prerequisite**: Rust stable toolchain on the `kvm` runner (install as `mc-service-checks` does — rustup
  minimal + `apt-get install build-essential pkg-config libssl-dev`). Confirm before wiring (FR-008).
- **Env**:
  - `MC_DB_URL=mongodb://localhost:27017/mc_db?replicaSet=rs0&directConnection=true` (published `27017`; rs member
    is `localhost:27017`; `directConnection=true` is load-bearing).
  - `KEYCLOAK_URL=http://localhost:8099`, `KEYCLOAK_REALM=grumpyrobot`,
    `KEYCLOAK_CLIENT_ID=movie-collection-manager` (`health_test.rs` fetches JWKS on app build).
  - `MCM_REQUIRE_LIVE_STACK=1` (semantic parity; enforced via the executed-test-count guard, not a pytest hook).
- **Pass**: exit 0; the collections/movies/health integration binaries all executed and passed.
- **Fail**: a `.expect()` panic on an unreachable Mongo (hard-fail, not skip); any assertion failure; an
  **executed-test count of 0** (all-`#[ignore]` / no binary ran) — the guard treats that as failure, not green.
- **Broken-on-purpose proof (AC2/SC-003)**: a deliberate repository regression (e.g. break the cascade-delete
  transaction) turns this step red.

---

## Step C (new) — BFF integration tests

- **Command**: `pnpm nx test:integration mcm-app`
  *(Nx target = `jest --config jest.integration.config.js --watchAll=false`, `maxWorkers:1`, `forceExit:true`)*
- **Env** (via the step env and/or the files `tests/integration/setup/env.ts` loads — `.env.e2e.local` then
  `.env.local`; align the loaded filenames with what `gen-ci-env.mjs` writes, or export the vars into the step):
  - `BFF_BASE_URL=http://localhost:8082` (containerized dev BFF, `bff-nonsecure`).
  - Keycloak `localhost:8099`; `E2E_ROPC_CLIENT_ID=mcm-bff-test` + run-minted `E2E_ROPC_CLIENT_SECRET`;
    `E2E_TEST_USER`/`E2E_TEST_PASSWORD`; the Keycloak service-account secret for Admin REST
    (`KEYCLOAK_SERVICE_CLIENT_SECRET`).
  - `REDIS_URL`/`REDIS_TEST_URL` → `redis://localhost:6379/1` (db-1 isolation; pinned by `env.ts`).
  - BFF Mongo `MONGO_URL` → `localhost:27018` (`bff_db`; self-clean by test-prefixed userId in `afterAll`).
  - `MCM_REQUIRE_LIVE_STACK=1` (enforced via the jest dependency preflight).
- **Pass**: exit 0; suite drove the live BFF and asserted against real Redis/Keycloak/Mongo; `afterAll` left no
  residual test data (SC-005).
- **Fail**: preflight throws if any required dependency is down (no silent all-skip); any assertion failure.
- **Broken-on-purpose proof (AC3/SC-003)**: a deliberate BFF regression (e.g. break session eviction or the
  rate-limit counter) turns this step red.

---

## Cross-step invariants

- **No new host ports**: only the already-published `8099/8082/3001/27017/27018/6379` are used.
- **No new secrets**: every credential comes from the Forgejo Actions store + `gen-ci-env`/`gen-dev-secrets` +
  the run-minted ROPC secret already in `$GITHUB_ENV`.
- **Teardown**: the existing `always()` `compose down -v` + `down-agents-prod` still tears every stack down (no
  CI stack may hold a prod port — feature 029).
- **Ordering**: A, B, C all precede the Web E2E / APK / emulator steps; a failure in any is reported in minutes.
