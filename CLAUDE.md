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
pnpm nx deploy mc-service            # start mc-service + mc-service-store-mongo containers
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

### AI Agent Layer (features 012 + 014)

Additive conversational assistant: a LangGraph supervisor graph (the **Agent Gateway**, served over AG-UI, reached only through the BFF) + three scoped MCP servers (`movie-mcp` → mc-service, `web-api-mcp` → TMDB, `spreadsheet-mcp` → file processing). Python 3.13 + `uv`, run via Nx (`@nxlv/python`). Intents: add/organize/context/navigate/query (012) + import/export (014); all mapping/dedup/resolution is **pure code**, only model decisions are the golden surface. Observability (`--profile observability`) and audit (`--profile audit`) are env-gated, no-op by default.

**Before ANY agent work, read [docs/agent-layer.md](docs/agent-layer.md) + `agents/movie-assistant/README.md` + `specs/012-multi-agent-mvp/HANDOFF.md`.** That runbook holds the commands, env-scoped model rules, containerized-E2E gotchas, observability/audit setup, the SC-004 OTel-span leak rule, and the testing gates. Key always-true rules: models are env-scoped (Ollama dev/test, Claude golden+prod); rebuild the gateway/MCP images after any agent-source change (stale image = old code); **agent E2E must navigate in-app, never deep-load before driving the dock**; mobile agent E2E runs in CI (see [docs/runbooks/android-emulator.md](docs/runbooks/android-emulator.md)).

## Local Dev Infrastructure

Stack is split (feature 020) into **four independently operable named Compose stacks** under `infrastructure-as-code/docker/stacks/` — `auth`, `mcm`, `audit`, `observability` — each its own Compose project (the single root `compose.yaml` aggregator is retired). **Full setup — first-time network/volume creation, the profile table, per-stack compose + Nx commands, endpoints, and volume architecture — is in [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md).** Typical dev loop: `pnpm nx up-auth infrastructure-as-code` → `pnpm start` in `frontend/mcm-app` → test in browser; add `pnpm nx up-mcm infrastructure-as-code` (`--profile app`) for mc-service. Bring up `auth` BEFORE the `mcm` app profile (no cross-project `depends_on` — manual ordering).

**Load-bearing gotchas (easy to violate):**

- **Without Redis, BFF `/login` returns 500** "Authentication failed" (the rate-limiter's first Redis call fails before a typed error).
- **Integration tests require a replica-set-enabled MongoDB** (`delete()` uses a multi-doc transaction) — **always bring the mcm stack up, never a bare `docker run`** (bare run can init the rs with `mc-service-store-mongo:27017`, Docker-internal only → host tests fail "No such host is known"). Fix a bad hostname: `docker exec mc-service-store-mongo mongosh --quiet --eval "rs.reconfig({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] }, { force: true })"` (feature 020 renamed the container+service-key `mc-db`/`mc-service-db`→`mc-service-store-mongo`).
- **mc-service requires Keycloak running** (fetches JWKS on startup) — bring up the `auth` stack (`pnpm nx up-auth`) before the `mcm` stack's `app` profile; `--profile app` alone hangs waiting for Keycloak. There is no cross-project `depends_on` anymore (feature 020) — the ordering is manual.
- `--profile` flags go BEFORE `up`/`down` (Docker Compose v2).

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

**No clear-text secrets in git — EVER (constitution §Secrets Management; features 021/022).** Enforced and non-negotiable:

- **Docker Compose credentials** are externalized to fail-fast interpolation: every secret in a tracked compose file is `${VAR:?set in stacks/<stack>.env}` — never an inline literal, never a `${VAR:-literal}` default (an inline default re-leaks the value). Real per-machine values are minted by `node scripts/gen-dev-secrets.mjs` from committed `infrastructure-as-code/docker/stacks/*.env.example` templates (placeholders only) into gitignored `*.env`, read via each stack's `include` `env_file:` + the Nx target's `--env-file`. Run the generator once before any `pnpm nx up-*`. Full model → [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md) + `infrastructure-as-code/docker/stacks/README.md`.
- **The rule is not compose-only.** Shell scripts, integration tests, and docs must ALSO never hardcode a credential (this is exactly how feature-022 literals slipped past the compose-only gate for months). They must read the value from env (sourced from the stack `.env`) and **skip/fail cleanly when unset** — no literal, no `:-literal` / `?? 'literal'` fallback. Pattern: `OPENSEARCH_INITIAL_ADMIN_PASSWORD` in `opensearch/init-audit-user.sh` + the audit/observability/vault integration tests.
- **Build-time Docker file-secrets** (e.g. the Keycloak DB password) use the `secrets/*.txt` + `_FILE` pattern (gitignored `secrets/`) — unchanged, also compliant.
- **CI gates** (`.forgejo/workflows/guardrails.yml`, the `naming` + `secret-scan` jobs): `scripts/check-no-inline-secrets.mjs` fails on any inline literal in a compose file; `scripts/secret-scan.mjs` scans the whole tracked tree for credential-shaped strings (real provider keys **and** the MCM dev-credential placeholder shapes). Run locally with `--selftest` then plain. If you must add a value that looks credential-shaped but isn't, allowlist it explicitly in the gate — do not weaken the pattern.

- **Env-var reference tables** (BFF server-side + mc-service, with defaults) → [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md#environment-variables).
- **`TRUSTED_PROXY`** (feature 009, finding #4): `false` by default — IP-scoped rate limiting is **skipped** (with a warning) unless the BFF runs behind a trusted reverse proxy that sets `X-Forwarded-For`. **Non-loopback deployments MUST set `TRUSTED_PROXY=true`** behind the proxy, which then trusts the **right-most** XFF hop (left entries are client-spoofable).
- **TypeScript path alias**: `@/*` → `src/*` (strict mode enabled).
- **mc-service fails to start if `MC_DB_URL` is unreachable or Keycloak JWKS can't be fetched** (JWKS is cached on startup for JWT validation).

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
- **SSRF host checks use the canonicalized IP, not the hostname string** (feature 018, `agent-config-ssrf.ts`): a user supplies their own Ollama base URL, fetched server-side at save/probe. `new URL()` (WHATWG) canonicalizes an IPv4-mapped IPv6 literal — `http://[::ffff:169.254.169.254]/` → hostname `::ffff:a9fe:a9fe` (hex) — so a regex like `/^::ffff:169\.254\./` over `URL.hostname` is dead code and the cloud-metadata IP slips the block. Always de-map IPv4-mapped IPv6 (both `::ffff:a.b.c.d` and the hex `::ffff:HHHH:HHHH`) to the embedded IPv4 before the link-local range check. Policy: allow private/loopback (bring-your-own-Ollama), block only link-local/metadata; the guard runs at the BFF save/probe only (the Python `ChatOllama` runtime fetch is unguarded and the check does not resolve DNS — DNS-rebinding is a documented residual; `AGENT_OLLAMA_ALLOWED_HOSTS` is the multi-user mitigation).
- **Service account vs admin credentials**: Keycloak Admin API calls use a dedicated service account (client credentials grant), not the admin password
- **Session ID vs JWT**: Redis session tracks timeout and concurrent session limits independently of the JWT lifetime
- **Expo `"output": "server"`**: `app.json` sets Metro web output to `server`, enabling the Node.js/Express integration — not a static export
- **Docker internal DNS**: BFF contacts Keycloak via `keycloak-service:8080` inside Docker networks, not `localhost` (feature 020 unified the container+service-key to `keycloak-service`; cross-stack resolution works over the shared external `backend-network`)
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

After the Metro suites are green, the final E2E validation runs against the **containerized dev BFF** (`mcm-bff-service-nonsecure`, non-Secure HTTP, `:8082`) — `pnpm nx docker-build mcm-app` then `docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile bff-nonsecure up -d` then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` — and the environment is then reset to Metro-only. The prod-HTTPS container is future CI/CD, not a routine local step.

**Full procedure (the 3 phases, the mode table, the Keycloak stable-issuer prerequisite, the switch-back-to-Metro reset, and the mobile dual-port deltas) is in [docs/runbooks/e2e-testing.md](docs/runbooks/e2e-testing.md).**

### CI/CD lives on the homelab forge (feature 023)

CI/CD is config-as-code under **`.forgejo/workflows/`** running on a self-hosted Forgejo Actions `act_runner` (homelab), **not** `.github/workflows/`. Three behavior-named workflows: `guardrails.yml` (resource-naming + inline-secret + whole-tree secret-scan + keyless agent gates — the MVP), `app-ci.yml` (nx-affected lint/build/unit + containerized web Playwright E2E + release APK + Maestro agent flows; provisions its own env via `gen-dev-secrets.mjs` + `gen-ci-env.mjs` + the imported throwaway `ci-realm.json`), and `cd-deploy.yml` (main-only: build 6 images via Nx targets → Trivy → push by tag+digest → Komodo redeploy by digest → health probe → rollback; promote by digest, never rebuild). CI secrets/vars live in the **Forgejo Actions** store (never git); prod secrets in **Komodo/Vault**. The self-hosted **Nx remote cache** is env-driven (`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` var + `_ACCESS_TOKEN` secret) — no `nx.json` literal; absent → local cache. GitHub is reduced to a push-mirror that runs **no** Actions; restore a workflow from git history only as the documented runner-down rollback ([docs/proposals/homelab-setup/CI-Cutover-and-Rollback.md](docs/proposals/homelab-setup/CI-Cutover-and-Rollback.md)). When editing CI, reach for `.forgejo/workflows/`, not `.github/workflows/`.

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

Run all of the following before marking any feature complete. **The web E2E regression (`pnpm nx e2e mcm-app`) is REQUIRED for EVERY feature — including backend-only (mc-service) changes** — because a backend change is exercised by the clients through the BFF → service; only E2E proves the real user path still works end-to-end. **If a deployed service/BFF container was changed, rebuild + redeploy it first** (`pnpm nx build <service>` then recreate the container) or the E2E validates a stale image. (Feature 011 lesson.)

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

### Mobile E2E, Android emulator & web/integration harnesses

These detailed procedures live in runbooks (loaded on demand), not inline:

- **Mobile E2E + Android emulator + APK builds** → [docs/runbooks/android-emulator.md](docs/runbooks/android-emulator.md). Covers the agent-flows-in-CI vs non-agent-locally decision rule, the `adb reverse` emulator startup ritual, the "do I even need to rebuild the APK?" check, the CI build path, the Windows `CMAKE_OBJECT_PATH_MAX` wall + build-only recipe, `clearState` recovery, and running Maestro flows / MANUAL_FLOWS.
- **BFF-container E2E modes, the flakiness-diagnosis protocol, the BFF integration-test harness, and web Playwright** → [docs/runbooks/e2e-testing.md](docs/runbooks/e2e-testing.md).

**Three always-true rules worth keeping front-of-mind:** (1) **mobile agent flows run in CI** (the homelab forge `app-ci.yml`'s `app-e2e` job — feature 023 retired the GitHub `android-e2e.yml`) — locally, Metro OOM-crashes after ~1–2 agent `/run` calls; a black screen / `status 0` almost always means Metro died, not a code bug. (2) **Diagnose E2E "flakiness" as a real regression FIRST** — use the deterministic dev-container path (`~54s/93 tests`) and a known-green baseline ×3 before blaming Metro/emulator/machine (feature 009 lesson). (3) **A client→BFF request through `@expo/server` can intermittently LOSE its response** — the `Error: Cannot pipe to a closed or destroyed stream` (vendored express respond pipeline), worst over the emulator's `adb reverse` tunnel. It is benign for *login* (the response usually still lands; a red herring there), but for a request where a dropped response silently flips the outcome it is a real bug: the agent UI-action `authorize()` (`ui-action-tools.tsx`) saw a non-204 and **discarded an already-authorized navigate** ("I can't open that for you.", BFF audit still `allowed=true`) — the feature-023 `agent-navigate-movie` mobile flake. Fix pattern: **retry idempotent client→BFF requests on transient failure (network error / 5xx), never on a genuine 4xx** (default-deny stays intentional) — same shape as the agent-config-probe 5xx-retry. When an agent flow times out at a screen that should have appeared, check the BFF `audit:ui_action … allowed` line + the maestro `screenshot-❌` BEFORE assuming a model/registry fault.


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
shell commands, and other important information, read the current plan:
`specs/023-forgejo-cicd/plan.md`
<!-- SPECKIT END -->
