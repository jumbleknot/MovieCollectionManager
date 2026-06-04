# Quickstart: Clean Expo Router — Verification Runbook

How to verify each user story locally. Iterative work runs against Metro; the deterministic decision of pass-vs-broken uses the dev container (`E2E_BFF_TARGET=dev-container`, ~54s/93) per the CLAUDE.md diagnosing-flakiness guidance.

## Prerequisites

```powershell
pnpm install
pnpm nx up-keycloak infrastructure-as-code   # Keycloak + Redis + Mongo + mc-service
# RTK active in the shell (rtk gain shows >80% after the first test run)
```

## US1 — Filter options reach the correct handler

```powershell
# Unit/route guard (fast): fails if filter-options is served by the single-movie handler
pnpm nx test mcm-app -- --testPathPattern filter-options-routing

# End-to-end (web): movies filter chips populate
pnpm nx e2e mcm-app -- tests/e2e/web/movies.spec.ts
```

Expected: the routing guard asserts a `FilterOptionsDto`-shaped response from the dedicated handler; the single-movie handler is never invoked for `…/movies/filter-options`. A malformed id still 400s at the edge.

## US2 — Every 4xx at the BFF boundary is logged

```powershell
# Unit: handleMcApiError emits a warn log for a non-401/403 4xx, audit for 401/403
pnpm nx test mcm-app -- --testPathPattern mc-api-error
```

Expected: a 400/404/409 produces exactly one `warn` entry with `action` + `statusCode` + `requestId`; 401/403 still produce `audit` entries; no token/PII/raw-id in any line.

## US3 — Centralized gate

### Step 0 — Viability spike (do this first)

```powershell
# 1. In app.json add the plugin flag:
#    ["expo-router", { "unstable_useServerMiddleware": true }]
# 2. Add a minimal src/app/+middleware.ts that logs and passes through.
# 3. Build + run the dev container and confirm the middleware executes for a /bff-api request:
pnpm nx docker-build mcm-app
docker compose --profile bff-dev up -d
# hit a /bff-api route (web fetch and a native HTTP call) and confirm the middleware ran,
# and that returning a Response short-circuits the handler.
```

If the capability does not execute / cannot short-circuit → **descope US3 to a follow-up**; US1+US2 still ship.

### Step 1 — Gate enforcement (after spike passes)

```powershell
# Integration: unauthenticated protected route rejected at the gate (handler not executed); public route passes
pnpm nx test:integration mcm-app -- --testPathPattern bff-gate

# Web E2E regression (deterministic baseline)
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app
```

Expected: unauthenticated `GET /bff-api/collections` → `401` with security headers, handler not run; `POST /bff-api/auth/login` and `/bff-api/auth/refresh` reachable unauthenticated; authenticated requests still pass `requireMcUser`; the coverage safeguard fails if the gate is disabled.

## Full regression (final validation)

```powershell
pnpm nx test mcm-app
pnpm nx test:integration mcm-app
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app   # 93/93, ~54s — far slower or failing ⇒ suspect a real regression
pnpm nx e2e:mobile mcm-app                          # unchanged (no new gate flow)
rtk gain                                            # >80% compression
```

## Reset to Metro

```powershell
docker compose rm -sf mcm-bff mcm-bff-dev caddy
cd frontend/mcm-app && pnpm start
```
