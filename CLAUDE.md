# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MovieCollectionManager is a multi-user application for browsing and managing movie collections from web and mobile. It uses a layered architecture:

- **Frontend (mcm-app)**: React Native Expo app targeting web, and Android
- **BFF (Backend for Frontend)**: Node.js server running inside Expo Router API routes — handles auth and session management
- **Keycloak**: External IAM for OAuth 2.0 + PKCE, RBAC, and SSO
- **mc-service**: Rust/Axum microservice for movie collection domain logic (Clean Architecture, CQRS via `medi-rs`, MongoDB-backed)
- **Redis**: BFF session store and cache
- **PostgreSQL**: Keycloak database
- **MongoDB**: movie collection data store (`mc_db` database, `movie_collections` and `movies` collections)

## Spec-Driven Development (SDD)

This repository and its projects follows SDD approach (using Specify CLI) with repository wide constitution (`constitution.md`) and feature specific artifacts: spec (`spec.md`), plan (`plan.md`), and tasks (`tasks.md`).  During feature creation, any changes that deviate from prior artifacts for this feature must be updated to stay aligned (e.g., if implementation deviates from plan and tasks, then go back and update plan and tasks).  Any changes that deviate from the constitution must be approved by human and documented rationale for deviation.

## Test-Driven Development (TDD)

TDD is mandatory: Test cases written → User approval → Tests fail → Implementation → Tests pass → Refactor. Unit tests exercise individual functions/methods. Integration tests verify service-to-service and service-to-database contracts. E2E tests cover critical user flows on a real device or simulator. Code changes without corresponding test coverage are not permitted.

## Commands

**Package managers: pnpm (JavaScript/TypeScript workspace), cargo (Rust workspace). Task runner: Nx — orchestrates both. Never use npm or yarn. Never invoke pnpm scripts directly when an Nx target exists.**

`pnpm nx <target> <project>` is the universal invocation for all Nx-managed tasks regardless of language. For frontend projects, Nx calls the underlying Jest/Playwright/ESBuild tools. For Rust projects, Nx calls the `@monodon/rust` executor, which invokes cargo internally — cargo arguments can be passed through using `--`.

Install JavaScript dependencies (from repo root):

```bash
pnpm install
```

**Frontend (mcm-app)** — all via Nx from repo root:

```bash
pnpm nx test mcm-app              # unit tests (70% line coverage enforced)
pnpm nx test:integration mcm-app  # integration tests (requires Keycloak + Redis running)
pnpm nx lint mcm-app              # ESLint
pnpm nx e2e mcm-app               # web E2E via Playwright (starts Expo automatically; reuses if already running)
pnpm nx e2e:mobile mcm-app        # mobile E2E via Maestro (requires Android emulator running)
pnpm nx build mcm-app             # build BFF Docker image
pnpm nx deploy mcm-app            # start Keycloak + build image (parallel), then deploy BFF + Redis (prerequisite: .env.docker present)
pnpm nx docker-down mcm-app       # stop BFF + Redis
```

**Backend (mc-service)** — all via Nx from repo root (Nx invokes cargo via @monodon/rust):

```bash
pnpm nx test mc-service              # unit tests
pnpm nx test:integration mc-service  # integration tests (requires MongoDB running)
pnpm nx lint mc-service              # cargo clippy
pnpm nx build mc-service             # build Docker image
pnpm nx deploy mc-service            # start mc-service + mc-db containers
pnpm nx serve mc-service             # run mc-service locally (cargo run)

# Pass cargo flags through with --
pnpm nx test mc-service -- --test collection_create
```

**Cross-project:**

```bash
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

Start Redis (prerequisite for BFF — rate limiting and session management):
```bash
docker compose -f infrastructure-as-code/docker/bff/compose.yaml up -d mcm-redis
# Binds to 127.0.0.1:6379
```

**Without Redis, the BFF /login endpoint returns 500 "Authentication failed" because the rate-limiter's first Redis call fails before returning a typed error.**

Start mc-service + MongoDB (prerequisite for mc-service integration tests):
```bash
docker compose -f infrastructure-as-code/docker/mc-service/compose.yaml up -d
# mc-service: http://localhost:3001  MongoDB: mongodb://localhost:27017
```

**mc-service requires Keycloak running** — it fetches the JWKS endpoint on startup to cache the public key for JWT validation. Start Keycloak first.

Typical dev loop: start Keycloak + Redis → run `pnpm start` in `frontend/mcm-app` → test in browser. For full BFF testing, build the Docker image and run `infrastructure-as-code/docker/bff/compose.yaml`.

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
| `rate-limiter.ts` | Per-IP rate limiting for login and logout endpoints |
| `cache-service.ts` | Redis wrapper |
| `email-service.ts` | Email verification flow integration with Keycloak |

### BFF API Routes

**Auth** (`src/app/bff-api/auth/`):
`login+api.ts`, `logout+api.ts`, `refresh+api.ts`, `register+api.ts`, `verify-email+api.ts`, `resend-verification+api.ts`, `user+api.ts`, `init+api.ts`

**Collections** (`src/app/bff-api/collections/`):
`index+api.ts` (GET list, POST create), `[collectionId]/index+api.ts` (GET, PATCH, DELETE), `[collectionId]/movies/index+api.ts` (GET list, POST create), `[collectionId]/movies/filter-options+api.ts` (GET filter options), `[collectionId]/movies/[movieId]+api.ts` (GET, PUT, DELETE)

### Frontend Auth

- `hooks/use-auth.tsx` — global auth context (`isAuthenticated`, `user`, `refreshAuth`, `logout`); wraps entire app via `app/_layout.tsx`
- `hooks/use-login.ts` / `use-logout.ts` / `use-registration.ts` — action hooks
- `utils/token-refresh.ts` — intercepts 401s, auto-refreshes, retries original request
- `bff-server/api-client.ts` — Axios instance with BFF interceptors
- `config/keycloak.ts` — Keycloak endpoint configuration

### mc-service Architecture

mc-service follows **Clean Architecture** with strict 4-layer separation. Outer layers may import from inner layers; inner layers must never import from outer layers:

| Layer | Directory | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/` | Entities, value objects, domain errors, `Specification<T>` pattern |
| Application | `src/application/` | CQRS commands/queries via `medi-rs`, DTOs, repository trait interfaces (ports) |
| Adapters | `src/adapters/mongodb/` | MongoDB implementations of repository traits, BSON ↔ domain mapping (DAOs) |
| API | `src/api/` | Axum handlers, middleware (auth, logging, error), router assembly, `AppState` |

**CQRS via `medi-rs`**: State-changing operations are `Command` types dispatched through the mediator; reads are `Query` types. Handlers live in `application/commands/` and `application/queries/`.

**Repository pattern**: `application/ports/` defines trait interfaces (`CollectionRepository`, `MovieRepository`). `adapters/mongodb/` provides the implementations. Handlers depend only on the trait, never on the concrete adapter — enabling unit testing with `mockall`.

**Specification pattern**: `domain/specifications/spec.rs` defines a generic `Specification<T>` trait (`is_satisfied_by(&T) -> bool`) with `AndSpec`, `OrSpec`, `NotSpec` combinators. Domain validation uses composed specifications, not ad-hoc `if` chains.

### BFF → mc-service Pattern

The BFF proxies between the React Native client and mc-service. **The client never calls mc-service directly.**

1. Client calls a BFF route (e.g., `bff-api/collections/index+api.ts`)
2. BFF extracts the user's JWT from the HTTP-only session cookie
3. BFF calls mc-service via `src/bff-server/mc-service-client.ts`, injecting `Authorization: Bearer {jwt}`
4. mc-service validates the JWT locally via `axum-keycloak-auth` (JWKS cached on startup — no per-request Keycloak call)
5. mc-service enforces `mc-user` or `mc-admin` role from `resource_access.movie-collection-manager.roles` JWT claim
6. Response forwarded back to client unchanged

### Routing

File-based routing via Expo Router:
- `app/(auth)/` — unauthenticated routes (login, register, native-auth-callback)
- `app/(app)/` — protected routes: `home.tsx`, `collections/[collectionId]/index.tsx` (collection screen), `collections/[collectionId]/movies/[movieId].tsx` (movie detail)
- `app/bff-api/` — server-side API handlers (Node.js only, not client bundles)

**Directory-based collection routing**: `collections/[collectionId]/` is a directory (not a file route) so that `movies/[movieId].tsx` nested under it inherits the `collectionId` route param. Use `index.tsx` inside the directory for the collection screen. Never use `[collectionId].tsx` (file route) — it breaks `collectionId` availability in nested movie routes.

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

### mc-service Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `MC_DB_URL` | — | `mongodb://localhost:27017/mc_db` local; `mongodb://mc-db:27017/mc_db` Docker |
| `KEYCLOAK_URL` | — | `http://localhost:8099` local; `http://keycloak-service:8080` Docker |
| `KEYCLOAK_REALM` | `jumbleknot` | — |
| `KEYCLOAK_CLIENT_ID` | `movie-collection-manager` | — |
| `MC_SERVICE_PORT` | `3001` | — |
| `RUST_LOG` | `info` | `mc_service=debug,axum=info` for targeted filtering |

Local dev: `backend/mc-service/.env.local` (gitignored). Docker values set in `infrastructure-as-code/docker/mc-service/compose.yaml`.

**mc-service fails to start if `MC_DB_URL` is unreachable or if Keycloak JWKS endpoint cannot be fetched** (JWKS is cached on startup for JWT validation).

## Logging

All BFF server-side code (`bff-server/`, `bff-api/`) must use the structured logger at `@/bff-server/logger`. Never use `console.*` directly in these files.

```typescript
import { logger } from '@/bff-server/logger';

logger.error('description', { action: 'action_name', error: err });
logger.audit('login', { userId, ip, roles });   // security-relevant events
```

The logger outputs newline-delimited JSON and automatically redacts sensitive fields: `token`, `sessionId`, `password`, `secret`, `cookie`, `authorization`, `code`, `codeVerifier`, `email`, `username`.

**Severity in production**: `debug` must be suppressed when `NODE_ENV=production`. `warn` and `error` write to stderr; all others write to stdout. (Pending: T-162.)

**Correlation IDs**: Every log entry must include a `requestId` — a UUID generated at the BFF entry point for each incoming request and propagated through all logger calls and outgoing Keycloak HTTP headers via `AsyncLocalStorage`. Use `withRequestContext(handler)` to wrap API route handlers. (Pending: T-162.)

**Audit events** (`logger.audit`) are required for: login success/failure, logout, registration, access denied (403), auth failure (401), and rate-limit hits (429). Include `userId` (Keycloak UUID — never email or username) and `ip` where available.

**Never log**: raw tokens, session IDs, passwords, email addresses, usernames, or partial auth codes.

**Log retention**: 30 days general, 90 days audit. Docker log rotation is configured in `infrastructure-as-code/docker/bff/compose.yaml` (10 MB × 10 files per service); time-based retention requires a log shipper (Loki, CloudWatch, etc.).

Client-side code (`hooks/`, `components/`, `screens/`) may use `console.error` for unexpected errors only. Never log sensitive data client-side.

### mc-service Logging

mc-service uses the `tracing` crate with a JSON subscriber configured in `src/main.rs`.

```rust
// Instrument handlers — skip large extractors:
#[tracing::instrument(skip(state))]
async fn create_collection(State(state): State<AppState>, ...) { ... }

// Use tracing macros, never println!:
tracing::info!(collection_id = %id, user_id = %uid, "Collection created");
tracing::error!(error = %e, "Repository error");
tracing::warn!(user_id = %uid, "Ownership check failed — 403");
```

**Correlation IDs**: The logging middleware (`src/api/middleware/logging.rs`) generates a UUID per request and attaches it as a `request_id` tracing span field. All child spans inherit it automatically.

**RUST_LOG filtering**: `RUST_LOG=mc_service=debug,axum=info,mongodb=warn` targets mc-service logs without flooding from dependencies.

**Never log**: JWT payloads, raw tokens, passwords, or email addresses. Log the Keycloak user ID (UUID) for ownership/audit events, never username or email.

## Non-Obvious Design Decisions

- **HTTP-only cookies**: tokens are never accessible to client-side JS — all token operations go through BFF endpoints
- **Service account vs admin credentials**: Keycloak Admin API calls use a dedicated service account (client credentials grant), not the admin password
- **Session ID vs JWT**: Redis session tracks timeout and concurrent session limits independently of the JWT lifetime
- **Expo `"output": "server"`**: `app.json` sets Metro web output to `server`, enabling the Node.js/Express integration — not a static export
- **Docker internal DNS**: BFF contacts Keycloak via `keycloak-service:8080` inside Docker networks, not `localhost`
- **Concurrent session eviction**: when a user exceeds `MAX_CONCURRENT_SESSIONS`, `session-manager.ts` evicts the oldest session automatically
- **Playwright testID**: React Native Web renders `testID` as `data-testid`, which is the locator attribute set in `playwright.config.ts`
- **mc-service auth is layer-not-handler**: `KeycloakAuthLayer<Role>` is applied as a tower layer on the `protected` sub-router — a new `/api/v1/` route handler is automatically protected without any auth code in its body. Per-handler `KeycloakToken<Role>` extractors are permitted only to *read claims* after the layer has already enforced auth; they must never serve as the primary guard. This satisfies the constitution's Centralized Access Control requirement.
- **mc-service JWKS caching**: `axum-keycloak-auth` fetches Keycloak's JWKS once on startup and caches the public key. JWT validation is entirely local — no per-request Keycloak call. mc-service will fail to start if Keycloak is unreachable.
- **Cursor-based pagination**: Movie list uses keyset pagination (`{ _id: { $gt: lastSeenId } }`), not offset/skip. The `cursor` query param is a base64-encoded MongoDB ObjectId. Batch size: 50. Never use `skip()` for paginating movies — it degrades to O(N) at scale.
- **RFC 9457 Problem Details**: mc-service error responses are `application/problem+json`. The catch-all error handler in `src/api/middleware/error_handler.rs` maps domain errors to Problem Details — never exposes stack traces in responses.
- **MongoDB collation uniqueness**: Collection name uniqueness (per owner) and movie uniqueness (per collection) are enforced at the index level with `{ locale: "en", strength: 2 }` collation — case-insensitive without a derived lowercase field. MongoDB E11000 errors are translated to `DuplicateCollectionName` / `DuplicateMovie` domain errors in the adapter layer.
- **ownerId denormalization**: `movie_collections` stores both `ownerId` (fast ownership filter) and `acl: [{ userId, role }]` (future sharing). The ACL is seeded with `{ userId: ownerId, role: "owner" }` on creation; no sharing logic is implemented this feature.

## Testing Requirements

- **No Runtime Patches**: A test must fail if the feature is broken; do not allow Claude to "fix" the app inside the test script.
- **Stable Selectors**: Use data-testid or ARIA roles rather than fragile CSS classes to ensure tests remain robust.
- **Independent State**: Ensure each test resets the environment to avoid sharing state between runs.
- **Consistent E2E Tests Across Clients**: E2E test cases should be repeated for web (Playwright CLI) and mobile (Maestro CLI) clients for the same frontend app.

### Rust (mc-service)

**Unit tests** live in an inline `#[cfg(test)]` module at the **bottom of the same source file** being tested — not in a separate file:

```rust
// src/domain/collection.rs
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn name_max_50_chars_enforced() { ... }
}
```

**Integration tests** live in `backend/mc-service/tests/integration/` (sibling to `src/`). Each file is a separate test binary compiled against the crate. Require MongoDB running.

```bash
pnpm nx test mc-service                          # unit tests (inline #[cfg(test)] blocks)
pnpm nx test:integration mc-service              # integration tests (requires mc-service compose up)
pnpm nx test mc-service -- --test collection_create  # single test by name
```

**Coverage** (≥70% line coverage required — SC-011):

```bash
cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests --out Lcov
```

`cargo-tarpaulin` is a dev dependency in `backend/mc-service/Cargo.toml`.

### Android (Emulator)

Use Maestro CLI for all Android UI testing.

#### Why `adb reverse` is required (not optional)

QEMU networking (10.0.2.2) is broken on this Windows 11/HyperV machine — the emulator cannot reach the host via the standard Android gateway. `adb reverse tcp:8081 tcp:8081` tunnels Metro through the ADB connection so `localhost:8081` inside the emulator routes to Metro on the host. This must be re-run after every emulator (re)start.

#### Session startup ritual (mandatory order)

```powershell
# 1. Start emulator — -no-snapshot-load is critical; without it ADB sometimes
#    can't connect after a Windows reboot.
& "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -avd Pixel_7-35 -no-snapshot-load
# Wait for the emulator to fully boot (home screen visible before continuing).

# 2. Establish ADB reverse tunnel (must repeat after every emulator start)
adb reverse tcp:8081 tcp:8081

# 3. Start Metro from frontend/mcm-app — NOT from repo root.
#    Starting from the repo root produces doubled-path errors:
#    e:\E:\Programming\VSCode\... — always cd first.
cd frontend/mcm-app
pnpm exec expo start --port 8081
# Add --reset-cache when the bundle is stale or after code changes.

# 4. Launch the app (triggers first Metro bundle compilation ~1-2 min)
adb shell am start -n com.jumbleknot.mcmapp/.MainActivity
```

#### After `pm clear` / `clearState: true` in Maestro

`clearState: true` wipes the app's SharedPreferences, including the `debug_http_host` entry that tells React Native where Metro is. The app will fall back to QEMU 10.0.2.2 (unreachable) and show "open debugger to view warnings". Fix:

```powershell
adb shell am force-stop com.jumbleknot.mcmapp
adb shell am start -n com.jumbleknot.mcmapp/.MainActivity
```

On the next launch RN resolves `localhost:8081` correctly through the `adb reverse` tunnel — no Metro restart needed. The APK itself is unaffected; only SharedPreferences is cleared.

#### Metro cache reset (if Metro was started from wrong directory)

```powershell
Get-Process -Name "node" | Stop-Process -Force
cd frontend/mcm-app
pnpm exec expo start --reset-cache --port 8081
```

Do **not** use `CI=1` with Expo CLI — `getenv.boolish()` requires `true`/`false`, not `1`/`0`.

#### Running Maestro flows

- Flows live in `tests/e2e/mobile/` as `.yaml` files
- Run a single flow: `maestro test tests/e2e/mobile/flow_name.yaml --env E2E_TEST_USER=testuser --env E2E_TEST_PASSWORD="TestPass1!ok"`
- Run all flows: `maestro test tests/e2e/mobile/ --env ...` (omits `_`-prefixed helper files automatically)
- Take a screenshot: `maestro screenshot`
- View device interactively: `maestro studio`
- Credentials for login flows: `frontend/mcm-app/.env.e2e.local` (gitignored)

Files prefixed with `_` (e.g., `_login-helper.yaml`) are reusable sub-flows; Maestro includes them when iterating the directory. They are not standalone tests and will fail if run directly.

### Web

Use Playwright CLI for all web UI testing. (requires Expo running on :8081)

- Tests live in `tests/e2e/web/` as `.spec.ts` files  
- Run tests: `pnpm exec playwright test`
- Run headed: `pnpm exec playwright test --headed`
- Debug mode: `pnpm exec playwright test --debug`
- Start Expo web first: `CI=1 pnpm exec expo start --web`


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

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at `specs/002-manage-movie-collection/plan.md`
<!-- SPECKIT END -->
