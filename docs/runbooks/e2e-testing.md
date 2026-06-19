# Runbook: E2E Testing (BFF-container modes, flakiness, integration harness)

> Loaded on demand — referenced from CLAUDE.md. The day-to-day Test Run Protocol and Final Validation Checklist live in CLAUDE.md; this runbook holds the container-mode procedures, the flakiness-diagnosis protocol, and the BFF integration-test harness facts. For mobile/Android specifics see [android-emulator.md](android-emulator.md).

## Final local E2E runs against the BFF container (feature 007)

**Testing procedure (3 phases):**

1. **Iterative development is Metro-only.** All coding plus unit / integration / iterative E2E run against Metro (`pnpm nx e2e mcm-app`, `pnpm nx test`, `pnpm nx test:integration`, type-check). Metro is the fast inner loop and the **default state** of the repo.
2. **Final E2E validation runs against the containerized BFF — the dev container (non-Secure HTTP, `:8082`)** — only *after* the Metro suites are green. This exercises the real `@expo/server` production server (not Metro's dev server) and proves the request path is the container, not Metro, via the `X-BFF-Source` header (asserted in `global-setup.ts`, fail-fast on a Metro false-green).
3. **After all green, reset the environment to Metro-only** (tear down the container + revert `.env.local` — see "Switch back to Metro" below).

**The prod container (HTTPS, Secure cookies) is reserved for a future CI/CD pipeline — it is NOT a routine local step.** There is no CI E2E job today; feature 007 proved the prod-HTTPS path works locally (US3, kept for reference in the quickstart), but going forward that hardened run belongs in CI/CD, not the local loop. Full runbook for all modes: [specs/007-e2e-bff-container/quickstart.md](../../specs/007-e2e-bff-container/quickstart.md).

The same app + BFF **code** runs in every mode; only the *server fronting it* (Metro vs `@expo/server`-in-a-container) and the *cookie/TLS posture* change:

| Mode | BFF served by | Port | Cookies | When to use | Web command | Mobile deltas (`frontend/mcm-app/.env.local` + `adb reverse`) |
|---|---|---|---|---|---|---|
| **Local dev** *(default)* | Metro (`@expo/server` dev) | `:8081` HTTP | non-Secure | **iterative development** + unit/integration/iterative E2E | `cd frontend/mcm-app && pnpm start` (press `w` for web) | `EXPO_PUBLIC_BFF_NATIVE_URL=http://10.0.2.2:8081`, `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://10.0.2.2:8099`; `adb reverse tcp:8081 tcp:8081` |
| **Dev container** | Docker `mcm-bff-dev` (`NODE_ENV=development`) | `:8082` HTTP | non-Secure | **local final E2E** (after dev is green) | `docker compose --profile bff-dev up -d` then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` | `EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082`, `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099`; `adb reverse tcp:8081`+`tcp:8082`+`tcp:8099`; restart Metro `--reset-cache` |
| **Prod container** | Docker `mcm-bff` + Caddy (`NODE_ENV=production`) | `:8443` **HTTPS** | **Secure** | **future CI/CD only** | `docker compose --profile bff-prod up -d` then `E2E_BFF_TARGET=prod-container pnpm nx e2e mcm-app` | mobile is **CA-trust-limited** (needs a debug `network_security_config` + APK rebuild — see quickstart §2 / research R3) |

**Switch back to Metro (the reset after a container run):**

```bash
docker compose rm -sf mcm-bff mcm-bff-dev caddy   # remove ONLY the BFF/proxy containers (NOT `--profile … down`, which stops the shared stack)
# revert the two frontend/mcm-app/.env.local native URLs to their 10.0.2.2 defaults
cd frontend/mcm-app && pnpm start                 # Metro is the default state again
```

The shared backend (Keycloak/Redis/Mongo/mc-service) and the `KC_HOSTNAME` issuer pin stay up — both are harmless for (and required by) Metro dev.

**Prerequisite (one-time):** Keycloak must expose a **stable issuer** or the container BFF's token refresh fails (`invalid_grant: Invalid token issuer`) — the browser mints `iss=localhost:8099` but the container refreshes over `keycloak-service:8080`. `infrastructure-as-code/docker/keycloak/compose.yaml` pins `KC_HOSTNAME=http://localhost:8099` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`; if Keycloak predates this change, recreate it once (`docker compose --profile keycloak up -d keycloak-service`). The client's container redirect URIs are added via `infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs`.

**Dev container (HTTP, non-Secure cookies) — the standard final run:**

```bash
pnpm nx docker-build mcm-app                              # build mcm-bff:latest (once per code change)
docker compose --profile bff-dev up -d                   # dev BFF on 127.0.0.1:8082 (NODE_ENV=development)

# Web — container serves client + BFF; stop Metro first so it can't serve a false-green:
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app          # 92/92 green, ~50s (prebuilt bundle, no JIT)

# Mobile — Metro serves JS on :8081, container serves /bff-api on :8082 (dual-port):
#   adb reverse tcp:8081 + tcp:8082 + tcp:8099 (8099 = Keycloak; issuer must match localhost:8099)
#   In frontend/mcm-app/.env.local set EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082 and
#   EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099 (NOT inline — inline env does not reach the
#   bundle), restart Metro --reset-cache, then: pnpm nx e2e:mobile mcm-app  (revert .env.local after).
```

**Prod container (HTTPS, Secure cookies) — future CI/CD, NOT a routine local run.** Same pattern with `E2E_BFF_TARGET=prod-container` (`bff-prod` profile, Caddy TLS on `https://localhost:8443`); kept in [quickstart §2](../../specs/007-e2e-bff-container/quickstart.md) for reference. Defer this hardened run to the CI/CD pipeline — locally, stop at the dev-container final E2E above and reset to Metro.

## Diagnosing E2E flakiness — rule out a real regression BEFORE blaming the environment (feature 009 lesson)

> "Metro degrades over long sessions" / "emulator GPU contention" / "machine overload" are *real* but they are the **last** explanation to reach for, not the first. They are seductive because they require no code investigation — and that is exactly the trap: in feature 009 a genuine code regression (a strict `validateObjectId` 400'ing the Expo-Router-shadowed `…/movies/filter-options` sub-path, invisible because `handleMcApiError` doesn't log 4xx) was repeatedly misattributed to machine/Metro degradation, wasting hours. **The goal is clean runs faster — so diagnose deterministically:**
> 1. **Use the dev-container path, not Metro, to decide flaky-vs-broken.** `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` runs against a prebuilt bundle on `:8082` — **deterministic, ~54s for 93 tests**. It has none of Metro's JIT/long-session variance. If the container run is far slower than ~54s or fails, that is a **real regression**, full stop — do not say "flaky."
> 2. **Compare against a known-green baseline on the SAME (clean) machine.** Before concluding "environment," `git stash`/checkout the last known-green ref (e.g. the prior merge commit), rebuild the container, and run it ×3. If the baseline is green ×3 and your branch isn't, the fault is your code — bisect the diff, don't tune the emulator. (Reboot first only to remove that as a variable, not as the fix.)
> 3. **A clean container run is fast.** Treat "a green run shouldn't take this long" as a real signal, not background noise — the user was right about exactly this.
> 4. **Check whether the error is even surfaced.** A swallowed/unlogged 4xx (see `handleMcApiError`, which only audit-logs 401/403) makes a hard failure *look* like flakiness. Instrument the boundary before guessing.
>
> Only after the container baseline confirms the failure is non-deterministic AND machine-local should you reach for the readiness ritual below.

> **Bounded E2E retry (feature 006, FR-006).** Environmental flakiness on the loaded emulator/Metro is absorbed by **at most one** explicit, visible retry per test — never more (more would risk masking a real defect). Mobile: `scripts/maestro-e2e.mjs` re-prepares and re-runs a failed flow once, logging `⟳ RETRY 1/1`; a genuine regression fails both attempts and still fails the suite. Web: Playwright `retries: 1` in `playwright.config.ts`, plus `global-setup.ts` warms `/home`, the collection screen, and a movie-detail screen so the first test doesn't eat the Metro cold-compile. **Readiness ritual for a reproducible green run (apply only after step-1/step-2 above have ruled out a code regression):** start Metro fresh from `frontend/mcm-app` (it degrades over long sessions); for web E2E stop the emulator first (GPU/SSO contention); for mobile E2E run the emulator startup ritual (`-no-snapshot-load`, `adb reverse tcp:8081 tcp:8081`, `-gpu swiftshader_indirect`).

## BFF Integration Test Harness (mcm-app)

BFF integration tests (`frontend/mcm-app/tests/integration/*.integration.test.ts`) run against **real** Keycloak + Redis + mc-service (constitution v1.3.0 — no mocking) via a dedicated `frontend/mcm-app/jest.integration.config.js` (**not** the package.json `jest` block). Run: `pnpm nx test:integration mcm-app`. The unit target (`pnpm nx test mcm-app`) excludes `tests/integration/`. Key facts (so they aren't rediscovered):

- **Node env + serial:** `testEnvironment: 'node'`, `maxWorkers: 1` (tests share Redis db 1 and the live BFF — parallel `flushdb`/teardown would wipe another file's data mid-test), `forceExit: true` (cache-service leaves an `ioredis` handle open with no public close).
- **Module-resolution stubs:** `babel-preset-expo` (reused for the TS transform) injects `import { env } from 'expo/virtual/env'`, and BFF source transitively imports `react-native` (`Platform.OS` in `@/config/keycloak`). Both are stubbed via `moduleNameMapper` → `tests/integration/setup/{expo-env-stub,react-native-stub}.js` so Node can import server source; `@/` maps to `src/`. (The unit suite avoids this only because `jest-expo` transforms expo/RN.)
- **Env + Redis isolation:** `tests/integration/setup/env.ts` loads `.env.e2e.local` (ROPC creds) then `.env.local` (service-account secret), then **pins `REDIS_URL` to db 1**. The running BFF uses **db 0** — HTTP-level session tests (logout, refresh) seed/inspect db 0 via `helpers/bff-redis-client.ts`; in-process module tests use db 1 via `helpers/redis-test-client.ts`.
- **Real tokens:** `helpers/keycloak-test-client.ts` acquires tokens via the **test-only `mcm-bff-test` ROPC client** and manages users through the Admin API (raw `fetch`, no admin-client lib). Call **`ensureRopcAudienceMapper()` in `beforeAll`** for any test that hits `validateJwt` or mc-service — without the audience mapper, ROPC tokens (`azp=mcm-bff-test`) are rejected as "Invalid token audience". The ROPC grant must never be enabled on the production `movie-collection-manager` client.
- **Headless-untestable happy paths (justified E2E exclusions, enforced by the gate):** login PKCE code exchange, `/auth/refresh` token rotation (production-client refresh token is browser-PKCE-only), and `/auth/verify-email` (Keycloak email action-token). `tests/integration/route-coverage.integration.test.ts` + `route-coverage-map.ts` fail if any `+api.ts` route lacks a test or a justified exclusion — login is the only map-level exclusion.

## Web

Use Playwright CLI for all web UI testing. (requires Expo running on :8081)

- Tests live in `tests/e2e/web/` as `.spec.ts` files
- Run tests: `pnpm exec playwright test`
- Run headed: `pnpm exec playwright test --headed`
- Debug mode: `pnpm exec playwright test --debug`
- Start Expo web first: `CI=1 pnpm exec expo start --web`
