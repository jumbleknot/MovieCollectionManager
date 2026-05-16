# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MovieCollectionManager is a multi-user application for browsing and managing movie collections from web and mobile. It uses a layered architecture:

- **Frontend (mcm-app)**: React Native Expo app targeting web, and Android
- **BFF (Backend for Frontend)**: Node.js server running inside Expo Router API routes — handles auth and session management
- **Keycloak**: External IAM for OAuth 2.0 + PKCE, RBAC, and SSO
- **mc-service**: Future Rust/Axum microservice for movie collection domain logic
- **Redis**: BFF session store and cache
- **PostgreSQL**: Keycloak database
- **MongoDB**: planned for movie collection data

## Spec-Driven Development (SDD)

This repository and its projects follows SDD approach (using Specify CLI) with repository wide constitution (`constitution.md`) and feature specific artifacts: spec (`spec.md`), plan (`plan.md`), and tasks (`tasks.md`).  During feature creation, any changes that deviate from prior artifacts for this feature must be updated to stay aligned (e.g., if implementation deviates from plan and tasks, then go back and update plan and tasks).  Any changes that deviate from the constitution must be approved by human and documented rationale for deviation.

## Test-Driven Development (TDD)

TDD is mandatory: Test cases written → User approval → Tests fail → Implementation → Tests pass → Refactor. Unit tests exercise individual functions/methods. Integration tests verify service-to-service and service-to-database contracts. E2E tests cover critical user flows on a real device or simulator. Code changes without corresponding test coverage are not permitted.

## Commands

**Package manager: pnpm. Task runner: Nx. Never use npm or yarn. Never invoke pnpm scripts directly when an Nx target exists.**

Install dependencies (from repo root):

```bash
pnpm install
```

All other operations go through Nx (run from repo root, using `pnpm nx` — never bare `nx`):

```bash
pnpm nx test mcm-app              # unit tests (70% line coverage enforced)
pnpm nx test:integration mcm-app  # integration tests (requires Keycloak + Redis running)
pnpm nx lint mcm-app              # ESLint
pnpm nx e2e mcm-app               # web E2E via Playwright (starts Expo automatically; reuses if already running)
pnpm nx e2e:mobile mcm-app        # mobile E2E via Maestro (requires Android emulator running)
pnpm nx build mcm-app             # build BFF Docker image
pnpm nx deploy mcm-app            # start Keycloak + build image (parallel), then deploy BFF + Redis (prerequisite: .env.docker present)
pnpm nx docker-down mcm-app       # stop BFF + Redis
pnpm nx run-many --targets=test,lint   # all cacheable checks across all projects
pnpm nx run-many --target=build        # build all projects
pnpm nx run-many --target=deploy       # deploy all projects
```

Dev server (direct — no Nx target needed):

```bash
cd frontend/mcm-app && pnpm start   # press w=web, a=Android, i=iOS
```

Type-check (direct — no Nx target):

```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```

## Local Dev Infrastructure

One-time setup:
```bash
docker network create backend-network
docker network create frontend-network
```

Start Keycloak (prerequisite for BFF):
```bash
cd infrastructure-as-code/docker/keycloak
docker compose -f compose.yaml up -d
# Admin UI: http://localhost:8099  Mail: http://localhost:8025
```

Typical dev loop: start Keycloak → run `pnpm start` in `frontend/mcm-app` → test in browser. For full BFF testing, build the Docker image and run `infrastructure-as-code/docker/bff/compose.yaml`.

## Architecture

### BFF Pattern

The BFF (`src/bff-server/`) runs server-side inside the Expo Router Node.js container. It owns all token handling — the React Native client never touches raw JWTs.

**Login flow:**
1. Client performs OAuth 2.0 + PKCE with Keycloak, gets an authorization code
2. Posts code to `bff-api/auth/login+api.ts`
3. BFF exchanges code for tokens via Keycloak, validates JWT signature and `at_hash`
4. Stores session in Redis, sets HttpOnly/Secure/SameSite=Strict cookies
5. Client stores only the session ID (not tokens)

**Subsequent requests:** BFF extracts JWT from HTTP-only cookies, validates, then proxies to backend services.

### BFF Server Modules (`src/bff-server/`)

| Module | Purpose |
|---|---|
| `auth.ts` | JWT validation middleware, cookie/header extraction, user profile building |
| `token-service.ts` | JWT signature validation, role extraction, `at_hash` validation |
| `keycloak.ts` | Token exchange; user lookup via service account (client credentials grant) |
| `session-manager.ts` | Redis-backed sessions; enforces `MAX_CONCURRENT_SESSIONS` (evicts oldest) |
| `rate-limiter.ts` | Per-IP login attempt limiting |
| `cache-service.ts` | Redis wrapper |
| `email-service.ts` | Email verification flow integration with Keycloak |

### BFF API Routes (`src/app/bff-api/auth/`)

`login+api.ts`, `logout+api.ts`, `refresh+api.ts`, `register+api.ts`, `verify-email+api.ts`, `resend-verification+api.ts`, `user+api.ts`, `init+api.ts`

### Frontend Auth

- `hooks/use-auth.tsx` — global auth context (`isAuthenticated`, `user`, `refreshAuth`, `logout`); wraps entire app via `app/_layout.tsx`
- `hooks/use-login.ts` / `use-logout.ts` / `use-registration.ts` — action hooks
- `utils/token-refresh.ts` — intercepts 401s, auto-refreshes, retries original request
- `bff-server/api-client.ts` — Axios instance with BFF interceptors
- `config/keycloak.ts` — Keycloak endpoint configuration

### Routing

File-based routing via Expo Router:
- `app/(auth)/` — unauthenticated routes (login, register)
- `app/(app)/` — protected routes (home, profile)
- `app/bff-api/` — server-side API handlers (Node.js only, not client bundles)

Protected routes use `<ProtectedRoute>` or `useAuthGuard()` which check RBAC before rendering.

### Access Control

Two layers:
1. **RBAC**: user must hold `mc-admin` or `mc-user` role in Keycloak (enforced by BFF)
2. **DAC**: collection-level ACLs (owner/contributor/viewer) — planned in mc-service/MongoDB

### Key Types (`src/types/`)

- `auth.ts` — `ClientRole`, `KeycloakUser`, `JWTPayload`, `UserProfile`, `Session`, API request/response contracts
- `errors.ts` — `AuthError` hierarchy with typed codes (`INVALID_INPUT`, `TOKEN_EXPIRED`, `FORBIDDEN`, …)

## Configuration

Server-side env vars (BFF only, never exposed to client):

| Variable | Default |
|---|---|
| `KEYCLOAK_URL` | `http://localhost:8099` |
| `KEYCLOAK_REALM` | `jumbleknot` |
| `KEYCLOAK_CLIENT_ID` | `movie-collection-manager` |
| `KEYCLOAK_CLIENT_SECRET` | — |
| `KEYCLOAK_SERVICE_CLIENT_ID` | service account for Admin API |
| `KEYCLOAK_SERVICE_CLIENT_SECRET` | — |
| `REDIS_URL` | `redis://localhost:6379` |
| `COOKIE_SECRET` | — |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` (30 min) |
| `SESSION_ABSOLUTE_TIMEOUT_MS` | `86400000` (24 hr) |
| `MAX_CONCURRENT_SESSIONS` | `10` |

TypeScript path alias: `@/*` → `src/*` (strict mode enabled).

## Non-Obvious Design Decisions

- **HTTP-only cookies**: tokens are never accessible to client-side JS — all token operations go through BFF endpoints
- **Service account vs admin credentials**: Keycloak Admin API calls use a dedicated service account (client credentials grant), not the admin password
- **Session ID vs JWT**: Redis session tracks timeout and concurrent session limits independently of the JWT lifetime
- **Expo `"output": "server"`**: `app.json` sets Metro web output to `server`, enabling the Node.js/Express integration — not a static export
- **Docker internal DNS**: BFF contacts Keycloak via `keycloak-service:8080` inside Docker networks, not `localhost`
- **Concurrent session eviction**: when a user exceeds `MAX_CONCURRENT_SESSIONS`, `session-manager.ts` evicts the oldest session automatically
- **Playwright testID**: React Native Web renders `testID` as `data-testid`, which is the locator attribute set in `playwright.config.ts`

## Testing Requirements

- **No Runtime Patches**: A test must fail if the feature is broken; do not allow Claude to "fix" the app inside the test script.
- **Stable Selectors**: Use data-testid or ARIA roles rather than fragile CSS classes to ensure tests remain robust.
- **Independent State**: Ensure each test resets the environment to avoid sharing state between runs.
- **Consistent E2E Tests Across Clients**: E2E test cases should be repeated for web (Playwright CLI) and mobile (Maestro CLI) clients for the same frontend app.

### Android (Emulator)

Use Maestro CLI for all Android UI testing.

- Flows live in `tests/e2e/mobile/` as `.yaml` files
- Run a flow: `maestro test mobile/flow_name.yaml`
- Run all flows: `maestro test mobile/`
- Take a screenshot: `maestro screenshot`
- View device: `maestro studio` (interactive)
- Emulator must be running before executing flows

### Web

Use Playwright CLI for all web UI testing. (requires Expo running on :8081)

- Tests live in `tests/e2e/web/` as `.spec.ts` files  
- Run tests: `pnpm exec playwright test`
- Run headed: `pnpm exec playwright test --headed`
- Debug mode: `pnpm exec playwright test --debug`
- Start Expo web first: `pnpm exec expo start --web`


<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->