# Development Guide

Practical reference for working with the MovieCollectionManager monorepo.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 22+ | Frontend runtime |
| pnpm | 9+ | JavaScript package manager |
| Rust | 1.80+ | mc-service |
| cargo | (bundled) | Rust build tool |
| Docker | 24+ | Infrastructure containers |
| nx | (workspace) | Task runner (via pnpm) |

## Package Managers & Task Runner

**JavaScript/TypeScript**: pnpm (workspace root)  
**Rust**: cargo (mc-service workspace)  
**Task runner**: Nx — orchestrates both

> Never use `npm` or `yarn`. Never invoke pnpm scripts directly when an Nx target exists.

```bash
# Install JavaScript dependencies (run from repo root)
pnpm install

# Universal invocation for all Nx-managed tasks
pnpm nx <target> <project>
```

## Nx Command Reference

### Frontend (mcm-app)

```bash
pnpm nx test mcm-app              # Unit tests (Jest, 70% line coverage enforced)
pnpm nx test:integration mcm-app  # Integration tests (requires Keycloak + Redis)
pnpm nx lint mcm-app              # ESLint
pnpm nx e2e mcm-app               # Web E2E via Playwright (auto-starts Expo)
pnpm nx e2e:mobile mcm-app        # Mobile E2E via Maestro (requires Android emulator)
pnpm nx build mcm-app             # Build BFF Docker image
pnpm nx deploy mcm-app            # Deploy BFF + Redis (requires .env.docker)
pnpm nx docker-down mcm-app       # Stop BFF + Redis
```

### Backend (mc-service)

```bash
pnpm nx test mc-service              # Unit tests (cargo test --lib)
pnpm nx test:integration mc-service  # Integration tests (requires MongoDB running)
pnpm nx lint mc-service              # cargo clippy
pnpm nx build mc-service             # Build Docker image
pnpm nx deploy mc-service            # Start mc-service + mc-db containers
pnpm nx serve mc-service             # Run locally (cargo run)

# Pass cargo flags through with --
pnpm nx test mc-service -- --test collection_create
```

### Cross-project

```bash
pnpm nx run-many --targets=test,lint   # All cacheable checks across all projects
pnpm nx run-many --target=build        # Build all projects
pnpm nx run-many --target=deploy       # Deploy all projects
```

## Local Dev Loop

### Minimal setup (frontend only)

```bash
# 1. Start Keycloak + Redis (required for BFF auth)
cd infrastructure-as-code/docker/keycloak && docker compose up -d
docker compose -f infrastructure-as-code/docker/bff/compose.yaml up -d mcm-redis

# 2. Start Expo dev server (web + Android)
cd frontend/mcm-app && pnpm start
# Press w=web, a=Android
```

### Full stack (frontend + mc-service)

```bash
# 1. Docker network setup (one-time)
docker network create backend-network
docker network create frontend-network

# 2. Start Keycloak (required first — mc-service fetches JWKS on startup)
cd infrastructure-as-code/docker/keycloak && docker compose up -d

# 3. Start mc-service + MongoDB
pnpm nx deploy mc-service
# mc-service: http://localhost:3001
# MongoDB:    mongodb://localhost:27017/mc_db

# 4. Start Redis (BFF session store)
docker compose -f infrastructure-as-code/docker/bff/compose.yaml up -d mcm-redis

# 5. Start Expo
cd frontend/mcm-app && pnpm start
```

> **Without Redis**: the BFF `/login` endpoint returns 500 because the rate-limiter's first Redis call fails before returning a typed error.

> **Without Keycloak running first**: mc-service fails to start because it cannot fetch the JWKS endpoint to cache the Keycloak public key for JWT validation.

## mc-service Architecture Layers

mc-service follows **Clean Architecture** with strict 4-layer separation. Outer layers may import from inner layers; inner layers must never import from outer layers.

```
src/
├── domain/           ← Layer 1: Entities, specs, domain errors
│   ├── collection.rs
│   ├── movie.rs
│   ├── errors.rs
│   └── specifications/
├── application/      ← Layer 2: CQRS handlers, DTOs, repository ports
│   ├── commands/     ←   Command handlers (create, update, delete, set-default)
│   ├── queries/      ←   Query handlers (get, list)
│   ├── dtos/         ←   Data transfer objects (request/response shapes)
│   └── ports/        ←   Repository trait interfaces (collection_repository.rs, movie_repository.rs)
├── adapters/         ← Layer 3: MongoDB implementations of ports
│   └── mongodb/
│       ├── collection_repository.rs
│       ├── movie_repository.rs
│       └── daos/     ←   BSON ↔ domain mapping
└── api/              ← Layer 4: Axum handlers, middleware, router, AppState
    ├── collections/  ←   Collection endpoints (create, get, list, update, delete)
    ├── movies/       ←   Movie endpoints (create, get, list, update, delete, filter-options)
    ├── middleware/   ←   auth.rs, logging.rs, error_handler.rs
    ├── health.rs     ←   GET /health (public)
    ├── metrics.rs    ←   GET /metrics (public, Prometheus)
    ├── router.rs     ←   Axum router assembly, AppState wiring
    └── state.rs      ←   AppState holding all application handlers
```

### Adding a new mc-service endpoint

1. **Domain**: Add entity fields or validation spec in `src/domain/`
2. **Application**: Add command/query struct + handler in `src/application/commands/` or `src/application/queries/`; add repo method to port in `src/application/ports/`
3. **Adapters**: Implement the new port method in `src/adapters/mongodb/`
4. **API**: Add Axum handler in `src/api/collections/` or `src/api/movies/`; register route in `src/api/router.rs`; add handler to `AppState` in `src/api/state.rs`

Unit tests live **inline** in the same source file (`#[cfg(test)] mod tests { ... }`). Integration tests live in `tests/integration/`.

## BFF Pattern

The BFF (`frontend/mcm-app/src/bff-server/`) runs server-side inside the Expo Router Node.js container. It owns all token handling — the React Native client never touches raw JWTs.

```
Client (React Native)
  │
  ▼  HTTP + session cookie (opaque session ID, no JWT)
BFF API Routes (src/app/bff-api/)
  │  requireAuth() → extracts JWT from Redis session
  ▼  Authorization: Bearer {jwt}
mc-service (Rust/Axum)
  │  axum-keycloak-auth validates JWT locally (JWKS cached on startup)
  ▼
MongoDB
```

**BFF server modules** (`src/bff-server/`):

| Module | Purpose |
|--------|---------|
| `auth.ts` | JWT validation middleware, cookie/header extraction |
| `token-service.ts` | JWT signature validation, role extraction |
| `keycloak.ts` | Token exchange, user lookup via service account |
| `session-manager.ts` | Redis-backed sessions, concurrent session limits |
| `rate-limiter.ts` | Per-IP rate limiting for login/logout |
| `mc-service-client.ts` | Axios client for BFF → mc-service proxying |
| `logger.ts` | Structured JSON logger (never use `console.*` in BFF code) |

**BFF API routes** (`src/app/bff-api/`):

| Route | Methods | Purpose |
|-------|---------|---------|
| `auth/login+api.ts` | POST | OAuth2 code exchange, session creation |
| `auth/logout+api.ts` | POST | Session destruction, Keycloak SSO logout |
| `auth/refresh+api.ts` | POST | Token refresh |
| `auth/user+api.ts` | GET | Current user profile |
| `collections/index+api.ts` | GET, POST | List/create collections |
| `collections/[collectionId]/index+api.ts` | GET, PATCH, DELETE | Get/update/delete collection |
| `collections/[collectionId]/movies/index+api.ts` | GET, POST | List/create movies |
| `collections/[collectionId]/movies/filter-options+api.ts` | GET | Filter options |
| `collections/[collectionId]/movies/[movieId]+api.ts` | GET, PUT, DELETE | Get/update/delete movie |

## Docker Networking Topology

```
host machine
├── port 8099 → keycloak-service:8080  (Keycloak UI + API)
├── port 8025 → mailpit:8025           (Test mail client)
├── port 6379 → mcm-redis:6379         (Redis — BFF session store)
├── port 3001 → mc-service:3001        (mc-service REST API)
└── port 27017 → mc-db:27017           (MongoDB)

Docker networks:
  backend-network:  keycloak-service ↔ mc-service ↔ mc-db
  frontend-network: keycloak-service ↔ BFF container

Container DNS names (within docker networks):
  keycloak-service  → Keycloak (BFF uses this via frontend-network)
  mc-service        → mc-service REST (BFF uses this via backend-network)
  mc-db             → MongoDB (mc-service uses this via backend-network)
  mcm-redis         → Redis (BFF uses this via frontend-network)
```

> **Docker internal DNS**: BFF contacts Keycloak via `keycloak-service:8080` inside Docker networks, not `localhost:8099`.

## Coverage & Quality Gates

| Project | Tool | Threshold | Command |
|---------|------|-----------|---------|
| mcm-app | Jest | 70% lines | `pnpm nx test mcm-app --coverage` |
| mc-service (unit) | cargo-tarpaulin | 70% lines (unit+integration) | `cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests --out Lcov` |
| mcm-app | ESLint | Zero errors | `pnpm nx lint mcm-app` |
| mc-service | clippy | Zero warnings | `pnpm nx lint mc-service` |

> mc-service unit test coverage alone is ~29% due to Clean Architecture — the MongoDB adapter and Axum API layers are covered only by integration tests. Running the full suite (unit + integration tests with MongoDB) meets the 70% threshold.

## Logging Rules

### BFF (TypeScript)

- **Always** use `import { logger } from '@/bff-server/logger'` — never `console.*` in BFF code
- Use `logger.audit('event', { userId, ip })` for security events (login, logout, 401, 403, 429)
- Never log: raw tokens, session IDs, passwords, email addresses, usernames

### mc-service (Rust)

- Use `tracing::info!`, `tracing::warn!`, `tracing::error!` macros
- Use `tracing::instrument(skip(state))` on handler functions
- The logging middleware generates a `request_id` span field that propagates to all child spans
- Never log: JWT payloads, raw tokens, passwords, or email addresses
- Log Keycloak user ID (UUID) for ownership/audit events — never username or email
