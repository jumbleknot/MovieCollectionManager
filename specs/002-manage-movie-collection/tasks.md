# Tasks: Manage Movie Collection

**Input**: Design documents from `specs/002-manage-movie-collection/`

**Prerequisites**: plan.md, spec.md, data-model.md, contracts/mc-service-api.md, research.md, quickstart.md

**TDD**: All test tasks MUST be written and confirmed RED before the paired implementation task begins. This is non-negotiable per the project constitution.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no shared dependencies on incomplete tasks)
- **[Story]**: Maps to user story from spec.md (US1–US4)
- All tasks include exact file paths

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project scaffolding so all downstream phases can begin. No production logic yet.

- [X] T001 Add `@monodon/rust` to `nx.json` plugins array; register `mc-service` project in Nx workspace
- [X] T002 Add `backend/mc-service` as a Cargo workspace member in root `Cargo.toml` (create `Cargo.toml` if not yet a workspace)
- [X] T003 [P] Scaffold `backend/mc-service/` with `cargo new --bin`; populate `Cargo.toml` with all declared dependencies (axum, tokio, axum-keycloak-auth, medi-rs, mongodb, serde, serde_json, bson, tower, tower-http, tracing, tracing-subscriber, thiserror, uuid, dotenvy)
- [X] T004 [P] Create `backend/mc-service/project.json`: Nx targets `test`, `test:integration`, `lint` (clippy), `build` (Docker image), `serve` (cargo run), `deploy` using `@monodon/rust` executors
- [X] T005 [P] Create `backend/mc-service/Dockerfile`: multi-stage build — `rust:alpine3.23 AS build` stage + `alpine:3.23 AS runtime` stage; copy only release binary
- [X] T006 [P] Create `infrastructure-as-code/docker/mc-service/compose.yaml`: `mc-db` (MongoDB Community 8.2.6) and `mc-service` services, both on `backend-network`; mc-db healthcheck; mc-service depends_on mc-db + keycloak-service
- [X] T007 Create `backend/mc-service/src/config.rs`: load and validate env vars `MC_DB_URL`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `MC_SERVICE_PORT`; fail fast on missing required vars
- [X] T008 [P] Add `MC_SERVICE_URL` to BFF env config: `frontend/mcm-app/src/config/env.ts` env var declaration and `.env` template comment

**Checkpoint**: `pnpm nx build mc-service` succeeds (empty binary). Docker compose file is valid.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure all user stories depend on. No story phase can begin until this phase is complete.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T009 Write integration test (RED) for `GET /health` → `{"status":"ok"}` in `backend/mc-service/tests/integration/common/mod.rs` + `tests/integration/health_test.rs`
- [X] T009b Write integration test (RED) in `backend/mc-service/tests/integration/health_test.rs` verifying centralized auth enforcement: (1) unauthenticated `GET /api/v1/collections` returns 401 — auth layer blocks before handler runs; (2) `GET /health` returns 200 without auth — public sub-router excluded from auth layer; (3) valid JWT with neither `mc-user` nor `mc-admin` role returns 403 to any `/api/v1/` endpoint — confirms deny-by-default role enforcement at layer level, not per-handler opt-in
- [X] T010 Implement `GET /health` endpoint: `backend/mc-service/src/api/health.rs`; wire `src/api/router.rs`, `src/api/state.rs`, `src/main.rs` entry point (tokio runtime, MongoDB connect, Keycloak JWKS fetch, bind port); structure router with two sub-routers — `protected` (empty placeholder for all `/api/v1/` routes, `KeycloakAuthLayer<Role>` applied as a tower layer — deny-by-default, handlers do NOT declare JWT extractors) and `public` (`/health` and `/metrics` — no auth); merge into top-level `Router`; pass T009 and T009b (GREEN)
- [X] T011 [P] Create `backend/mc-service/src/domain/errors.rs`: typed domain errors — `DuplicateCollectionName`, `DuplicateMovie`, `CollectionNotFound`, `MovieNotFound`, `ValidationError(String)`, `OwnedMediaWhenNotOwned`, `RipQualityWhenNotRipped`
- [X] T012a [P] Write unit tests (RED) in `backend/mc-service/src/domain/specifications/spec.rs` `#[cfg(test)]` block: `AndSpec` returns true only when both inner specs satisfied, `OrSpec` returns true when either satisfied, `NotSpec` inverts result, combined chain (`A and not B`) behaves correctly
- [X] T012 [P] Create `backend/mc-service/src/domain/specifications/spec.rs`: generic `Specification<T>` trait with `is_satisfied_by(&T) -> bool`; `AndSpec`, `OrSpec`, `NotSpec` combinators; pass T012a (GREEN)
- [X] T013 [P] Create `backend/mc-service/src/adapters/mongodb/client.rs`: MongoDB client init from `MC_DB_URL`; returns typed `Database` handle
- [X] T014 Create `backend/mc-service/src/adapters/mongodb/indexes.rs`: idempotent `create_indexes(db)` function that creates all indexes from `data-model.md` — unique name-per-owner (collation), unique movie-per-collection (collation), text search index, all filter indexes; called on startup after MongoDB connect
- [X] T015 Create `backend/mc-service/src/api/middleware/auth.rs`: configure `KeycloakAuthLayer<Role>` from `axum-keycloak-auth` as a reusable tower middleware factory; define `Role` enum with `McUser` and `McAdmin` variants extracted from `resource_access.movie-collection-manager.roles` JWT claim; define `require_app_role` async middleware fn (applied via `from_fn`) that enforces mc-user OR mc-admin OR-logic role check after JWT is validated; the layer stack is applied to the `protected` sub-router in `router.rs` (centralized — NOT per-handler extractor): `auth_layer` (JWT + audience, outermost) → `from_fn(require_app_role)` (role enforcement, inner); a new handler added to the protected sub-router is automatically auth+role protected without any auth code in its body
- [X] T015b Write integration test (RED) in `backend/mc-service/tests/integration/health_test.rs` verifying logging middleware output: a `GET /health` request produces a valid JSON log line on stdout containing fields `request_id` (UUID), `method` ("GET"), `path` ("/health"), `status` (200), and `duration_ms` (numeric); confirms `logging.rs` emits structured JSON, not plaintext; test captures tracing subscriber output — fails until T016 is implemented
- [X] T016 [P] Create `backend/mc-service/src/api/middleware/logging.rs`: per-request tracing with correlation ID (UUID) using `tracing` crate; log request method, path, status, duration as structured JSON fields; wire as a tower layer on the top-level `Router` in `router.rs`; pass T015b (GREEN)
- [X] T017 [P] Create `backend/mc-service/src/api/middleware/error_handler.rs`: catch-all Axum layer mapping unhandled errors to RFC 9457 Problem Details JSON; never exposes stack traces
- [X] T018 Write unit tests (RED) for `frontend/mcm-app/src/bff-server/unit-tests/mc-service-client.test.ts`: `Authorization: Bearer` header injected from session JWT, base URL from `MC_SERVICE_URL`, error response forwarding
- [X] T019 Create and implement `frontend/mcm-app/src/bff-server/mc-service-client.ts`: Axios instance with `MC_SERVICE_URL` base URL and request interceptor that injects `Authorization: Bearer {jwt}` extracted from the BFF session; pass T018 (GREEN)
- [X] T020 [P] Create `frontend/mcm-app/src/types/collection.ts`: TypeScript interfaces matching OpenAPI spec — `Collection`, `CollectionSummary`, `Movie`, `ExternalId`, `FilterOptions`, `MovieListResponse`, `CreateCollectionRequest`, `UpdateCollectionRequest`, `CreateMovieRequest`, `UpdateMovieRequest`; export all

**Checkpoint**: `pnpm nx test mc-service` (health tests pass). BFF can import mc-service-client. Frontend types compile.

---

## Phase 3: User Story 1 — Manage Movie Collections (Priority: P1) 🎯 MVP

**Goal**: Users can create, list, view, set-default, edit (name + description), and delete their own movie collections from the home screen.

**Independent Test**: Create a collection → set it as default → rename it → verify login navigates to it → delete it → verify home screen shows empty state.

### mc-service: Domain Layer (US1)

- [X] T021 Write unit tests (RED) in `backend/mc-service/src/domain/collection.rs` `#[cfg(test)]` block: valid MovieCollection construction, name max 50 chars enforced, description optional, isDefault flag, ownerId set correctly
- [X] T022 Implement `backend/mc-service/src/domain/collection.rs`: `MovieCollection` entity with `CollectionName` value object (max 50 chars, non-empty), optional `Description`, `isDefault: bool`, `ownerId: String`, `acl: Vec<AclEntry>`; pass T021 (GREEN)
- [X] T023 [P] Write unit tests (RED) in `backend/mc-service/src/domain/specifications/collection_name.rs` `#[cfg(test)]` block: length spec rejects >50 chars, accepts 1–50 chars
- [X] T024 [P] Implement `backend/mc-service/src/domain/specifications/collection_name.rs`: `CollectionNameLengthSpec` implementing `Specification<CollectionName>`; pass T023 (GREEN)

### mc-service: Application Layer (US1)

- [X] T025 Create `backend/mc-service/src/application/ports/collection_repository.rs`: `CollectionRepository` trait — `create`, `get_by_id`, `list_by_owner`, `update`, `delete`, `find_default_for_owner`, `clear_default_for_owner`, `set_as_default`; all return `Result<_, DomainError>`
- [X] T026 [P] Create `backend/mc-service/src/application/dtos/collection_dto.rs`: `CollectionDto`, `CollectionSummaryDto` (with `movie_count`), `CreateCollectionDto`, `UpdateCollectionDto`; derive Serialize/Deserialize
- [X] T027 Write unit tests (RED) in `backend/mc-service/src/application/commands/create_collection.rs` `#[cfg(test)]` block: valid creation returns CollectionDto, name >50 chars returns ValidationError, duplicate name returns DuplicateCollectionName
- [X] T028 Implement `backend/mc-service/src/application/commands/create_collection.rs`: `CreateCollectionCommand` + `CommandHandler` (validates name length via spec, calls `repository.create`, returns `CollectionDto`); register with medi-rs; pass T027 (GREEN)
- [X] T029 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/update_collection.rs` `#[cfg(test)]` block: rename succeeds, name >50 chars rejected, duplicate name rejected, description update, partial update (only provided fields change)
- [X] T030 [P] Implement `backend/mc-service/src/application/commands/update_collection.rs`: `UpdateCollectionCommand` + Handler; partial update — only fields present in command are modified; pass T029 (GREEN)
- [X] T031 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/set_default_collection.rs` `#[cfg(test)]` block: sets target as default, atomically clears previous default, setting isDefault false is allowed
- [X] T032 [P] Implement `backend/mc-service/src/application/commands/set_default_collection.rs`: `SetDefaultCollectionCommand` + Handler using MongoDB session transaction to atomically clear old default and set new one; pass T031 (GREEN)
- [X] T033 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/delete_collection.rs` `#[cfg(test)]` block: deletes collection + all movies for that collection, CollectionNotFound for wrong owner
- [X] T034 [P] Implement `backend/mc-service/src/application/commands/delete_collection.rs`: `DeleteCollectionCommand` + Handler (deletes movies then collection, verifies ownerId); pass T033 (GREEN)
- [X] T035 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/list_collections.rs` `#[cfg(test)]` block: returns all collections for owner with movieCount, empty list for new user
- [X] T036 [P] Implement `backend/mc-service/src/application/queries/list_collections.rs`: `ListCollectionsQuery` + Handler returning `Vec<CollectionSummaryDto>`; pass T035 (GREEN)
- [X] T037 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/get_collection.rs` `#[cfg(test)]` block: returns CollectionDto for owner, CollectionNotFound for wrong owner or missing id
- [X] T038 [P] Implement `backend/mc-service/src/application/queries/get_collection.rs`: `GetCollectionQuery` + Handler; pass T037 (GREEN)

### mc-service: Adapters Layer (US1)

- [X] T039 Write integration tests (RED) in `backend/mc-service/tests/integration/collections/`: `create_test.rs` (create + duplicate rejection), `list_test.rs` (list by owner), `get_test.rs` (get + not found), `update_test.rs` (rename + duplicate rejection), `delete_test.rs` (delete collection + cascade movies)
- [X] T040 Create `backend/mc-service/src/adapters/mongodb/daos/collection_dao.rs`: `CollectionDao` BSON struct with all fields; `From<CollectionDao> for MovieCollection` and `From<MovieCollection> for CollectionDao`
- [X] T041 Implement `backend/mc-service/src/adapters/mongodb/collection_repository.rs`: `MongoCollectionRepository` implementing all `CollectionRepository` trait methods; translate MongoDB `E11000` duplicate key → `DuplicateCollectionName`; pass T039 (GREEN)

### mc-service: API Layer (US1)

- [X] T042 Write HTTP integration tests (RED) in `backend/mc-service/tests/integration/collections/`: all 5 endpoints — happy paths (200/201/204), 400 INVALID_INPUT, 401 missing JWT, 403 wrong role, 404 COLLECTION_NOT_FOUND, 409 DUPLICATE_COLLECTION_NAME, RFC 9457 format verified on all errors
- [X] T043 [P] Implement `backend/mc-service/src/api/collections/list.rs`: `GET /api/v1/collections` → call `ListCollectionsQuery` via mediator
- [X] T044 [P] Implement `backend/mc-service/src/api/collections/create.rs`: `POST /api/v1/collections` → deserialize body, call `CreateCollectionCommand` via mediator, return 201
- [X] T045 [P] Implement `backend/mc-service/src/api/collections/get.rs`: `GET /api/v1/collections/:id` → call `GetCollectionQuery`
- [X] T046 [P] Implement `backend/mc-service/src/api/collections/update.rs`: `PATCH /api/v1/collections/:id` → deserialize partial body, call `UpdateCollectionCommand`; if `isDefault: true` also dispatch `SetDefaultCollectionCommand`
- [X] T047 [P] Implement `backend/mc-service/src/api/collections/delete.rs`: `DELETE /api/v1/collections/:id` → call `DeleteCollectionCommand`, return 204
- [X] T048 Add all collection route handlers to the `protected` sub-router in `backend/mc-service/src/api/router.rs` (the sub-router already has `KeycloakAuthLayer` applied from T010 — handlers do NOT declare JWT extractors; auth is enforced centrally by the layer); pass T042 (GREEN)

### BFF: Collection Routes (US1)

- [X] T049 Write unit tests (RED) for BFF collection routes in `frontend/mcm-app/tests/app/bff-api/collections/index+api.test.ts` (GET list, POST create) and `collectionId-index+api.test.ts` (GET, PATCH, DELETE): JWT forwarded, mc-service errors propagated, 401 if no session
- [X] T050 [P] Implement `frontend/mcm-app/src/app/bff-api/collections/index+api.ts`: `GET` → list collections, `POST` → create collection; extract JWT from session, forward to mc-service via mc-service-client
- [X] T051 [P] Implement `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/index+api.ts`: `GET`, `PATCH`, `DELETE` → proxy to mc-service with JWT
- [X] T052 Ensure T049 tests pass (GREEN)

### Frontend: Collections UI (US1)

- [X] T053 Write unit tests (RED) for `frontend/mcm-app/src/hooks/unit-tests/use-collections.test.ts`: list on mount, create triggers BFF POST, edit triggers PATCH, set-default triggers PATCH, delete triggers DELETE, optimistic update on create, error state propagation
- [X] T054 Implement `frontend/mcm-app/src/hooks/use-collections.ts`: collection CRUD + set-default state management using BFF routes; optimistic updates; pass T053 (GREEN)
- [X] T055 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/collection-card.test.tsx`: renders name, description, default badge; action menu (load, edit, set-default, delete)
- [X] T056 [P] Implement `frontend/mcm-app/src/components/collection-card.tsx`: collection card with name, description, default badge, action menu; `testID` on all interactive elements
- [X] T057 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/collection-form.test.tsx`: create mode, edit mode pre-filled, name required, name max 50 chars, submit calls handler, validation messages shown
- [X] T058 [P] Implement `frontend/mcm-app/src/components/collection-form.tsx`: name + description inputs, create/edit modes, validation error display; `testID` attributes
- [X] T059 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/delete-confirmation-dialog.test.tsx`: renders warning message, confirm calls onConfirm, cancel calls onCancel
- [X] T060 [P] Implement `frontend/mcm-app/src/components/delete-confirmation-dialog.tsx`: reusable modal dialog with irreversible-loss warning, confirm and cancel buttons; used for both collection and movie deletion
- [X] T061a [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/collection-list.test.tsx`: renders CollectionCard for each collection in list prop, shows empty state when collections=[], fires onCollectionTap callback when card tapped
- [X] T061 [P] Implement `frontend/mcm-app/src/components/collection-list.tsx` (web, scrollable) and `frontend/mcm-app/src/components/collection-list.native.tsx` (FlatList): renders list of CollectionCard; empty state when no collections; pass T061a (GREEN)
- [X] T062 Write unit tests (RED) for `frontend/mcm-app/src/screens/home/home-screen.test.tsx`: empty state for new user, collection list renders, "Create Collection" button opens form, navigates to collection on card tap
- [X] T063 Update `frontend/mcm-app/src/screens/home/home-screen.tsx`: render CollectionList + "Create Collection" button + navigate to `/collections/[collectionId]` on card tap; pass T062 (GREEN)
- [X] T064 Update `frontend/mcm-app/src/app/(app)/home.tsx` to render HomeScreen; add post-login default collection redirect using Expo Router `router.replace()` (FR-009: if default collection set, replace route with collection screen; else show home — this is App-Layer navigation logic)
- [X] T065 [P] Create `frontend/mcm-app/src/app/(app)/collections/[collectionId]/index.tsx` rendering CollectionScreen placeholder (renders movie list stub until Phase 5 completes; directory-based route enables nested `[movieId]` routes)
- [X] T066 Write E2E tests (RED): `tests/e2e/mobile/collection-create.yaml`, `collection-browse.yaml`, `collection-edit.yaml`, `collection-delete.yaml`; `tests/e2e/web/collections.spec.ts` (create, browse, edit, delete, default, duplicate-name-rejection scenarios)
- [X] T067 Verify E2E tests pass (GREEN — requires full stack: mc-service + BFF + Expo)

**Checkpoint**: User Story 1 is fully functional and independently testable. Home screen shows collections; CRUD + default flow works end-to-end.

---

## Phase 4: User Story 2 — Add and Edit Movies in a Collection (Priority: P2)

**Goal**: Users can add movies with required and optional attributes, view full details, and edit any attribute.

**Independent Test**: Open a collection → add a movie with all required fields → verify saved → open it → edit an optional field → verify persisted across reload.

### mc-service: Domain Layer (US2)

- [X] T068 Write unit tests (RED) in `backend/mc-service/src/domain/movie.rs` `#[cfg(test)]` block: valid Movie construction, required fields enforced, owned=false clears ownedMedia, ripped=false clears ripQuality, ContentType/MediaFormat/USARating enum validation
- [X] T069 Implement `backend/mc-service/src/domain/movie.rs`: `Movie` entity with `ContentType`, `MediaFormat`, `USARating` enums; `ExternalIdentifier` value object; enforce cross-field invariants (owned/ownedMedia, ripped/ripQuality) in setters; pass T068 (GREEN)
- [X] T070a [P] Write unit tests (RED) in `backend/mc-service/src/domain/external_id.rs` `#[cfg(test)]` block: valid ExternalIdentifier construction, uniqueness helper rejects same (system+unique_id) pair, URL is optional, empty system or unique_id rejected
- [X] T070 [P] Create `backend/mc-service/src/domain/external_id.rs`: `ExternalIdentifier` value object — `system: String`, `unique_id: String`, `url: Option<String>`; uniqueness-per-movie validation helper; pass T070a (GREEN)
- [X] T071 [P] Write unit tests (RED) for all movie domain specifications in `backend/mc-service/src/domain/specifications/`: content_type.rs, media_format.rs, owned_media.rs (cross-field), rip_quality.rs (cross-field), movie_unique.rs
- [X] T072 [P] Implement `backend/mc-service/src/domain/specifications/content_type.rs`: `ContentTypeValidSpec`
- [X] T073 [P] Implement `backend/mc-service/src/domain/specifications/media_format.rs`: `MediaFormatValidSpec` (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray)
- [X] T074 [P] Implement `backend/mc-service/src/domain/specifications/owned_media.rs`: `OwnedMediaWhenOwnedSpec` — `ownedMedia` must be empty when `owned = false`
- [X] T075 [P] Implement `backend/mc-service/src/domain/specifications/rip_quality.rs`: `RipQualityWhenRippedSpec` — `ripQuality` must be empty when `ripped = false`
- [X] T076 [P] Implement `backend/mc-service/src/domain/specifications/movie_unique.rs`: `MovieUniqueInCollectionSpec` placeholder (uniqueness enforced via MongoDB collation index at DB level; spec validates application-layer invariant)

### mc-service: Application Layer (US2)

- [X] T077 Create `backend/mc-service/src/application/ports/movie_repository.rs`: `MovieRepository` trait — `create`, `get_by_id`, `update`, `delete`, `list`, `get_filter_options`; all return `Result<_, DomainError>`
- [X] T078 [P] Create `backend/mc-service/src/application/dtos/movie_dto.rs`: `MovieDto` (all fields), `CreateMovieDto`, `UpdateMovieDto`; derive Serialize/Deserialize
- [X] T079 Write unit tests (RED) in `backend/mc-service/src/application/commands/create_movie.rs` `#[cfg(test)]` block: valid creation, duplicate movie rejected, missing required field rejected, owned=false+ownedMedia rejected, ripped=false+ripQuality rejected, invalid ContentType rejected
- [X] T080 Implement `backend/mc-service/src/application/commands/create_movie.rs`: `CreateMovieCommand` + Handler (validate via specs, call `repository.create`, return `MovieDto`); pass T079 (GREEN)
- [X] T081 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/update_movie.rs` `#[cfg(test)]` block: full replacement, enum validation, cross-field invariants, duplicate title+year+contentType rejected
- [X] T082 [P] Implement `backend/mc-service/src/application/commands/update_movie.rs`: `UpdateMovieCommand` + Handler (PUT — full replacement); pass T081 (GREEN)
- [X] T083 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/get_movie.rs` `#[cfg(test)]` block: returns MovieDto for owner, CollectionNotFound, MovieNotFound
- [X] T084 [P] Implement `backend/mc-service/src/application/queries/get_movie.rs`: `GetMovieQuery` + Handler; pass T083 (GREEN)

### mc-service: Adapters Layer (US2)

- [X] T085 Write integration tests (RED) in `backend/mc-service/tests/integration/movies/`: `create_test.rs` (create + required fields + duplicate rejection), `get_test.rs` (get + not found), `update_test.rs` (full replace + validation)
- [X] T086 Create `backend/mc-service/src/adapters/mongodb/daos/movie_dao.rs`: `MovieDao` BSON struct mapping all Movie fields including nested ExternalIdentifier; `From<MovieDao> for Movie` and reverse
- [X] T087 Implement `backend/mc-service/src/adapters/mongodb/movie_repository.rs` — `create`, `get_by_id`, `update` methods: translate MongoDB E11000 → `DuplicateMovie`; pass T085 (GREEN)

### mc-service: API Layer (US2)

- [X] T088 Write HTTP integration tests (RED) in `backend/mc-service/tests/integration/movies/`: create (201, 400 INVALID_INPUT, 400 OWNED_MEDIA_WHEN_NOT_OWNED, 400 RIP_QUALITY_WHEN_NOT_RIPPED, 404, 409 DUPLICATE_MOVIE), get (200, 404 COLLECTION_NOT_FOUND, 404 MOVIE_NOT_FOUND), update (200, all error codes), RFC 9457 format
- [X] T089 [P] Implement `backend/mc-service/src/api/movies/create.rs`: `POST /api/v1/collections/:id/movies`
- [X] T090 [P] Implement `backend/mc-service/src/api/movies/get.rs`: `GET /api/v1/collections/:id/movies/:movieId`
- [X] T091 [P] Implement `backend/mc-service/src/api/movies/update.rs`: `PUT /api/v1/collections/:id/movies/:movieId`
- [X] T092 Add movie create/get/update route handlers to the `protected` sub-router in `backend/mc-service/src/api/router.rs` (centralized `KeycloakAuthLayer` from T010 applies automatically — no per-handler JWT extractors); pass T088 (GREEN)

### BFF: Movie Create/Get/Update Routes (US2)

- [X] T093 Write unit tests (RED) for BFF movie routes in `frontend/mcm-app/tests/app/bff-api/collections/movies-index+api.test.ts` (POST) and `movies-movieId+api.test.ts` (GET, PUT): JWT forwarded, errors propagated, 401 without session
- [X] T094 [P] Implement `POST` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/index+api.ts`: proxy create movie to mc-service
- [X] T095 [P] Implement `GET` and `PUT` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/[movieId]+api.ts`: proxy get and update movie to mc-service
- [X] T096 Ensure T093 tests pass (GREEN)

### Frontend: Movie Form & Detail (US2)

- [X] T097 Write unit tests (RED) for `frontend/mcm-app/src/hooks/unit-tests/use-movies.test.ts` (create/get/update): create movie calls POST, update calls PUT, get movie called on screen mount, error states set
- [X] T098 Implement `frontend/mcm-app/src/hooks/use-movies.ts` (create, get, update only): call BFF routes; manage movie state; pass T097 (GREEN)
- [X] T099 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-form.test.tsx`: all required fields required, optional fields accepted, ContentType enum validated, owned=false hides ownedMedia, ripped=false hides ripQuality, submit calls handler
- [X] T100 [P] Implement `frontend/mcm-app/src/components/movie-form.tsx`: full add/edit form for all movie attributes; conditional ownedMedia/ripQuality fields; inline validation messages; `testID` on all inputs
- [X] T101 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-detail.test.tsx`: renders all Movie fields, shows Edit and Delete buttons
- [X] T102 [P] Implement `frontend/mcm-app/src/components/movie-detail.tsx`: read-only view of all movie attributes; Edit navigates to MovieForm; Delete opens DeleteConfirmationDialog
- [X] T103 Write unit tests (RED) for `frontend/mcm-app/src/screens/movies/movie-detail-screen.test.tsx`: renders MovieDetail, switches to edit mode on edit tap
- [X] T104 Implement `frontend/mcm-app/src/screens/movies/movie-detail-screen.tsx`: renders MovieDetail; switches to MovieForm on edit; submit saves via use-movies hook; pass T103 (GREEN)
- [X] T105 Create `frontend/mcm-app/src/app/(app)/collections/[collectionId]/movies/[movieId].tsx` rendering MovieDetailScreen (nested under `[collectionId]/` directory so collectionId is available in route params)
- [X] T106 Write E2E tests (RED): `tests/e2e/mobile/movie-add.yaml`, `movie-edit.yaml`; `tests/e2e/web/movies.spec.ts` (add movie all fields, edit optional field, invalid content type rejection, duplicate movie rejection)
- [X] T107 Verify E2E tests pass (GREEN — requires full stack: mc-service + BFF + Expo)

**Checkpoint**: User Stories 1 and 2 are both independently functional. Users can add movies to collections and edit them.

---

## Phase 5: User Story 3 — Browse, Search, and Filter Movies (Priority: P3)

**Goal**: Users can browse movies with infinite scroll, select display columns, perform free-text search, and apply dynamic filters.

**Independent Test**: Populate a collection with 5+ diverse movies → verify default columns → add a column → search by title substring → apply genre filter → apply decade filter → apply combined search+filter → verify each step returns the correct subset.

### mc-service: Application Layer (US3)

- [X] T108 Write unit tests (RED) in `backend/mc-service/src/application/queries/list_movies.rs` `#[cfg(test)]` block: cursor pagination advances page, search term narrows results, each individual filter narrows results, combined search+filter intersects correctly, empty result set
- [X] T109 Implement `backend/mc-service/src/application/queries/list_movies.rs`: `ListMoviesQuery` + Handler — cursor (Base64 ObjectId), search, contentType, genre (OR), childrens, rated, language, decade (year range), owned, ownedMedia (OR), ripped, ripQuality (OR); batch size 50; return `MovieListDto` with `nextCursor`; pass T108 (GREEN)
- [X] T110 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/get_filter_options.rs` `#[cfg(test)]` block: returns only values present in collection for genres, ratings, languages, decades
- [X] T111 [P] Implement `backend/mc-service/src/application/queries/get_filter_options.rs`: `GetFilterOptionsQuery` + Handler using MongoDB distinct queries; return `FilterOptionsDto`; pass T110 (GREEN)

### mc-service: Adapters Layer (US3)

- [X] T112 Write integration tests (RED) in `backend/mc-service/tests/integration/movies/list_test.rs`: cursor advances through 50-movie batches, search returns matching titles, filters narrow correctly, filter-options returns only collection-present values; `search_filter_test.rs`: combined search+filter
- [X] T113 Implement `MongoMovieRepository::list()` in `backend/mc-service/src/adapters/mongodb/movie_repository.rs`: keyset pagination (`_id > cursor`), `$text` search, all filter query params applied as match stage; return items + nextCursor; pass T112 list tests (GREEN)
- [X] T114 [P] Implement `MongoMovieRepository::get_filter_options()`: MongoDB distinct queries for genres, rated, language, decade (derived from year); pass T112 filter-options tests (GREEN)

### mc-service: API Layer (US3)

- [X] T115 Write HTTP integration tests (RED) in `backend/mc-service/tests/integration/movies/`: list with all query params, cursor pagination response shape (`nextCursor` null/present), filter-options shape, 404 COLLECTION_NOT_FOUND
- [X] T116 [P] Implement `backend/mc-service/src/api/movies/list.rs`: `GET /api/v1/collections/:id/movies` — parse all query params, dispatch `ListMoviesQuery`
- [X] T117 [P] Implement `backend/mc-service/src/api/movies/filter_options.rs`: `GET /api/v1/collections/:id/movies/filter-options` — dispatch `GetFilterOptionsQuery`
- [X] T118 Add movie list + filter-options route handlers to the `protected` sub-router in `backend/mc-service/src/api/router.rs` (centralized `KeycloakAuthLayer` from T010 applies automatically); pass T115 (GREEN)

### BFF: Movie List & Filter-Options Routes (US3)

- [X] T119 Write unit tests (RED) in `frontend/mcm-app/tests/app/bff-api/collections/movies-index+api.test.ts` (GET list with query params) and `movies-filter-options+api.test.ts`: all query params forwarded, filter-options proxied
- [X] T120 [P] Implement `GET` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/index+api.ts`: forward all list query params (cursor, search, contentType, genre, childrens, rated, language, decade, owned, ownedMedia, ripped, ripQuality) to mc-service
- [X] T121 [P] Implement `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/filter-options+api.ts`: `GET` proxy to mc-service filter-options endpoint
- [X] T122 Ensure T119 tests pass (GREEN)

### Frontend: Browse/Search/Filter (US3)

- [X] T123 Write unit tests (RED) for `frontend/mcm-app/src/hooks/unit-tests/use-movies.test.ts` (list/search/filter additions): initial load calls BFF GET, `onEndReached` loads next page with cursor, search term change resets cursor + reloads, filter change resets cursor + reloads, column visibility state toggled correctly, filter-options fetched on mount
- [X] T124 Update `frontend/mcm-app/src/hooks/use-movies.ts`: add infinite scroll (cursor state), search state (debounced), filter state, column visibility state, filter-options fetcher; pass T123 (GREEN)
- [X] T125 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-list-item.test.tsx`: renders only visible columns, title always shown
- [X] T126 [P] Implement `frontend/mcm-app/src/components/movie-list-item.tsx`: single row rendering configurable columns; `testID` per column cell
- [X] T127a [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-list.test.tsx`: renders MovieListItem rows from items prop, triggers onLoadMore callback when scrolled to end (intersection observer / onEndReached), shows empty state when items=[]
- [X] T127 [P] Implement `frontend/mcm-app/src/components/movie-list.tsx` (web, scrollable div with intersection observer) and `frontend/mcm-app/src/components/movie-list.native.tsx` (FlatList with `onEndReached`); triggers next-page load; empty state when no results; pass T127a (GREEN)
- [X] T128 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/column-selector.test.tsx`: renders all column options, toggle shows/hides column
- [X] T129 [P] Implement `frontend/mcm-app/src/components/column-selector.tsx`: show/hide panel; default visible columns per FR-018; persists column state in hook
- [X] T130 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-search-bar.test.tsx`: debounced input triggers search, clear resets
- [X] T131 [P] Implement `frontend/mcm-app/src/components/movie-search-bar.tsx`: debounced text input (300ms); clears search on empty; `testID` on input
- [X] T132 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-filter-panel.test.tsx`: loads filter-options on mount, renders chips/selects for each filter type, only shows options present in collection, applies filter on select
- [X] T133 [P] Implement `frontend/mcm-app/src/components/movie-filter-panel.tsx`: collapsible panel; genre, rated, language, decade, contentType, childrens, owned, ownedMedia, ripped, ripQuality filters; each filter rendered from filter-options response
- [X] T134 Write unit tests (RED) for `frontend/mcm-app/src/screens/collections/collection-screen.test.tsx`: renders MovieList + SearchBar + FilterPanel + ColumnSelector + "Add Movie" button, navigates to movie on tap
- [X] T135 Implement `frontend/mcm-app/src/screens/collections/collection-screen.tsx`: compose MovieList + MovieSearchBar + MovieFilterPanel + ColumnSelector + "Add Movie" button; wire to use-movies hook; navigate to MovieDetailScreen on row tap; pass T134 (GREEN)
- [X] T136 Update `frontend/mcm-app/src/app/(app)/collections/[collectionId]/index.tsx` to render CollectionScreen (replace Phase 3 stub from T065)
- [X] T137 Write E2E tests (RED): `tests/e2e/mobile/movie-browse.yaml`, `movie-search-filter.yaml`; expand `tests/e2e/web/movies.spec.ts` with browse, column selection, search, filter, combined search+filter scenarios
- [X] T138 Verify E2E tests pass (GREEN)

**Checkpoint**: User Stories 1, 2, and 3 independently functional. Full browse/search/filter flow works on 10,000-movie collections within 3-second target.

---

## Phase 6: User Story 4 — Remove Movies from a Collection (Priority: P4)

**Goal**: Users can permanently delete a movie after explicitly confirming the irreversible warning.

**Independent Test**: Add a movie → initiate delete → verify warning dialog appears → confirm → verify movie no longer in list → add again → initiate delete → cancel → verify movie still present.

### mc-service: Application Layer (US4)

- [X] T139 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/delete_movie.rs` `#[cfg(test)]` block: delete success returns Ok, CollectionNotFound, MovieNotFound
- [X] T140 [P] Implement `backend/mc-service/src/application/commands/delete_movie.rs`: `DeleteMovieCommand` + Handler (verify collection ownership + movie exists, then delete); pass T139 (GREEN)

### mc-service: Adapters Layer (US4)

- [X] T141 Write integration tests (RED) in `backend/mc-service/tests/integration/movies/delete_test.rs`: delete success (204), MOVIE_NOT_FOUND (404), COLLECTION_NOT_FOUND (404)
- [X] T142 Implement `MongoMovieRepository::delete()` in `backend/mc-service/src/adapters/mongodb/movie_repository.rs`; pass T141 (GREEN)

### mc-service: API Layer (US4)

- [X] T143 Write HTTP integration tests (RED) for `DELETE /api/v1/collections/:id/movies/:movieId`: 204 happy path, 401, 403, 404 COLLECTION_NOT_FOUND, 404 MOVIE_NOT_FOUND, RFC 9457 format
- [X] T144 Implement `backend/mc-service/src/api/movies/delete.rs`: `DELETE /api/v1/collections/:id/movies/:movieId` → call `DeleteMovieCommand`, return 204
- [X] T145 Add movie delete route handler to the `protected` sub-router in `backend/mc-service/src/api/router.rs` (centralized `KeycloakAuthLayer` from T010 applies automatically); pass T143 (GREEN)

### BFF: Movie Delete Route (US4)

- [X] T146 Write unit tests (RED) for `DELETE` in `frontend/mcm-app/tests/app/bff-api/collections/movies-movieId+api.test.ts`: 204 forwarded, 404 forwarded, 401 without session
- [X] T147 Implement `DELETE` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/[movieId]+api.ts`: proxy delete to mc-service; pass T146 (GREEN)

### Frontend: Movie Delete (US4)

- [X] T148 Write unit tests (RED) for delete flow in `frontend/mcm-app/src/screens/movies/movie-detail-screen.test.tsx`: delete tap opens DeleteConfirmationDialog, confirm calls delete mutation + navigates back, cancel closes dialog + movie unchanged
- [X] T149 Update `frontend/mcm-app/src/screens/movies/movie-detail-screen.tsx`: open DeleteConfirmationDialog on delete tap; on confirm call delete via use-movies hook then navigate back; pass T148 (GREEN)
- [X] T150 Update `frontend/mcm-app/src/hooks/use-movies.ts`: add `deleteMovie` mutation calling BFF DELETE endpoint; optimistic list removal
- [X] T151 Write E2E tests (RED): `tests/e2e/mobile/movie-delete.yaml`; expand `tests/e2e/web/movies.spec.ts` with delete + cancel scenarios
- [X] T152 Verify E2E tests pass (GREEN)

**Checkpoint**: All four user stories independently functional. Full feature end-to-end.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Quality, observability, and documentation across all stories.

- [X] T153 [P] Add `logger.audit` calls to BFF collection and movie routes for security events: 401 (auth failure), 403 (access denied); update `frontend/mcm-app/src/bff-server/mc-service-client.ts` to log failed mc-service calls
- [X] T154 [P] Add `tracing` audit spans to mc-service API layer for 401/403 events and all mutating operations; ensure correlation ID propagated to all log entries in `backend/mc-service/src/api/middleware/logging.rs`
- [X] T155 [P] Run `pnpm nx lint mc-service` (cargo clippy --deny warnings); fix all warnings in `backend/mc-service/src/`
- [X] T156 [P] Run `cargo fmt --check` on `backend/mc-service/`; apply formatting
- [X] T157 [P] Run `cargo audit` on `backend/mc-service/`; remediate any moderate or higher vulnerabilities
- [X] T158 [P] Verify ≥70% unit test line coverage for `backend/mc-service/src/` using `cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests --out Lcov --fail-under 70`; add `cargo-tarpaulin` to dev dependencies in `backend/mc-service/Cargo.toml`; the `--fail-under 70` flag causes tarpaulin to exit non-zero if coverage drops below threshold — enforces the constitution's ≥70% coverage quality standard automatically in CI
- [X] T159 [P] Verify ≥70% unit test line coverage for new `frontend/mcm-app/src/` additions via `pnpm nx test mcm-app`
- [X] T160 [P] Validate `api-specs/mc-service-api.yaml` matches implementation exactly; update any fields that diverged during implementation
- [X] T161 [P] Update `docs/MCM-Architecture.md` to reflect mc-service, mc-db, and `infrastructure-as-code/docker/mc-service/compose.yaml` additions
- [X] T162 Follow `specs/002-manage-movie-collection/quickstart.md` to validate the full stack starts correctly; document any gaps found
- [X] T163a [P] Write integration test (RED) for `GET /metrics` in `backend/mc-service/tests/integration/health_test.rs`: HTTP 200, `Content-Type: text/plain; version=0.0.4`, body contains valid Prometheus exposition format, no stack traces in response
- [X] T163 [P] Implement `GET /metrics` endpoint in `backend/mc-service/src/api/` using `metrics` + `metrics-exporter-prometheus` crates; add crates to `backend/mc-service/Cargo.toml`; wire route into the `public` sub-router in `backend/mc-service/src/api/router.rs` (NOT the `protected` sub-router — `/metrics` must be reachable without auth for Prometheus scraping; constitution MUST: Prometheus-compatible scrape format); pass T163a (GREEN)
- [X] T164 [P] Write load test in `frontend/mcm-app/tests/load/` that seeds a 10,000-movie collection and asserts: initial list load time <3s (SC-006), search response time <3s (SC-006), home screen collection list load time <3s (SC-004); add `test:load` Nx target to `frontend/mcm-app/project.json` (executor: `nx:run-commands`, command: `node tests/load/run.js` or equivalent k6/artillery invocation); run via `pnpm nx test:load mcm-app`
- [X] T165 [P] Create `docs/development.md` documenting: Nx command reference for both JS/TS and Rust projects, local dev loop, architecture layer examples for mc-service (domain/application/adapters/api), BFF pattern usage, and Docker networking topology

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **User Stories (Phases 3–6)**: All depend on Phase 2 completion
  - Stories are ordered P1 → P2 → P3 → P4 (US2 requires a collection from US1; US3 requires movies from US2; US4 requires movies from US2)
  - With multiple developers, US3 and US4 can begin in parallel after US2 Domain + Adapters are complete
- **Polish (Phase 7)**: Depends on all desired user stories completing

### Within Each User Story (mc-service)

```text
Domain tests (RED) → Domain implementation (GREEN)
    ↓
Application tests (RED) → Application implementation (GREEN)
    ↓
Adapter integration tests (RED) → Adapter implementation (GREEN)
    ↓
API HTTP tests (RED) → API implementation (GREEN)
    ↓
BFF tests (RED) → BFF implementation (GREEN)
    ↓
Frontend unit tests (RED) → Frontend implementation (GREEN)
    ↓
E2E tests (RED) → Verify E2E (GREEN)
```

### User Story Dependencies

- **US1 (P1)**: Depends only on Phase 2 — no other story dependencies
- **US2 (P2)**: Depends on Phase 2 + US1 (needs a collection to add movies to); US1 BFF and frontend not required for mc-service layer to be implemented
- **US3 (P3)**: Depends on Phase 2 + US2 Domain/Adapters (needs movies to search/filter); US3 mc-service can begin once US2 mc-service is complete
- **US4 (P4)**: Depends on Phase 2 + US2 Adapters (needs movie delete in repository); can be implemented in parallel with US3 after US2 Adapters complete

### Parallel Opportunities by Phase

**Phase 1**: T003, T004, T005, T006, T007, T008 all run in parallel after T001 and T002

**Phase 2**: T011, T012, T013 run in parallel after T010; T016, T017, T018, T020 run in parallel

**Phase 3 (US1)**:

- T023/T024 (domain specs) in parallel after T021/T022
- T029–T038 (application commands/queries) all parallel within application layer after T026/T027
- T043–T047 (API handlers) all parallel after T042

**Phase 4 (US2)**: T072–T076 (domain specs) all parallel; T079–T084 (application commands/queries) parallel within layer

**Phase 5 (US3)**: T116/T117 (API handlers) parallel; T126–T133 (frontend components) all parallel

---

## Parallel Example: User Story 1 Application Layer

```bash
# All application command/query tests can be written in parallel (different files):
T029 - update_collection.rs tests
T031 - set_default_collection.rs tests
T033 - delete_collection.rs tests
T035 - list_collections.rs tests
T037 - get_collection.rs tests

# After tests are RED, implementations can run in parallel:
T030 - update_collection.rs implementation
T032 - set_default_collection.rs implementation
T034 - delete_collection.rs implementation
T036 - list_collections.rs implementation
T038 - get_collection.rs implementation
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (**CRITICAL** — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Home screen shows collections; full CRUD + default + login redirect works
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → scaffold ready
2. User Story 1 → working home screen with collection management → deploy/demo (MVP)
3. User Story 2 → add/edit movies → deploy/demo
4. User Story 3 → browse/search/filter → deploy/demo
5. User Story 4 → delete movies → deploy/demo (feature complete)
6. Polish → quality pass

### TDD Gate

Before each implementation task begins, its paired test task MUST be complete and confirmed RED. The user approves the test suite before the implementation task starts. This is enforced by the project constitution and is non-negotiable.

---

## Notes

- `[P]` = task can run in parallel with other `[P]` tasks at the same phase/layer
- `[US1]–[US4]` = maps task to user story for traceability
- Rust unit tests are co-located in `#[cfg(test)]` blocks within the source file being tested
- Frontend unit tests are co-located with source except App-layer (which go in `tests/app/`)
- Integration tests for mc-service live in `backend/mc-service/tests/integration/`
- The `@monodon/rust` Nx plugin handles cargo invocation; use `pnpm nx test mc-service` not `cargo test` directly
- Cargo arguments pass through using `--` (e.g., `pnpm nx test mc-service -- --test collection_create`)
- All mc-service Rust source files use snake_case (Rust module system requirement); this is documented as a constitution exception in plan.md Complexity Tracking
