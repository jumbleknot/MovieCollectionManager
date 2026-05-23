# Implementation Plan: Manage Movie Collection

**Branch**: `002-manage-movie-collection` | **Date**: 2026-05-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-manage-movie-collection/spec.md`

---

## Summary

Enable authenticated users to manage their movie collections end-to-end by building the `mc-service` Rust/Axum microservice backed by MongoDB, extending the `mcm-app` BFF with new collection and movie API routes, and adding all collection management and movie CRUD screens to the React Native frontend. This feature delivers: create/browse/edit/set-default/delete collections; add/view/edit/delete movies with rich metadata; free-text search; infinite-scroll movie list with dynamic column selection and multi-criteria filtering.

---

## Technical Context

**Language/Version**: TypeScript 5.x (BFF + frontend), Rust 1.83+ (mc-service)

**Primary Dependencies**:

- mc-service: `axum 0.8`, `tokio 1.x`, `axum-keycloak-auth`, `medi-rs`, `mongodb 3.x`, `serde 1.x`, `serde_json`, `bson`, `tower`, `tower-http`, `tracing`, `tracing-subscriber`, `thiserror`, `uuid`
- Frontend BFF: Axios, existing BFF infrastructure from feature 001
- Frontend client: Expo SDK 55, React Native, Expo Router, Axios

**Storage**: MongoDB 8.x — new `mc-db` container, database `mc_db`, collections `movie_collections` and `movies`

**Testing**: Jest + Expo Testing Library + Playwright + Maestro (frontend); `pnpm nx test` / `pnpm nx test:integration` via `@monodon/rust` (mc-service); `mockall` crate for Rust unit mocking

**Target Platform**: Web + Android (frontend); Docker (BFF, mc-service, mc-db)

**Performance Goals**:

- Initial collection movie list load: <3 seconds for up to 10,000 movies (SC-006)
- Search and filter results: <3 seconds (SC-006)
- Home screen load after login: <3 seconds (SC-004)
- Frontend Time-to-Interactive: ≤2 seconds on simulated 3G (constitution frontend performance budget; validated via Playwright performance measurement in T164)

**Constraints**:

- BFF pattern: React Native client never holds tokens; all mc-service calls go through BFF with JWT extracted from session
- Keycloak JWT with `mc-user` or `mc-admin` role required for all mc-service endpoints
- Clean Architecture in mc-service: Domain → Application → Adapters → API layers
- CQRS via `medi-rs` mediator
- Repository Pattern via trait-based Adapter Interfaces
- No ORM: `mongodb` crate only
- TDD mandatory throughout

**Scale/Scope**: Up to 10,000 movies per collection; multi-user; owner-only access for this feature (sharing out of scope)

**Horizontal Scalability**: mc-service is stateless — all persistent state lives in MongoDB. Multiple mc-service instances can run behind a load balancer without coordination. MongoDB transactions (used for the atomic `SetDefault` operation) are safe across replicas when targeting a replica set or sharded cluster.

---

## Constitution Check

*GATE: All items must pass before implementation proceeds.*

| Principle | Status | Notes |
| --------- | ------ | ----- |
| Authentication: JWT via Keycloak, PKCE + BFF pattern | ✅ Pass | mc-service validates JWT with `axum-keycloak-auth`; BFF forwards JWT from session |
| Authorization: RBAC deny-by-default | ✅ Pass | mc-service enforces `mc-user`/`mc-admin` role; ownership enforced per-query via `ownerId` |
| Session Management: HTTP-only cookie, opaque session ID | ✅ Pass | No changes to auth session; BFF pattern unchanged |
| Data Protection: input validation server-side | ✅ Pass | Domain-Layer Specification Pattern validates all inputs; API-Layer validates before processing |
| Clean Architecture: 4-layer separation | ✅ Pass | mc-service structured as Domain → Application → Adapters → API |
| CQRS Pattern | ✅ Pass | `medi-rs` mediator dispatches commands and queries |
| Repository Pattern | ✅ Pass | Adapter Interfaces defined in Application-Layer, implemented by MongoDB adapters |
| No ORM | ✅ Pass | `mongodb` crate directly; no SQLx or ORM |
| TDD | ✅ Pass | All tests written before implementation; Jest/Playwright/Maestro/cargo test |
| Structured Logging | ✅ Pass | `tracing` + JSON subscriber in mc-service; existing `@/bff-server/logger` in BFF |
| API-First: OpenAPI 3.0.3 | ✅ Pass | `api-specs/mc-service-api.yaml` created before implementation |
| Docker-Native: containers for all services | ✅ Pass | mc-service + mc-db run as Docker containers |
| Monorepo Nx: tasks via pnpm nx | ✅ Pass | `@monodon/rust` Nx plugin for mc-service; existing `@nx/expo` for mcm-app |
| Frontend 6-Layer Separation | ✅ Pass | App/BFF/Components/Screens/Utils/Hooks layers respected |
| Frontend Tech Stack: Expo SDK 55, Axios | ✅ Pass | No deviations |
| WCAG 2.2 AA Accessibility | ✅ Pass | ARIA labels and testIDs on all interactive elements |
| pnpm package manager | ✅ Pass | No npm/yarn usage |
| Monitoring Stack: Prometheus /metrics endpoint | ✅ Pass | mc-service exposes `GET /metrics` (T163); `metrics` + `metrics-exporter-prometheus` crates; Prometheus scrape-compatible format |

**No violations detected. All gates pass.**

---

## Project Structure

### Documentation (this feature)

```text
specs/002-manage-movie-collection/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 research decisions
├── data-model.md        # MongoDB schema design
├── quickstart.md        # Local development guide
├── contracts/
│   └── mc-service-api.md  # API contract documentation
└── tasks.md             # Phase 2 output (/speckit-tasks command)

api-specs/
└── mc-service-api.yaml  # OpenAPI 3.0.3 specification (created in Phase 1)
```

### Source Code — mc-service (new Rust microservice)

```text
backend/mc-service/
├── .env                     # Non-secret defaults (gitignored individually)
├── .env.local               # Local secret overrides (gitignored)
├── Cargo.toml               # Workspace member; dependencies declared here
├── Dockerfile               # Multi-stage: rust:alpine3.23 build → alpine:3.23 runtime
├── project.json             # Nx project config (@monodon/rust)
├── src/
│   ├── main.rs              # Entry point: build router, bind server, run migrations
│   ├── config.rs            # Environment variable loading and validation
│   ├── domain/
│   │   ├── mod.rs
│   │   ├── collection.rs    # MovieCollection entity + value objects (CollectionName, Description)
│   │   ├── movie.rs         # Movie entity + value objects (ContentType, MediaFormat, USARating)
│   │   ├── external_id.rs   # ExternalIdentifier value object
│   │   ├── errors.rs        # Typed domain errors (DuplicateName, DuplicateMovie, ValidationError)
│   │   └── specifications/
│   │       ├── mod.rs
│   │       ├── spec.rs              # Generic Specification<T> trait + base
│   │       ├── collection_name.rs   # CollectionNameUniqueSpec, CollectionNameLengthSpec
│   │       ├── movie_unique.rs      # MovieUniqueInCollectionSpec
│   │       ├── content_type.rs      # ContentTypeValidSpec
│   │       ├── media_format.rs      # MediaFormatValidSpec
│   │       ├── owned_media.rs       # OwnedMediaWhenOwnedSpec (cross-field)
│   │       └── rip_quality.rs       # RipQualityWhenRippedSpec (cross-field)
│   ├── application/
│   │   ├── mod.rs
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── create_collection.rs    # CreateCollectionCommand + Handler
│   │   │   ├── update_collection.rs    # UpdateCollectionCommand + Handler (name/desc/default)
│   │   │   ├── delete_collection.rs    # DeleteCollectionCommand + Handler
│   │   │   ├── set_default_collection.rs  # SetDefaultCollectionCommand + Handler
│   │   │   ├── create_movie.rs         # CreateMovieCommand + Handler
│   │   │   ├── update_movie.rs         # UpdateMovieCommand + Handler
│   │   │   └── delete_movie.rs         # DeleteMovieCommand + Handler
│   │   ├── queries/
│   │   │   ├── mod.rs
│   │   │   ├── list_collections.rs     # ListCollectionsQuery + Handler
│   │   │   ├── get_collection.rs       # GetCollectionQuery + Handler
│   │   │   ├── list_movies.rs          # ListMoviesQuery + Handler (search, filter, cursor)
│   │   │   ├── get_movie.rs            # GetMovieQuery + Handler
│   │   │   └── get_filter_options.rs   # GetFilterOptionsQuery + Handler
│   │   ├── dtos/
│   │   │   ├── mod.rs
│   │   │   ├── collection_dto.rs       # CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto
│   │   │   └── movie_dto.rs            # MovieDto, CreateMovieDto, UpdateMovieDto, MovieListDto, FilterOptionsDto
│   │   └── ports/
│   │       ├── mod.rs
│   │       ├── collection_repository.rs  # CollectionRepository trait (Adapter Interface)
│   │       └── movie_repository.rs       # MovieRepository trait (Adapter Interface)
│   ├── adapters/
│   │   ├── mod.rs
│   │   └── mongodb/
│   │       ├── mod.rs
│   │       ├── client.rs                 # MongoDB client initialization
│   │       ├── indexes.rs                # Index creation on startup
│   │       ├── collection_repository.rs  # Implements CollectionRepository trait
│   │       ├── movie_repository.rs       # Implements MovieRepository trait
│   │       └── daos/
│   │           ├── mod.rs
│   │           ├── collection_dao.rs     # BSON document ↔ domain object mapping
│   │           └── movie_dao.rs          # BSON document ↔ domain object mapping
│   └── api/
│       ├── mod.rs
│       ├── router.rs                     # Axum router assembly; all routes registered here
│       ├── state.rs                      # AppState (mediator, db client, Keycloak config)
│       ├── middleware/
│       │   ├── mod.rs
│       │   ├── auth.rs                   # axum-keycloak-auth extractor; role enforcement
│       │   ├── logging.rs                # Request/response tracing with correlation ID
│       │   └── error_handler.rs          # Catch-all unhandled error → RFC 9457 response
│       ├── collections/
│       │   ├── mod.rs
│       │   ├── list.rs                   # GET /api/v1/collections
│       │   ├── create.rs                 # POST /api/v1/collections
│       │   ├── get.rs                    # GET /api/v1/collections/:id
│       │   ├── update.rs                 # PATCH /api/v1/collections/:id
│       │   └── delete.rs                 # DELETE /api/v1/collections/:id
│       ├── movies/
│       │   ├── mod.rs
│       │   ├── list.rs                   # GET /api/v1/collections/:id/movies
│       │   ├── create.rs                 # POST /api/v1/collections/:id/movies
│       │   ├── get.rs                    # GET /api/v1/collections/:id/movies/:movieId
│       │   ├── update.rs                 # PUT /api/v1/collections/:id/movies/:movieId
│       │   ├── delete.rs                 # DELETE /api/v1/collections/:id/movies/:movieId
│       │   └── filter_options.rs         # GET /api/v1/collections/:id/movies/filter-options
│       └── health.rs                     # GET /health
├── tests/integration/
│   ├── common/
│   │   └── mod.rs                        # Test fixtures, MongoDB test client setup
│   ├── collections/
│   │   ├── create_test.rs
│   │   ├── list_test.rs
│   │   ├── get_test.rs
│   │   ├── update_test.rs
│   │   └── delete_test.rs
│   └── movies/
│       ├── create_test.rs
│       ├── list_test.rs
│       ├── search_filter_test.rs
│       ├── get_test.rs
│       ├── update_test.rs
│       └── delete_test.rs
```

### Source Code — Frontend (additions to mcm-app)

```text
frontend/mcm-app/
├── src/
│   ├── app/
│   │   ├── bff-api/
│   │   │   └── collections/
│   │   │       ├── index+api.ts              # GET (list), POST (create collection)
│   │   │       └── [collectionId]/
│   │   │           ├── index+api.ts          # GET, PATCH, DELETE collection
│   │   │           └── movies/
│   │   │               ├── index+api.ts      # GET (list), POST (create movie)
│   │   │               ├── filter-options+api.ts  # GET filter options
│   │   │               └── [movieId]+api.ts  # GET, PUT, DELETE movie
│   │   └── (app)/
│   │       ├── home.tsx                      # UPDATED: delegates to HomeScreen
│   │       └── collections/
│   │           └── [collectionId]/
│   │               ├── index.tsx              # Delegates to CollectionScreen
│   │               └── movies/
│   │                   └── [movieId].tsx      # Delegates to MovieDetailScreen
│   ├── bff-server/
│   │   └── mc-service-client.ts              # Axios client for BFF → mc-service calls
│   ├── components/
│   │   ├── collection-list.tsx               # Web default: scrollable collection list
│   │   ├── collection-list.native.tsx         # Native: FlatList-based collection list
│   │   ├── collection-card.tsx               # Single collection item with action menu
│   │   ├── collection-form.tsx               # Create/edit collection form
│   │   ├── movie-list.tsx                    # Web: infinite-scroll movie table
│   │   ├── movie-list.native.tsx             # Native: FlatList infinite scroll
│   │   ├── movie-list-item.tsx               # Single row in movie list
│   │   ├── column-selector.tsx               # Column show/hide panel (FR-019)
│   │   ├── movie-search-bar.tsx              # Text search input (FR-021)
│   │   ├── movie-filter-panel.tsx            # Filter chips/selects (FR-022)
│   │   ├── movie-form.tsx                    # Add/edit movie form (all attributes)
│   │   ├── movie-detail.tsx                  # Read-only movie detail view
│   │   └── delete-confirmation-dialog.tsx    # Reusable "confirm permanent deletion" dialog
│   ├── screens/
│   │   ├── home/
│   │   │   └── home-screen.tsx               # UPDATED: collection list + create button
│   │   ├── collections/
│   │   │   └── collection-screen.tsx         # Movie list + search/filter/columns for one collection
│   │   └── movies/
│   │       └── movie-detail-screen.tsx       # Full movie view + edit + delete
│   ├── hooks/
│   │   ├── use-collections.ts               # Collection CRUD, default management, optimistic updates
│   │   └── use-movies.ts                    # Movie CRUD, infinite scroll, search, filter, column state
│   └── types/
│       └── collection.ts                    # TypeScript interfaces: Collection, Movie, ExternalId, FilterOptions, etc.
├── tests/
│   ├── app/
│   │   └── bff-api/
│   │       └── collections/
│   │           ├── index+api.test.ts
│   │           ├── collectionId-index+api.test.ts
│   │           ├── movies-index+api.test.ts
│   │           ├── movies-filter-options+api.test.ts
│   │           └── movies-movieId+api.test.ts
│   ├── integration/
│   │   ├── collections.test.ts              # Collection CRUD integration (requires mc-service)
│   │   └── movies.test.ts                   # Movie CRUD + search/filter integration
│   └── e2e/
│       ├── mobile/
│       │   ├── collection-create.yaml
│       │   ├── collection-browse.yaml
│       │   ├── collection-edit.yaml
│       │   ├── collection-delete.yaml
│       │   ├── movie-add.yaml
│       │   ├── movie-browse.yaml
│       │   ├── movie-search-filter.yaml
│       │   ├── movie-edit.yaml
│       │   └── movie-delete.yaml
│       └── web/
│           ├── collections.spec.ts
│           └── movies.spec.ts
```

**Structure Decision**: Option 3 (Mobile + API) pattern. mc-service is a new backend Rust project at `/backend/mc-service/`. Frontend additions extend the existing `/frontend/mcm-app/` project following the 6-layer separation pattern.

---

## Complexity Tracking

| Item | Deviation | Justification |
| ---- | --------- | ------------- |
| Rust source file naming | Snake_case used (e.g., `collection_dao.rs`, `movie_repository.rs`) instead of constitution's kebab-case | Rust's module system requires snake_case for file names; kebab-case filenames are a compile error. All other directories and non-Rust files follow kebab-case. |

---

## Infrastructure Changes

### New Docker Services

Defined in a new, separate `infrastructure-as-code/docker/mc-service/compose.yaml` (not added to the BFF compose file):

```yaml
mc-db:
  image: mongodb/mongodb-community-server:8.2.6-ubuntu2204-slim
  container_name: mc-db
  networks: [backend-network]
  volumes:
    - mc-db-data:/data/db
  healthcheck:
    test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
    interval: 10s
    timeout: 5s
    retries: 5

mc-service:
  image: mc-service:latest
  container_name: mc-service
  depends_on:
    mc-db:
      condition: service_healthy
    keycloak-service:
      condition: service_healthy
  networks: [backend-network]
  environment:
    MC_DB_URL: mongodb://mc-db:27017/mc_db
    KEYCLOAK_URL: http://keycloak-service:8080
    KEYCLOAK_REALM: jumbleknot
    KEYCLOAK_CLIENT_ID: movie-collection-manager
    MC_SERVICE_PORT: 3001
    RUST_LOG: info
```

> mc-service joins only `backend-network`. The BFF (which exists on both `bff-network` and `backend-network`) reaches mc-service via `backend-network`.

### New BFF Environment Variables

```env
MC_SERVICE_URL=http://mc-service:3001    # Docker
# MC_SERVICE_URL=http://localhost:3001   # Local dev
```

---

## Implementation Phases

Implementation follows TDD: tests written first → RED → implement → GREEN → refactor.

> **TDD gate**: No production code is written without a failing test first. All tests written in advance and approved before implementation begins.

---

### Phase 0: Infrastructure & Setup

**Goal**: All project scaffolding in place; CI runs green with zero production logic.

1. **Nx workspace**: Add `@monodon/rust` plugin to `nx.json`; configure `test`, `build`, `lint`, `serve` targets for `mc-service`.
2. **Cargo workspace**: Add `backend/mc-service` as a Cargo workspace member in root `Cargo.toml` (if not yet a Cargo workspace).
3. **mc-service scaffold**: `cargo new backend/mc-service --bin`; add dependencies to `Cargo.toml`; verify `cargo build` succeeds.
4. **Docker infrastructure**: Create `infrastructure-as-code/docker/mc-service/compose.yaml` with `mc-db` and `mc-service` services; both join `backend-network`.
5. **MongoDB indexes**: Create `adapters/mongodb/indexes.rs` that runs `create_index` calls on startup; verify idempotency.
6. **Health endpoint**: Implement `GET /health` → `{"status":"ok"}`; write first integration test against it.
7. **BFF environment**: Add `MC_SERVICE_URL` env var to BFF `.env` and `config/env.ts`; add `mc-service-client.ts` stub.

---

### Phase 1: mc-service Domain & Application Layer (TDD)

**Goal**: All business logic validated by passing tests; no API layer yet.

**Tests written first** (unit tests in each `.rs` file):

- `domain/collection.rs` tests: valid construction, name length constraint, name uniqueness spec
- `domain/movie.rs` tests: required fields, enum validation, cross-field invariants (owned/ownedMedia, ripped/ripQuality)
- `application/commands/` tests: each command validates inputs via specs, calls repository methods, returns typed Result
- `application/queries/` tests: each query builds correct filter criteria, returns DTOs

**Implementation after tests fail**:

1. Domain entities with Specification Pattern
2. Application command/query handlers using `medi-rs`
3. Port trait definitions (Repository interfaces)

---

### Phase 2: mc-service Adapters Layer (TDD)

**Goal**: MongoDB repositories implement port traits; integration tests pass against real MongoDB.

**Integration tests written first** (in `tests/integration/` directory):

- Collection CRUD: create → list → get → update → delete
- Duplicate name rejection (case-insensitive)
- Movie CRUD: create → list (cursor pagination) → get → update → delete
- Duplicate movie rejection (case-insensitive title+year+contentType)
- Text search returns only matching movies
- Filter combinations return correct subsets
- Infinite scroll: cursor advances correctly through 10K movie dataset

**Implementation after tests fail**:

1. MongoDB client initialization and index creation
2. `MovieCollectionRepository` implementing `CollectionRepository` trait
3. `MongoMovieRepository` implementing `MovieRepository` trait
4. DAO structs with BSON serialization/deserialization

---

### Phase 3: mc-service API Layer (TDD)

**Goal**: REST API matches OpenAPI spec; HTTP integration tests pass.

**Tests written first** (HTTP-level integration tests using `axum::test`):

- All 11 endpoints: happy path + error paths (400, 401, 403, 404, 409)
- JWT missing → 401; JWT with wrong role → 403
- Pagination cursor advances correctly
- RFC 9457 error format on all error responses

**Implementation after tests fail**:

1. Axum router with JWT middleware (`axum-keycloak-auth`)
2. Request/response serialization + deserialization
3. Handler → mediator dispatch
4. Error mapping: domain errors → HTTP status codes + RFC 9457 Problem Details
5. Correlation ID middleware (tracing)
6. Audit logging (login access, 401, 403, 404 events)

---

### Phase 4: BFF Extensions (TDD)

**Goal**: BFF routes proxy all collection and movie operations to mc-service; frontend can call BFF.

**Tests written first** (unit tests in `tests/app/bff-api/collections/`):

- Each BFF route: extracts JWT from session, forwards to mc-service with correct headers
- mc-service errors propagated as correct HTTP status codes to client
- Session required; 401 if no valid session

**Implementation after tests fail**:

1. `mc-service-client.ts`: Axios instance with mc-service base URL, Authorization header injection from BFF session
2. BFF API route files: `index+api.ts`, `[collectionId]/index+api.ts`, `movies/index+api.ts`, `movies/filter-options+api.ts`, `movies/[movieId]+api.ts`

---

### Phase 5: Frontend — Types, Hooks, and BFF Client (TDD)

**Goal**: Data layer for collections and movies; hooks manage state, pagination, and API calls.

**Tests written first** (unit tests collocated with each file):

- `collection.ts` types: TypeScript compilation validates all type shapes
- `use-collections.ts` tests: create/edit/delete/set-default trigger correct BFF calls; optimistic updates; error states
- `use-movies.ts` tests: infinite scroll loads next page on demand; search/filter resets cursor; column state management

**Implementation after tests fail**:

1. TypeScript interfaces in `types/collection.ts`
2. `use-collections` hook: collection CRUD + default management state machine
3. `use-movies` hook: infinite scroll, search, filter state, column visibility state

---

### Phase 6: Frontend — Collection Screens & Components (TDD)

**Goal**: Home screen shows collections; users can create, edit, set-default, and delete collections.

**Tests written first**:

- Unit tests for each component (Jest + Expo Testing Library)
- E2E tests: `collection-create.yaml`, `collection-browse.yaml`, `collection-edit.yaml`, `collection-delete.yaml` (Maestro + Playwright)

**TDD sequence per component/screen**:

1. Write failing unit test
2. Implement component/screen
3. Watch test pass
4. Write E2E test
5. Implement E2E-visible UI details (testIDs, ARIA labels)

**Components**:

- `collection-card.tsx`: name, description, default badge, actions (load/edit/set-default/delete)
- `collection-list.tsx` + `.native.tsx`: scrollable list of cards; empty state (FR-010, US1 Scenario 1)
- `collection-form.tsx`: create/edit form with name + optional description
- `delete-confirmation-dialog.tsx`: reusable warning dialog for both collection and movie deletion

**Screens**:

- `home-screen.tsx` (updated): renders `CollectionList`; "Create Collection" button; navigates to collection on card tap
- `collection-screen.tsx`: renders movie list with search/filter for one collection; "Add Movie" button

**Routing** (App-Layer updates):

- `app/(app)/home.tsx` (updated): renders `HomeScreen`; includes Expo Router `router.replace()` redirect to the default collection if one is set (FR-009) — navigation logic is valid in the App-Layer
- `app/(app)/collections/[collectionId]/index.tsx`: renders `CollectionScreen` (directory-based route enables nested `[movieId]` sub-routes)

---

### Phase 7: Frontend — Movie Screens & Components (TDD)

**Goal**: Users can browse movies with infinite scroll, search, filter, and manage individual movies.

**Tests written first**:

- Unit tests for each component
- Integration tests: `tests/integration/collections.test.ts`, `movies.test.ts`
- E2E tests: `movie-add.yaml`, `movie-browse.yaml`, `movie-search-filter.yaml`, `movie-edit.yaml`, `movie-delete.yaml` (Maestro + Playwright)

**Components**:

- `movie-list-item.tsx`: single row; shows configurable columns
- `movie-list.tsx` + `.native.tsx`: infinite-scroll list; `onEndReached` triggers next page load
- `column-selector.tsx`: shows/hides columns in the list (FR-019)
- `movie-search-bar.tsx`: debounced text input; clears and reloads list on change
- `movie-filter-panel.tsx`: collapsible panel; loads filter options from `filter-options` endpoint (FR-024); renders chips/selects for each filter type
- `movie-form.tsx`: add/edit form for all movie attributes; inline validation messages
- `movie-detail.tsx`: read-only view of all movie attributes; "Edit" and "Delete" actions

**Screens**:

- `movie-detail-screen.tsx`: renders `MovieDetail`; switches to `MovieForm` on edit; shows `DeleteConfirmationDialog` on delete

**Routing**:

- `app/(app)/collections/[collectionId]/movies/[movieId].tsx`: renders `MovieDetailScreen` (nested under `[collectionId]/` so `collectionId` param is available for BFF calls and back-navigation)

---

## Post-Constitution Check (after Phase 1 design)

All Phase 1 design decisions (data model, API contracts) verified against constitution:

- ✅ OpenAPI spec committed to `api-specs/` before implementation
- ✅ MongoDB schema uses `movie_collections` and `movies` collections as per `docs/MCM-Architecture.md`
- ✅ Domain entities are independent of adapters and API layers
- ✅ Specification Pattern used for validation only (not query logic)
- ✅ ACL structure in `movie_collections` accommodates future sharing without blocking this feature
