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

> **npm/yarn are hard-blocked (feature 006).** The root `package.json` has `"preinstall": "npx --yes only-allow pnpm"`. On a fresh clone, `npm install` / `yarn install` abort before writing anything with a clear "Use pnpm install" message; `pnpm install` passes. (In a tree that already has pnpm's symlinked `node_modules`, npm instead crashes earlier in its own arborist — also blocked, just less cleanly.) Always use `pnpm install`.

**Shell:** the default shell on this machine is PowerShell. Docs and quickstarts often show bash (`curl`, `jq`, `source`, `\` line-continuation) — translate to PowerShell: `Invoke-RestMethod` with a hashtable `-Body` (URL-encodes + parses JSON, no `curl`/`jq`); load `.env` via a `Get-Content` loop (no `source`); use a backtick (`` ` ``) for line continuation (`\` is not a continuation — it makes flags like `-d` parse as a new command). A POSIX Bash shell is also available for shell scripts.

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

All dev/test infrastructure is managed from the repo-root **`compose.yaml`** using Docker Compose profiles and `include:` to incorporate individual service compose files.

**First-time setup** (run once per machine before the first `docker compose up`):

```bash
docker network create backend-network
docker network create keycloak-network
docker volume create mc-service_mc-db-data
docker volume create localdev-auth_keycloak-db-data
docker volume create mcm-redis-data
```

Copy `infrastructure-as-code/docker/keycloak/.env.local.example` → `.env.local` and fill in the KC_DB_PASSWORD and client secret values.

**Profiles:**

| Profile flag | Services |
| --- | --- |
| *(none — default)* | `mc-db` (MongoDB replica set) + `mcm-redis` |
| `--profile app` | + `mc-service` |
| `--profile keycloak` | + `keycloak-db` + `keycloak-service` + `keycloak-mailpit` |
| `--profile app --profile keycloak` | full stack |

Direct compose commands (from repo root):

```bash
docker compose up -d                                          # test infra (MongoDB + Redis)
docker compose --profile app up -d                           # + mc-service (without Keycloak — mc-service will fail OIDC discovery)
docker compose --profile keycloak up -d                      # + Keycloak stack
docker compose --profile app --profile keycloak up -d        # full stack (correct order — mc-service waits for Keycloak healthy)
docker compose --profile app --profile keycloak down         # stop (keep volumes)
docker compose --profile app --profile keycloak down --volumes  # stop + wipe transient volumes only (persistent data is in external volumes)
docker compose ps                                            # status
```

> **Note:** `--profile` flags must come BEFORE `up`/`down` with Docker Compose v2. `docker compose up -d --profile app` is not supported.
>
> **Note:** mc-service `depends_on: keycloak-service: condition: service_healthy` ensures mc-service never starts before Keycloak is ready to serve JWKS. Running `--profile app` alone (without `--profile keycloak`) will hang waiting for Keycloak.

Or via Nx (from repo root):

```bash
pnpm nx up-test infrastructure-as-code      # MongoDB + Redis
pnpm nx up-app infrastructure-as-code       # + mc-service
pnpm nx up-keycloak infrastructure-as-code  # + Keycloak stack
pnpm nx up-all infrastructure-as-code       # full stack
pnpm nx down infrastructure-as-code         # stop (keep volumes)
pnpm nx down-all infrastructure-as-code     # stop + wipe transient volumes
pnpm nx ps infrastructure-as-code           # status
```

**Endpoints when running:**

| Service | URL |
| --- | --- |
| MongoDB | `mongodb://localhost:27017` |
| Redis | `redis://localhost:6379` |
| mc-service | `http://localhost:3001` |
| Keycloak Admin UI | `http://localhost:8099` (admin / change_me) |
| Mailpit | `http://localhost:8025` |

**Volume architecture**: The root `compose.yaml` uses `include:` to incorporate individual service compose files. Persistent data volumes are declared `external: true` with explicit names in each service's compose file so they keep their names after `include:` merges them (Docker Compose would otherwise prefix them with `mcm_`):

| Volume name | Declared in | Owned by |
| --- | --- | --- |
| `mc-service_mc-db-data` | `infrastructure-as-code/docker/mc-service/compose.yaml` | mc-service compose |
| `localdev-auth_keycloak-db-data` | `infrastructure-as-code/docker/keycloak/compose.yaml` | keycloak compose |
| `mcm-redis-data` | `infrastructure-as-code/docker/bff/compose.yaml` | bff compose |

The transient volume `keycloak-mailpit-data` (stores emails) gets the `mcm_` prefix (`mcm_keycloak-mailpit-data`) — that is acceptable since emails are ephemeral.

`docker compose down --volumes` only wipes transient volumes (`mcm_keycloak-mailpit-data`); all three persistent external volumes are untouched. To wipe persistent data, remove the external volumes manually after `docker compose down`.

**Without Redis, the BFF /login endpoint returns 500 "Authentication failed"** because the rate-limiter's first Redis call fails before returning a typed error.

**Integration tests require a replica-set-enabled MongoDB** — `MongoCollectionRepository::delete()` uses a multi-document transaction. Standalone MongoDB does not support transactions. The root `compose.yaml` starts `mc-db` with `--replSet rs0` and runs `rs-init` automatically. For CI environments not using compose, start MongoDB manually:

```bash
# Start (or replace an existing standalone container)
docker run -d --name mc-db-test -p 27017:27017 \
  mongodb/mongodb-community-server:8.0.8-ubi9 mongod --replSet rs0 --bind_ip_all
# Initiate the replica set (once after first start)
docker exec mc-db-test mongosh --quiet \
  --eval "try { rs.status() } catch(e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:27017'}]}) }"
```

**MongoDB replica set hostname — always use `docker compose up -d`**: The `rs-init` service initialises the replica set with `host: 'localhost:27017'`. This hostname works from the host (via Docker port binding) and from mc-service in Docker (which uses `directConnection=true` to bypass rs-member discovery). Never start `mc-db` with a bare `docker run` command — doing so can result in the rs being initialised with `mc-db:27017` (Docker-internal only), causing host-side integration tests to fail with "No such host is known".

**Fixing a bad replica set hostname** (if `cargo test` fails with "No such host is known" or "mc-db:27017" in the error):

```bash
docker exec mc-db mongosh --quiet --eval "rs.reconfig({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] }, { force: true })"
```

**mc-service requires Keycloak running** — it fetches the JWKS endpoint on startup to cache the public key for JWT validation. Start `--profile keycloak` before `--profile app`.

Typical dev loop: `pnpm nx up-keycloak infrastructure-as-code` → `pnpm start` in `frontend/mcm-app` → test in browser. For mc-service development, also run `pnpm nx up-app infrastructure-as-code`.

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
| `role-check.ts` | RBAC helpers: `requireMcUser`, `requireMcAdmin`, `requireRole`, `hasRole`, `isAdmin` |
| `mc-api-error.ts` | Shared error handler for all collection/movie BFF proxy routes: maps `AuthError`, Axios errors, and unknown errors to typed RFC 9457-compatible responses with audit logging |

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
2. BFF validates the JWT via `requireAuth(headers)` and checks RBAC via `requireMcUser(user)` (throws 401/403 before any upstream call)
3. BFF calls mc-service via `src/bff-server/mc-service-client.ts`, injecting `Authorization: Bearer {jwt}`
4. mc-service validates the JWT locally via `axum-keycloak-auth` (JWKS cached on startup — no per-request Keycloak call)
5. mc-service enforces `mc-user` or `mc-admin` role via `require_app_role` Tower middleware (applied via `from_fn` on the protected sub-router)
6. Response forwarded back to client unchanged; errors handled by `handleMcApiError`

**Pattern for all BFF collection/movie route handlers:**

```typescript
const { user } = await requireAuth(headers);
requireMcUser(user);             // 403 if user lacks mc-user or mc-admin role
const jwt = extractRawToken(headers)!;
const client = createMcServiceClient(jwt);
// ... proxy call ...
} catch (err) {
  return handleMcApiError(err, 'action_name');  // shared error handler
}
```

### Routing

File-based routing via Expo Router:
- `app/(auth)/` — unauthenticated routes (login, register, native-auth-callback)
- `app/(app)/` — protected routes: `home.tsx`, `collections/[collectionId]/index.tsx` (collection screen), `collections/[collectionId]/movies/[movieId].tsx` (movie detail)
- `app/bff-api/` — server-side API handlers (Node.js only, not client bundles)

**Directory-based collection routing**: `collections/[collectionId]/` is a directory (not a file route) so that `movies/[movieId].tsx` nested under it inherits the `collectionId` route param. Use `index.tsx` inside the directory for the collection screen. Never use `[collectionId].tsx` (file route) — it breaks `collectionId` availability in nested movie routes.

Protected routes use `<ProtectedRoute>` or `useAuthGuard()` which check RBAC before rendering.

### Access Control

Two layers:

1. **RBAC**: user must hold `mc-user` OR `mc-admin` role in Keycloak — enforced at two points:
   - **BFF**: `requireMcUser(user)` in every collection/movie route handler, after `requireAuth()` but before any upstream call
   - **mc-service**: `require_app_role` Tower middleware via `from_fn` on the protected sub-router, inside `auth_layer`

2. **DAC**: collection-level ACLs (owner/contributor/viewer) — planned in mc-service/MongoDB

### Key Types (`src/types/`)

- `auth.ts` — `ClientRole`, `KeycloakUser`, `JWTPayload`, `UserProfile`, `Session`, API request/response contracts
- `errors.ts` — `AuthError` hierarchy with typed codes (`INVALID_INPUT`, `TOKEN_EXPIRED`, `FORBIDDEN`, …)

## Configuration

> **`.env` files — no inline comments on value lines.** dotenv-style loaders (and the Expo CLI) treat everything after `=` as the value, so `KEY=val # note` yields the literal `val # note` (this surfaced as Keycloak `invalid_client` when a secret captured its trailing comment). Put comments on their own lines.

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
| `MC_DB_URL` | — | `mongodb://localhost:27017/mc_db` local (replica set required — see startup note above); `mongodb://mc-db:27017/mc_db?replicaSet=rs0&directConnection=true` Docker |
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

- **Password manager suppression — `NoAutoFillInput`**: Use `NoAutoFillInput` from `@/components/no-autofill-input` instead of plain `TextInput` for ALL form fields except the user registration page (`register-form.tsx`). On web (React Native Web) it injects `autocomplete="off"`, `data-form-type="other"` (Dashlane), `data-lpignore="true"` (LastPass), `data-1p-ignore=""` (1Password), and `data-bwignore="true"` (Bitwarden) to suppress password manager autofill. On native mobile it is a transparent pass-through (OS-level autofill is intentionally not blocked). The registration page is excluded because users legitimately want password managers there.

- **External ID URLs — `openUrl` helper in `movie-detail.tsx`**: When an `ExternalId` has a URL, it is rendered as a tappable link. On web it calls `window.open(url, '_blank', 'noopener,noreferrer')` to open in a new tab; on native it calls `Linking.openURL(url)` which opens the system browser.

- **MongoDB text index `language_override`**: The `movie_text_search` index in `indexes.rs` sets `language_override: "textSearchLang"` (a non-existent field) and `default_language: "none"`. This prevents MongoDB from treating the `language` field in movie documents (e.g., "Japanese", "Korean") as a text-search language override — MongoDB only recognizes a small set of languages (no CJK) and would reject inserts with unsupported values (WriteError code 17262) if the default `language` override field were used.

- **HTTP-only cookies**: tokens are never accessible to client-side JS — all token operations go through BFF endpoints
- **Service account vs admin credentials**: Keycloak Admin API calls use a dedicated service account (client credentials grant), not the admin password
- **Session ID vs JWT**: Redis session tracks timeout and concurrent session limits independently of the JWT lifetime
- **Expo `"output": "server"`**: `app.json` sets Metro web output to `server`, enabling the Node.js/Express integration — not a static export
- **Docker internal DNS**: BFF contacts Keycloak via `keycloak-service:8080` inside Docker networks, not `localhost`
- **Concurrent session eviction**: when a user exceeds `MAX_CONCURRENT_SESSIONS`, `session-manager.ts` evicts the oldest session automatically
- **Playwright testID**: React Native Web renders `testID` as `data-testid`, which is the locator attribute set in `playwright.config.ts`
- **mc-service auth is layer-not-handler**: `KeycloakAuthLayer<Role>` is applied as a tower layer on the `protected` sub-router — a new `/api/v1/` route handler is automatically protected without any auth code in its body. Per-handler `KeycloakToken<Role>` extractors are permitted only to *read claims* (e.g., `token.subject`) after the layer has already enforced auth; they must never serve as the primary guard. This satisfies the constitution's Centralized Access Control requirement.
- **`axum-keycloak-auth` does NOT enforce application roles by itself**: `KeycloakAuthLayer` with no `required_roles` (or `required_roles: []`) only validates the JWT signature and audience — it does NOT check application-specific roles. The `required_roles` option enforces AND-logic (all roles must be present), making it unsuitable for OR-logic (mc-user OR mc-admin). A separate `require_app_role` Tower middleware via `axum::middleware::from_fn` is applied inside `auth_layer` on the protected sub-router to enforce the OR-logic role check. Layer ordering: `auth_layer` (outermost, runs first) → `from_fn(require_app_role)` (inner, runs after JWT is validated and `Extension<KeycloakToken<Role>>` is populated).
- **Cascade delete is atomic via a MongoDB transaction**: In `collection_repository.rs`, `delete()` opens a `ClientSession` and runs both `delete_one` (the collection) and `delete_many` (its movies) inside a single transaction. Ownership is verified first — if `delete_one` with `{ _id, ownerId }` matches zero documents the transaction is aborted before any movies are touched. If the process crashes between the two writes MongoDB rolls back automatically, preventing orphaned movie records. The repository holds a `client: mongodb::Client` field (extracted from `db.client().clone()` in `new()`) to start sessions without changing the call-site signature. Requires a replica-set-enabled MongoDB (single-member replica set is sufficient).
- **mc-service JWKS caching**: `axum-keycloak-auth` fetches Keycloak's JWKS once on startup and caches the public key. JWT validation is entirely local — no per-request Keycloak call. mc-service will fail to start if Keycloak is unreachable.
- **Cursor-based pagination**: Movie list uses keyset pagination (`{ _id: { $gt: lastSeenId } }`), not offset/skip. The `cursor` query param is a base64-encoded MongoDB ObjectId. Batch size: 50. Never use `skip()` for paginating movies — it degrades to O(N) at scale.
- **RFC 9457 Problem Details**: mc-service error responses are `application/problem+json`. The catch-all error handler in `src/api/middleware/error_handler.rs` maps domain errors to Problem Details — never exposes stack traces in responses.
- **MongoDB collation uniqueness**: Collection name uniqueness (per owner) and movie uniqueness (per collection) are enforced at the index level with `{ locale: "en", strength: 2 }` collation — case-insensitive without a derived lowercase field. MongoDB E11000 errors are translated to `DuplicateCollectionName` / `DuplicateMovie` domain errors in the adapter layer.
- **ownerId denormalization**: `movie_collections` stores both `ownerId` (fast ownership filter) and `acl: [{ userId, role }]` (future sharing). The ACL is seeded with `{ userId: ownerId, role: "owner" }` on creation; no sharing logic is implemented this feature.
- **mc-service Docker build requires vendored OpenSSL**: `rust:alpine3.21` targets `x86_64-unknown-linux-musl` which links binaries with `-static-pie` and `-Wl,-Bstatic` — all native C libraries must be statically linked. Alpine's `openssl-dev` only ships `.so` dynamic libraries (not `.a` static archives), so both `OPENSSL_STATIC=1` and the default dynamic approach fail with `cannot find -lssl`. The fix is a **musl-conditional** dependency in `mc-service/Cargo.toml`: `[target.'cfg(target_env = "musl")'.dependencies]` with `openssl = { version = "0.10", features = ["vendored"] }`. This activates only when building for musl (Docker/Alpine) and pulls in `openssl-src` which compiles OpenSSL from C source, producing static `.a` libs. The Dockerfile build stage requires `perl make` (not `openssl-dev pkgconfig`) for the C compilation. Windows dev builds do NOT include `vendored` and use the system/native-tls TLS stack — no `perl` needed locally. Do NOT add `openssl` with `features = ["vendored"]` to the unconditional `[dependencies]` section — it will break `cargo test` on Windows where `perl` is absent. Note: `OPENSSL_VENDORED=1` env var alone does NOT work; the Cargo feature must be explicitly set.

## Testing Requirements

- **No Runtime Patches**: A test must fail if the feature is broken; do not allow Claude to "fix" the app inside the test script.
- **Stable Selectors**: Use data-testid or ARIA roles rather than fragile CSS classes to ensure tests remain robust.
- **Independent State**: Ensure each test resets the environment to avoid sharing state between runs.
- **Consistent E2E Tests Across Clients**: E2E test cases should be repeated for web (Playwright CLI) and mobile (Maestro CLI) clients for the same frontend app.

### Prerequisites (mandatory before starting any AI-assisted session)

- **RTK (Rust Token Killer)** must be installed and active. It compresses test-command output reaching the agent context, preserving the context window for reasoning.

  ```bash
  rtk init --global   # activate in this shell
  rtk gain            # verify >80% compression after the first test run
  ```

  Pin a specific version (current: `rtk 0.40.0`); installed via cargo (`~/.cargo/bin/rtk`). A session must not begin without RTK active.

### Test Run Protocol

Nx targets are the primary invocation path — even single tests run Nx-first via `--` argument passthrough. The only direct (non-Nx) calls permitted are `maestro test <flow>` (the `e2e:mobile` target has no single-flow passthrough) and `pnpm exec tsc --noEmit` (no Nx target). Step 3 (full suite) MUST use Nx targets.

Execute in this order after every code change:

1. **Isolated test** (fastest first — unit runs in ms, E2E in minutes):

   ```bash
   pnpm nx test mcm-app -- --testNamePattern "test name"           # unit
   pnpm nx e2e mcm-app -- tests/e2e/web/<file>.spec.ts --grep "test name"  # web E2E (single, Nx passthrough)
   maestro test tests/e2e/mobile/flow.yaml --env ...               # mobile E2E (single; no Nx passthrough)
   ```

2. **User-story suite** (after the isolated test passes):

   ```bash
   # run the spec file(s) for the touched user story (see Feature Branch Test Scope below)
   pnpm nx e2e mcm-app -- tests/e2e/web/<story>.spec.ts
   ```

3. **Full suite** (final validation only — not after every change):

   ```bash
   pnpm nx e2e mcm-app && pnpm nx e2e:mobile mcm-app && pnpm nx test mcm-app
   ```

### Final local E2E runs against the BFF container (feature 007)

**Testing procedure (3 phases):**

1. **Iterative development is Metro-only.** All coding plus unit / integration / iterative E2E run against Metro (`pnpm nx e2e mcm-app`, `pnpm nx test`, `pnpm nx test:integration`, type-check). Metro is the fast inner loop and the **default state** of the repo.
2. **Final E2E validation runs against the containerized BFF — the dev container (non-Secure HTTP, `:8082`)** — only *after* the Metro suites are green. This exercises the real `@expo/server` production server (not Metro's dev server) and proves the request path is the container, not Metro, via the `X-BFF-Source` header (asserted in `global-setup.ts`, fail-fast on a Metro false-green).
3. **After all green, reset the environment to Metro-only** (tear down the container + revert `.env.local` — see "Switch back to Metro" below).

**The prod container (HTTPS, Secure cookies) is reserved for a future CI/CD pipeline — it is NOT a routine local step.** There is no CI E2E job today; feature 007 proved the prod-HTTPS path works locally (US3, kept for reference in the quickstart), but going forward that hardened run belongs in CI/CD, not the local loop. Full runbook for all modes: [specs/007-e2e-bff-container/quickstart.md](specs/007-e2e-bff-container/quickstart.md).

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

**Prod container (HTTPS, Secure cookies) — future CI/CD, NOT a routine local run.** Same pattern with `E2E_BFF_TARGET=prod-container` (`bff-prod` profile, Caddy TLS on `https://localhost:8443`); kept in [quickstart §2](specs/007-e2e-bff-container/quickstart.md) for reference. Defer this hardened run to the CI/CD pipeline — locally, stop at the dev-container final E2E above and reset to Metro.

### Feature Branch Test Scope

Run only the suites for areas touched on the current branch during iteration; defer the rest to final validation.

| User Story | Web Test File | Mobile Flow |
|---|---|---|
| 001-US1: Registration | auth.spec.ts | registration-navigation.yaml, registration-full.yaml, registration-validation.yaml |
| 001-US2: Login | auth.spec.ts | login-keycloak.yaml, login-screen.yaml, login-invalid.yaml, login-verified-banner.yaml |
| 001-US3: Profile / access control | auth.spec.ts | auth-guard.yaml, home-screen.yaml |
| 001-US4: Logout | auth.spec.ts | logout.yaml |
| 001: Session timeout | session-timeout.spec.ts | session-timeout.yaml, session-timeout-absolute.yaml |
| 002-US1: Browse collections | collections.spec.ts | collection-browse.yaml |
| 002: Manage collections | collections.spec.ts | collection-create.yaml, collection-edit.yaml, collection-delete.yaml |
| 002-US2: Manage movies | movies.spec.ts | movie-add.yaml, movie-edit.yaml, movie-delete.yaml |
| 002: Search / filter movies | movies.spec.ts | movie-browse.yaml, movie-search-filter.yaml |
| 002-US3: Default collection | movies.spec.ts | N/A (web routing behavior) |
| 002-US4: Column visibility | movies.spec.ts | N/A (native layout, no column toggle) |

### Final Validation Checklist

Run all of the following before marking any feature complete:

- [ ] `docs/templates/feature-test-tasks-template.md` format followed for all test tasks
- [ ] Platform parity table updated for this feature
- [ ] `pnpm nx test mc-service` — Rust unit tests pass
- [ ] `pnpm nx test:integration mc-service` — Rust integration tests pass
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx e2e mcm-app` — web E2E passes (single login via global setup)
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)

### Feature Test Task Template

All test tasks for new features must follow the format in [docs/templates/feature-test-tasks-template.md](docs/templates/feature-test-tasks-template.md), which provides:

- TDD checkpoint format (Scenarios, Verify RED, Verify GREEN)
- Documentation/config task format (no RED/GREEN)
- Platform Parity Table format with column definitions
- A full worked example using the real fixture + filter-chip pattern
- Rules: derive exact counts from `FIXTURE_MOVIES`; writes → MUTATION fixture, reads → BROWSE; teardown via BFF `afterEach`; mobile flows need a logged-out start

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

#### Rebuilding the Android APK after a native change (RN/SDK upgrade, new native module)

**Supported build paths (feature 006):**

- **CI (recommended — use this for APKs):** the `android-apk` GitHub Actions workflow (`.github/workflows/android-apk.yml`) builds the APK on an `ubuntu-latest` runner (~20 min) and publishes it as the `app-debug-apk` artifact (universal/all-ABI debug APK, ~75 MB). A Linux runner has no Windows `CMAKE_OBJECT_PATH_MAX` wall, so it needs none of the workarounds below. **When:** after any native-layer change (Expo SDK/RN bump, new native module, `expo prebuild`) when you need an installable APK — and as the default over the local Windows build. **CI builds the APK only — it runs no test suites.**
  - **Trigger:** `gh workflow run android-apk.yml --ref <branch>` (or `workflow_dispatch` in the Actions UI), or it auto-runs on pushes touching `frontend/mcm-app/android/**`, `app.json`, `package.json`, `frontend/mcm-app/scripts/build-apk.mjs`, or the workflow file.
  - **Watch / download:** `gh run watch <run-id> --exit-status`; then `gh run download <run-id> -n app-debug-apk` → `app-debug.apk`. Install with `adb install -r app-debug.apk`.
  - **Disk-free step is REQUIRED, do not remove it:** the workflow frees ~10–15 GB of preinstalled toolchains before building. Without it the RN 0.85 C++ build (worklets/screens) + SDK/NDK + Gradle caches exhaust the runner disk and the build is **killed mid-compile** (no clean error, step stuck `in_progress`, job fails ~39 min in). This was hit and fixed during feature 006.
- **Local (Nx target):** `pnpm nx run mcm-app:build-apk` wraps `expo prebuild --platform android --clean` + `gradlew :app:assembleDebug` (cross-platform via `frontend/mcm-app/scripts/build-apk.mjs`; set `APK_ABI=x86_64` for an emulator-only build). On Windows this still hits the path wall below — use the wrapper next.
- **Local on Windows (path-wall wrapper — fragile fallback):** `scripts/build-apk-short-path.ps1` sets up the short-root + flat-`node_modules` recipe, invokes the Nx target, then **always reverts** (`-Install` also `adb install`s). This automates the manual recipe documented below. **Prefer CI** — this local path is slow and has hung mid-run; if you do run it, capture output to a file (not a buffered `Select-Object`) so a failure is visible, and verify `.npmrc`/node_modules are restored afterward (`git status .npmrc`; `pnpm install`).

Maestro launches the **installed APK** via `am start` — it does NOT rebuild. After anything that changes the native layer (an Expo SDK / React Native bump, adding a native module, `expo prebuild`), you MUST rebuild and reinstall the APK, or the old native binary runs against the new JS bundle and crashes at startup (e.g. SDK 55→56 produced a RedBox `ReferenceError: Property 'MessageQueue' doesn't exist` — old RN 0.83 bridge vs new RN 0.85 bridgeless JS). `expo prebuild --clean` + `gradlew clean` regenerate/clean native *source* but do not build or install — the build+install step is separate.

**Windows `CMAKE_OBJECT_PATH_MAX` (250) wall** — building RN ≥0.85 C++ modules (`react-native-worklets` via reanimated 4, `react-native-screens`) fails here with `ninja: error: manifest 'build.ninja' still dirty after 100 tries`. The real cause (visible higher in the log) is `CMake Warning … object file directory has NNN characters; maximum full path is 250`. CMake replicates the **full absolute source path** under the object dir, and this repo's path (`E:\Programming\VSCode\MovieCollectionManager`) + the deep pnpm layout (`node_modules/.pnpm/<pkg>@<ver>_<32-char-hash>/node_modules/<pkg>/Common/cpp/…`) overflows 250 (worst measured: 381 chars). Windows `LongPathsEnabled=1` does NOT help — the 250 cap is internal to CMake. Things that do NOT work: Metro `--reset-cache`, deleting `.cxx`, `-PreactNativeArchitectures=x86_64`, `pnpm virtual-store-dir-max-length` (only trimmed to ~293, and shortened store names break Metro/jest resolution).

**The build-only recipe that works** (short root + flat node_modules → object path 381 → ~187):

```powershell
# 1. Short build root via junction (no copy, no admin)
cmd /c 'mklink /J C:\m "E:\Programming\VSCode\MovieCollectionManager"'

# 2. Flat node_modules (no .pnpm/<hash>/node_modules doubling) — BUILD ONLY.
#    Add to root .npmrc, then install from the short root:
#      node-linker=hoisted
cd C:\m
pnpm install

# 3. Prebuild + build x86_64 (emulator ABI). With hoisted, invoke the root-hoisted
#    expo CLI explicitly (the per-project .bin/expo shim mis-resolves under hoisting):
cd C:\m\frontend\mcm-app
node C:\m\node_modules\expo\bin\cli prebuild --platform android --clean
cd android
./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64

# 4. Install on the running emulator
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 5. REVERT: remove `node-linker=hoisted` from .npmrc and reinstall from E:\ —
#    hoisted breaks Metro/jest module resolution (all unit suites fail to load).
cd E:\Programming\VSCode\MovieCollectionManager
pnpm install
```

After install, run Metro from `frontend/mcm-app` (default layout) and Maestro as usual. The `.npmrc` carries an abbreviated copy of this recipe.

> **`@expo/dom-webview` version pin (SDK 56):** a stale lockfile kept `@expo/dom-webview@55.0.6` even though `expo@56.0.8` declares `~56.0.5`. The SDK-55 native module crashes at launch under SDK-56 `expo-modules-core` with `java.lang.NoClassDefFoundError: expo/modules/kotlin/types/AnyTypeProvider` at `expo.modules.webview.DomWebViewModule`. Fix: a pnpm `overrides` entry `"@expo/dom-webview": "^56.0.5"` **plus deleting `pnpm-lock.yaml` and regenerating** (the override alone won't repropagate a poisoned transitive pin). This is harmless for web/JS (which is why web E2E stays green) but fatal for the native Android build.

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
- Run via Nx (preferred): `pnpm nx e2e:mobile mcm-app`
- Run a single flow: `maestro test tests/e2e/mobile/flow_name.yaml --env E2E_TEST_USER=testuser --env E2E_TEST_PASSWORD="TestPass1!ok"`
- Take a screenshot: `maestro screenshot`
- View device interactively: `maestro studio`
- Credentials for login flows: `frontend/mcm-app/.env.e2e.local` (gitignored)

Files prefixed with `_` (e.g., `_login-helper.yaml`) are reusable sub-flows. They are not standalone tests and will fail if run directly.

> **Bounded E2E retry (feature 006, FR-006).** Environmental flakiness on the loaded emulator/Metro is absorbed by **at most one** explicit, visible retry per test — never more (more would risk masking a real defect). Mobile: `scripts/maestro-e2e.mjs` re-prepares and re-runs a failed flow once, logging `⟳ RETRY 1/1`; a genuine regression fails both attempts and still fails the suite. Web: Playwright `retries: 1` in `playwright.config.ts`, plus `global-setup.ts` warms `/home`, the collection screen, and a movie-detail screen so the first test doesn't eat the Metro cold-compile. **Readiness ritual for a reproducible green run:** start Metro fresh from `frontend/mcm-app` (it degrades over long sessions); for web E2E stop the emulator first (GPU/SSO contention); for mobile E2E run the emulator startup ritual (`-no-snapshot-load`, `adb reverse tcp:8081 tcp:8081`, `-gpu swiftshader_indirect`).

**MANUAL_FLOWS** (`session-timeout.yaml`, `session-timeout-absolute.yaml`) are excluded from the normal `e2e:mobile` run because they require Metro to be started with a special env var (`EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS`). Use the dedicated target:

```powershell
# 1. Enable the override in .env.local (uncomment the line)
# 2. Restart Metro with the override active
cd frontend/mcm-app && pnpm exec expo start --port 8081
# 3. Run the isolated target (validates .env.local before executing)
pnpm nx e2e:mobile:session-timeout mcm-app
# 4. Re-comment the line in .env.local and restart Metro
```

The web session-timeout tests (`tests/e2e/web/session-timeout.spec.ts`) use Playwright's fake clock (`page.clock.fastForward`) and do **not** need the env override — they run in the normal `pnpm nx e2e mcm-app` suite.

### BFF Integration Test Harness (mcm-app)

BFF integration tests (`frontend/mcm-app/tests/integration/*.integration.test.ts`) run against **real** Keycloak + Redis + mc-service (constitution v1.3.0 — no mocking) via a dedicated `frontend/mcm-app/jest.integration.config.js` (**not** the package.json `jest` block). Run: `pnpm nx test:integration mcm-app`. The unit target (`pnpm nx test mcm-app`) excludes `tests/integration/`. Key facts (so they aren't rediscovered):

- **Node env + serial:** `testEnvironment: 'node'`, `maxWorkers: 1` (tests share Redis db 1 and the live BFF — parallel `flushdb`/teardown would wipe another file's data mid-test), `forceExit: true` (cache-service leaves an `ioredis` handle open with no public close).
- **Module-resolution stubs:** `babel-preset-expo` (reused for the TS transform) injects `import { env } from 'expo/virtual/env'`, and BFF source transitively imports `react-native` (`Platform.OS` in `@/config/keycloak`). Both are stubbed via `moduleNameMapper` → `tests/integration/setup/{expo-env-stub,react-native-stub}.js` so Node can import server source; `@/` maps to `src/`. (The unit suite avoids this only because `jest-expo` transforms expo/RN.)
- **Env + Redis isolation:** `tests/integration/setup/env.ts` loads `.env.e2e.local` (ROPC creds) then `.env.local` (service-account secret), then **pins `REDIS_URL` to db 1**. The running BFF uses **db 0** — HTTP-level session tests (logout, refresh) seed/inspect db 0 via `helpers/bff-redis-client.ts`; in-process module tests use db 1 via `helpers/redis-test-client.ts`.
- **Real tokens:** `helpers/keycloak-test-client.ts` acquires tokens via the **test-only `mcm-bff-test` ROPC client** and manages users through the Admin API (raw `fetch`, no admin-client lib). Call **`ensureRopcAudienceMapper()` in `beforeAll`** for any test that hits `validateJwt` or mc-service — without the audience mapper, ROPC tokens (`azp=mcm-bff-test`) are rejected as "Invalid token audience". The ROPC grant must never be enabled on the production `movie-collection-manager` client.
- **Headless-untestable happy paths (justified E2E exclusions, enforced by the gate):** login PKCE code exchange, `/auth/refresh` token rotation (production-client refresh token is browser-PKCE-only), and `/auth/verify-email` (Keycloak email action-token). `tests/integration/route-coverage.integration.test.ts` + `route-coverage-map.ts` fail if any `+api.ts` route lacks a test or a justified exclusion — login is the only map-level exclusion.

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
at `specs/007-e2e-bff-container/plan.md`
<!-- SPECKIT END -->
