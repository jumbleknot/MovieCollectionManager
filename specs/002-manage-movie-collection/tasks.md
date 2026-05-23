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

- [ ] T001 Add `@monodon/rust` to `nx.json` plugins array; register `mc-service` project in Nx workspace
- [ ] T002 Add `backend/mc-service` as a Cargo workspace member in root `Cargo.toml` (create `Cargo.toml` if not yet a workspace)
- [ ] T003 [P] Scaffold `backend/mc-service/` with `cargo new --bin`; populate `Cargo.toml` with all declared dependencies (axum, tokio, axum-keycloak-auth, medi-rs, mongodb, serde, serde_json, bson, tower, tower-http, tracing, tracing-subscriber, thiserror, uuid, dotenvy)
- [ ] T004 [P] Create `backend/mc-service/project.json`: Nx targets `test`, `test:integration`, `lint` (clippy), `build` (Docker image), `serve` (cargo run), `deploy` using `@monodon/rust` executors
- [ ] T005 [P] Create `backend/mc-service/Dockerfile`: multi-stage build — `rust:alpine3.23 AS build` stage + `alpine:3.23 AS runtime` stage; copy only release binary
- [ ] T006 [P] Create `infrastructure-as-code/docker/mc-service/compose.yaml`: `mc-db` (MongoDB Community 8.2.6) and `mc-service` services, both on `backend-network`; mc-db healthcheck; mc-service depends_on mc-db + keycloak-service
- [ ] T007 Create `backend/mc-service/src/config.rs`: load and validate env vars `MC_DB_URL`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `MC_SERVICE_PORT`; fail fast on missing required vars
- [ ] T008 [P] Add `MC_SERVICE_URL` to BFF env config: `frontend/mcm-app/src/config/env.ts` env var declaration and `.env` template comment

**Checkpoint**: `pnpm nx build mc-service` succeeds (empty binary). Docker compose file is valid.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure all user stories depend on. No story phase can begin until this phase is complete.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [ ] T009 Write integration test (RED) for `GET /health` → `{"status":"ok"}` in `backend/mc-service/tests/integration/common/mod.rs` + `tests/integration/health_test.rs`
- [ ] T010 Implement `GET /health` endpoint: `backend/mc-service/src/api/health.rs`; wire `src/api/router.rs`, `src/api/state.rs`, `src/main.rs` entry point (tokio runtime, MongoDB connect, Keycloak JWKS fetch, bind port); pass T009 (GREEN)
- [ ] T011 [P] Create `backend/mc-service/src/domain/errors.rs`: typed domain errors — `DuplicateCollectionName`, `DuplicateMovie`, `CollectionNotFound`, `MovieNotFound`, `ValidationError(String)`, `OwnedMediaWhenNotOwned`, `RipQualityWhenNotRipped`
- [ ] T012 [P] Create `backend/mc-service/src/domain/specifications/spec.rs`: generic `Specification<T>` trait with `is_satisfied_by(&T) -> bool`; `AndSpec`, `OrSpec`, `NotSpec` combinators
- [ ] T013 [P] Create `backend/mc-service/src/adapters/mongodb/client.rs`: MongoDB client init from `MC_DB_URL`; returns typed `Database` handle
- [ ] T014 Create `backend/mc-service/src/adapters/mongodb/indexes.rs`: idempotent `create_indexes(db)` function that creates all indexes from `data-model.md` — unique name-per-owner (collation), unique movie-per-collection (collation), text search index, all filter indexes; called on startup after MongoDB connect
- [ ] T015 Create `backend/mc-service/src/api/middleware/auth.rs`: `axum-keycloak-auth` extractor; enforces `mc-user` or `mc-admin` role from `resource_access.movie-collection-manager.roles`; returns 401 on missing/invalid JWT, 403 on missing role
- [ ] T016 [P] Create `backend/mc-service/src/api/middleware/logging.rs`: per-request tracing with correlation ID (UUID) using `tracing` crate; log request method, path, status, duration
- [ ] T017 [P] Create `backend/mc-service/src/api/middleware/error_handler.rs`: catch-all Axum layer mapping unhandled errors to RFC 9457 Problem Details JSON; never exposes stack traces
- [ ] T018 Write unit tests (RED) for `frontend/mcm-app/src/bff-server/unit-tests/mc-service-client.test.ts`: `Authorization: Bearer` header injected from session JWT, base URL from `MC_SERVICE_URL`, error response forwarding
- [ ] T019 Create and implement `frontend/mcm-app/src/bff-server/mc-service-client.ts`: Axios instance with `MC_SERVICE_URL` base URL and request interceptor that injects `Authorization: Bearer {jwt}` extracted from the BFF session; pass T018 (GREEN)
- [ ] T020 [P] Create `frontend/mcm-app/src/types/collection.ts`: TypeScript interfaces matching OpenAPI spec — `Collection`, `CollectionSummary`, `Movie`, `ExternalId`, `FilterOptions`, `MovieListResponse`, `CreateCollectionRequest`, `UpdateCollectionRequest`, `CreateMovieRequest`, `UpdateMovieRequest`; export all

**Checkpoint**: `pnpm nx test mc-service` (health tests pass). BFF can import mc-service-client. Frontend types compile.

---

## Phase 3: User Story 1 — Manage Movie Collections (Priority: P1) 🎯 MVP

**Goal**: Users can create, list, view, set-default, edit (name + description), and delete their own movie collections from the home screen.

**Independent Test**: Create a collection → set it as default → rename it → verify login navigates to it → delete it → verify home screen shows empty state.

### mc-service: Domain Layer (US1)

- [ ] T021 Write unit tests (RED) in `backend/mc-service/src/domain/collection.rs` `#[cfg(test)]` block: valid MovieCollection construction, name max 50 chars enforced, description optional, isDefault flag, ownerId set correctly
- [ ] T022 Implement `backend/mc-service/src/domain/collection.rs`: `MovieCollection` entity with `CollectionName` value object (max 50 chars, non-empty), optional `Description`, `isDefault: bool`, `ownerId: String`, `acl: Vec<AclEntry>`; pass T021 (GREEN)
- [ ] T023 [P] Write unit tests (RED) in `backend/mc-service/src/domain/specifications/collection_name.rs` `#[cfg(test)]` block: length spec rejects >50 chars, accepts 1–50 chars
- [ ] T024 [P] Implement `backend/mc-service/src/domain/specifications/collection_name.rs`: `CollectionNameLengthSpec` implementing `Specification<CollectionName>`; pass T023 (GREEN)

### mc-service: Application Layer (US1)

- [ ] T025 Create `backend/mc-service/src/application/ports/collection_repository.rs`: `CollectionRepository` trait — `create`, `get_by_id`, `list_by_owner`, `update`, `delete`, `find_default_for_owner`, `clear_default_for_owner`, `set_as_default`; all return `Result<_, DomainError>`
- [ ] T026 [P] Create `backend/mc-service/src/application/dtos/collection_dto.rs`: `CollectionDto`, `CollectionSummaryDto` (with `movie_count`), `CreateCollectionDto`, `UpdateCollectionDto`; derive Serialize/Deserialize
- [ ] T027 Write unit tests (RED) in `backend/mc-service/src/application/commands/create_collection.rs` `#[cfg(test)]` block: valid creation returns CollectionDto, name >50 chars returns ValidationError, duplicate name returns DuplicateCollectionName
- [ ] T028 Implement `backend/mc-service/src/application/commands/create_collection.rs`: `CreateCollectionCommand` + `CommandHandler` (validates name length via spec, calls `repository.create`, returns `CollectionDto`); register with medi-rs; pass T027 (GREEN)
- [ ] T029 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/update_collection.rs` `#[cfg(test)]` block: rename succeeds, name >50 chars rejected, duplicate name rejected, description update, partial update (only provided fields change)
- [ ] T030 [P] Implement `backend/mc-service/src/application/commands/update_collection.rs`: `UpdateCollectionCommand` + Handler; partial update — only fields present in command are modified; pass T029 (GREEN)
- [ ] T031 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/set_default_collection.rs` `#[cfg(test)]` block: sets target as default, atomically clears previous default, setting isDefault false is allowed
- [ ] T032 [P] Implement `backend/mc-service/src/application/commands/set_default_collection.rs`: `SetDefaultCollectionCommand` + Handler using MongoDB session transaction to atomically clear old default and set new one; pass T031 (GREEN)
- [ ] T033 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/delete_collection.rs` `#[cfg(test)]` block: deletes collection + all movies for that collection, CollectionNotFound for wrong owner
- [ ] T034 [P] Implement `backend/mc-service/src/application/commands/delete_collection.rs`: `DeleteCollectionCommand` + Handler (deletes movies then collection, verifies ownerId); pass T033 (GREEN)
- [ ] T035 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/list_collections.rs` `#[cfg(test)]` block: returns all collections for owner with movieCount, empty list for new user
- [ ] T036 [P] Implement `backend/mc-service/src/application/queries/list_collections.rs`: `ListCollectionsQuery` + Handler returning `Vec<CollectionSummaryDto>`; pass T035 (GREEN)
- [ ] T037 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/get_collection.rs` `#[cfg(test)]` block: returns CollectionDto for owner, CollectionNotFound for wrong owner or missing id
- [ ] T038 [P] Implement `backend/mc-service/src/application/queries/get_collection.rs`: `GetCollectionQuery` + Handler; pass T037 (GREEN)

### mc-service: Adapters Layer (US1)

- [ ] T039 Write integration tests (RED) in `backend/mc-service/tests/integration/collections/`: `create_test.rs` (create + duplicate rejection), `list_test.rs` (list by owner), `get_test.rs` (get + not found), `update_test.rs` (rename + duplicate rejection), `delete_test.rs` (delete collection + cascade movies)
- [ ] T040 Create `backend/mc-service/src/adapters/mongodb/daos/collection_dao.rs`: `CollectionDao` BSON struct with all fields; `From<CollectionDao> for MovieCollection` and `From<MovieCollection> for CollectionDao`
- [ ] T041 Implement `backend/mc-service/src/adapters/mongodb/collection_repository.rs`: `MongoCollectionRepository` implementing all `CollectionRepository` trait methods; translate MongoDB `E11000` duplicate key → `DuplicateCollectionName`; pass T039 (GREEN)

### mc-service: API Layer (US1)

- [ ] T042 Write HTTP integration tests (RED) in `backend/mc-service/tests/integration/collections/`: all 5 endpoints — happy paths (200/201/204), 400 INVALID_INPUT, 401 missing JWT, 403 wrong role, 404 COLLECTION_NOT_FOUND, 409 DUPLICATE_COLLECTION_NAME, RFC 9457 format verified on all errors
- [ ] T043 [P] Implement `backend/mc-service/src/api/collections/list.rs`: `GET /api/v1/collections` → call `ListCollectionsQuery` via mediator
- [ ] T044 [P] Implement `backend/mc-service/src/api/collections/create.rs`: `POST /api/v1/collections` → deserialize body, call `CreateCollectionCommand` via mediator, return 201
- [ ] T045 [P] Implement `backend/mc-service/src/api/collections/get.rs`: `GET /api/v1/collections/:id` → call `GetCollectionQuery`
- [ ] T046 [P] Implement `backend/mc-service/src/api/collections/update.rs`: `PATCH /api/v1/collections/:id` → deserialize partial body, call `UpdateCollectionCommand`; if `isDefault: true` also dispatch `SetDefaultCollectionCommand`
- [ ] T047 [P] Implement `backend/mc-service/src/api/collections/delete.rs`: `DELETE /api/v1/collections/:id` → call `DeleteCollectionCommand`, return 204
- [ ] T048 Wire all collection routes + auth middleware into `backend/mc-service/src/api/router.rs`; pass T042 (GREEN)

### BFF: Collection Routes (US1)

- [ ] T049 Write unit tests (RED) for BFF collection routes in `frontend/mcm-app/tests/app/bff-api/collections/index+api.test.ts` (GET list, POST create) and `collectionId-index+api.test.ts` (GET, PATCH, DELETE): JWT forwarded, mc-service errors propagated, 401 if no session
- [ ] T050 [P] Implement `frontend/mcm-app/src/app/bff-api/collections/index+api.ts`: `GET` → list collections, `POST` → create collection; extract JWT from session, forward to mc-service via mc-service-client
- [ ] T051 [P] Implement `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/index+api.ts`: `GET`, `PATCH`, `DELETE` → proxy to mc-service with JWT
- [ ] T052 Ensure T049 tests pass (GREEN)

### Frontend: Collections UI (US1)

- [ ] T053 Write unit tests (RED) for `frontend/mcm-app/src/hooks/unit-tests/use-collections.test.ts`: list on mount, create triggers BFF POST, edit triggers PATCH, set-default triggers PATCH, delete triggers DELETE, optimistic update on create, error state propagation
- [ ] T054 Implement `frontend/mcm-app/src/hooks/use-collections.ts`: collection CRUD + set-default state management using BFF routes; optimistic updates; pass T053 (GREEN)
- [ ] T055 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/collection-card.test.tsx`: renders name, description, default badge; action menu (load, edit, set-default, delete)
- [ ] T056 [P] Implement `frontend/mcm-app/src/components/collection-card.tsx`: collection card with name, description, default badge, action menu; `testID` on all interactive elements
- [ ] T057 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/collection-form.test.tsx`: create mode, edit mode pre-filled, name required, name max 50 chars, submit calls handler, validation messages shown
- [ ] T058 [P] Implement `frontend/mcm-app/src/components/collection-form.tsx`: name + description inputs, create/edit modes, validation error display; `testID` attributes
- [ ] T059 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/delete-confirmation-dialog.test.tsx`: renders warning message, confirm calls onConfirm, cancel calls onCancel
- [ ] T060 [P] Implement `frontend/mcm-app/src/components/delete-confirmation-dialog.tsx`: reusable modal dialog with irreversible-loss warning, confirm and cancel buttons; used for both collection and movie deletion
- [ ] T061 [P] Implement `frontend/mcm-app/src/components/collection-list.tsx` (web, scrollable) and `frontend/mcm-app/src/components/collection-list.native.tsx` (FlatList): renders list of CollectionCard; empty state when no collections
- [ ] T062 Write unit tests (RED) for `frontend/mcm-app/src/screens/home/home-screen.test.tsx`: empty state for new user, collection list renders, "Create Collection" button opens form, navigates to collection on card tap
- [ ] T063 Update `frontend/mcm-app/src/screens/home/home-screen.tsx`: render CollectionList + "Create Collection" button + navigate to `/collections/[collectionId]` on card tap; pass T062 (GREEN)
- [ ] T064 Update `frontend/mcm-app/src/app/(app)/home.tsx` to render HomeScreen; add post-login default collection redirect logic (FR-009: if default collection set, navigate to it; else show home)
- [ ] T065 [P] Create `frontend/mcm-app/src/app/(app)/collections/[collectionId].tsx` rendering CollectionScreen placeholder (renders movie list stub until Phase 5 completes)
- [ ] T066 Write E2E tests (RED): `tests/e2e/mobile/collection-create.yaml`, `collection-browse.yaml`, `collection-edit.yaml`, `collection-delete.yaml`; `tests/e2e/web/collections.spec.ts` (create, browse, edit, delete, default, duplicate-name-rejection scenarios)
- [ ] T067 Verify E2E tests pass (GREEN — requires full stack: mc-service + BFF + Expo)

**Checkpoint**: User Story 1 is fully functional and independently testable. Home screen shows collections; CRUD + default flow works end-to-end.

---

## Phase 4: User Story 2 — Add and Edit Movies in a Collection (Priority: P2)

**Goal**: Users can add movies with required and optional attributes, view full details, and edit any attribute.

**Independent Test**: Open a collection → add a movie with all required fields → verify saved → open it → edit an optional field → verify persisted across reload.

### mc-service: Domain Layer (US2)

- [ ] T068 Write unit tests (RED) in `backend/mc-service/src/domain/movie.rs` `#[cfg(test)]` block: valid Movie construction, required fields enforced, owned=false clears ownedMedia, ripped=false clears ripQuality, ContentType/MediaFormat/USARating enum validation
- [ ] T069 Implement `backend/mc-service/src/domain/movie.rs`: `Movie` entity with `ContentType`, `MediaFormat`, `USARating` enums; `ExternalIdentifier` value object; enforce cross-field invariants (owned/ownedMedia, ripped/ripQuality) in setters; pass T068 (GREEN)
- [ ] T070 [P] Create `backend/mc-service/src/domain/external_id.rs`: `ExternalIdentifier` value object — `system: String`, `unique_id: String`, `url: Option<String>`; uniqueness-per-movie validation helper
- [ ] T071 [P] Write unit tests (RED) for all movie domain specifications in `backend/mc-service/src/domain/specifications/`: content_type.rs, media_format.rs, owned_media.rs (cross-field), rip_quality.rs (cross-field), movie_unique.rs
- [ ] T072 [P] Implement `backend/mc-service/src/domain/specifications/content_type.rs`: `ContentTypeValidSpec`
- [ ] T073 [P] Implement `backend/mc-service/src/domain/specifications/media_format.rs`: `MediaFormatValidSpec` (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray)
- [ ] T074 [P] Implement `backend/mc-service/src/domain/specifications/owned_media.rs`: `OwnedMediaWhenOwnedSpec` — `ownedMedia` must be empty when `owned = false`
- [ ] T075 [P] Implement `backend/mc-service/src/domain/specifications/rip_quality.rs`: `RipQualityWhenRippedSpec` — `ripQuality` must be empty when `ripped = false`
- [ ] T076 [P] Implement `backend/mc-service/src/domain/specifications/movie_unique.rs`: `MovieUniqueInCollectionSpec` placeholder (uniqueness enforced via MongoDB collation index at DB level; spec validates application-layer invariant)

### mc-service: Application Layer (US2)

- [ ] T077 Create `backend/mc-service/src/application/ports/movie_repository.rs`: `MovieRepository` trait — `create`, `get_by_id`, `update`, `delete`, `list`, `get_filter_options`; all return `Result<_, DomainError>`
- [ ] T078 [P] Create `backend/mc-service/src/application/dtos/movie_dto.rs`: `MovieDto` (all fields), `CreateMovieDto`, `UpdateMovieDto`; derive Serialize/Deserialize
- [ ] T079 Write unit tests (RED) in `backend/mc-service/src/application/commands/create_movie.rs` `#[cfg(test)]` block: valid creation, duplicate movie rejected, missing required field rejected, owned=false+ownedMedia rejected, ripped=false+ripQuality rejected, invalid ContentType rejected
- [ ] T080 Implement `backend/mc-service/src/application/commands/create_movie.rs`: `CreateMovieCommand` + Handler (validate via specs, call `repository.create`, return `MovieDto`); pass T079 (GREEN)
- [ ] T081 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/update_movie.rs` `#[cfg(test)]` block: full replacement, enum validation, cross-field invariants, duplicate title+year+contentType rejected
- [ ] T082 [P] Implement `backend/mc-service/src/application/commands/update_movie.rs`: `UpdateMovieCommand` + Handler (PUT — full replacement); pass T081 (GREEN)
- [ ] T083 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/get_movie.rs` `#[cfg(test)]` block: returns MovieDto for owner, CollectionNotFound, MovieNotFound
- [ ] T084 [P] Implement `backend/mc-service/src/application/queries/get_movie.rs`: `GetMovieQuery` + Handler; pass T083 (GREEN)

### mc-service: Adapters Layer (US2)

- [ ] T085 Write integration tests (RED) in `backend/mc-service/tests/integration/movies/`: `create_test.rs` (create + required fields + duplicate rejection), `get_test.rs` (get + not found), `update_test.rs` (full replace + validation)
- [ ] T086 Create `backend/mc-service/src/adapters/mongodb/daos/movie_dao.rs`: `MovieDao` BSON struct mapping all Movie fields including nested ExternalIdentifier; `From<MovieDao> for Movie` and reverse
- [ ] T087 Implement `backend/mc-service/src/adapters/mongodb/movie_repository.rs` — `create`, `get_by_id`, `update` methods: translate MongoDB E11000 → `DuplicateMovie`; pass T085 (GREEN)

### mc-service: API Layer (US2)

- [ ] T088 Write HTTP integration tests (RED) in `backend/mc-service/tests/integration/movies/`: create (201, 400 INVALID_INPUT, 400 OWNED_MEDIA_WHEN_NOT_OWNED, 400 RIP_QUALITY_WHEN_NOT_RIPPED, 404, 409 DUPLICATE_MOVIE), get (200, 404 COLLECTION_NOT_FOUND, 404 MOVIE_NOT_FOUND), update (200, all error codes), RFC 9457 format
- [ ] T089 [P] Implement `backend/mc-service/src/api/movies/create.rs`: `POST /api/v1/collections/:id/movies`
- [ ] T090 [P] Implement `backend/mc-service/src/api/movies/get.rs`: `GET /api/v1/collections/:id/movies/:movieId`
- [ ] T091 [P] Implement `backend/mc-service/src/api/movies/update.rs`: `PUT /api/v1/collections/:id/movies/:movieId`
- [ ] T092 Wire movie create/get/update routes into `backend/mc-service/src/api/router.rs`; pass T088 (GREEN)

### BFF: Movie Create/Get/Update Routes (US2)

- [ ] T093 Write unit tests (RED) for BFF movie routes in `frontend/mcm-app/tests/app/bff-api/collections/movies-index+api.test.ts` (POST) and `movies-movieId+api.test.ts` (GET, PUT): JWT forwarded, errors propagated, 401 without session
- [ ] T094 [P] Implement `POST` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/index+api.ts`: proxy create movie to mc-service
- [ ] T095 [P] Implement `GET` and `PUT` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/[movieId]+api.ts`: proxy get and update movie to mc-service
- [ ] T096 Ensure T093 tests pass (GREEN)

### Frontend: Movie Form & Detail (US2)

- [ ] T097 Write unit tests (RED) for `frontend/mcm-app/src/hooks/unit-tests/use-movies.test.ts` (create/get/update): create movie calls POST, update calls PUT, get movie called on screen mount, error states set
- [ ] T098 Implement `frontend/mcm-app/src/hooks/use-movies.ts` (create, get, update only): call BFF routes; manage movie state; pass T097 (GREEN)
- [ ] T099 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-form.test.tsx`: all required fields required, optional fields accepted, ContentType enum validated, owned=false hides ownedMedia, ripped=false hides ripQuality, submit calls handler
- [ ] T100 [P] Implement `frontend/mcm-app/src/components/movie-form.tsx`: full add/edit form for all movie attributes; conditional ownedMedia/ripQuality fields; inline validation messages; `testID` on all inputs
- [ ] T101 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-detail.test.tsx`: renders all Movie fields, shows Edit and Delete buttons
- [ ] T102 [P] Implement `frontend/mcm-app/src/components/movie-detail.tsx`: read-only view of all movie attributes; Edit navigates to MovieForm; Delete opens DeleteConfirmationDialog
- [ ] T103 Write unit tests (RED) for `frontend/mcm-app/src/screens/movies/movie-detail-screen.test.tsx`: renders MovieDetail, switches to edit mode on edit tap
- [ ] T104 Implement `frontend/mcm-app/src/screens/movies/movie-detail-screen.tsx`: renders MovieDetail; switches to MovieForm on edit; submit saves via use-movies hook; pass T103 (GREEN)
- [ ] T105 Create `frontend/mcm-app/src/app/(app)/collections/movies/[movieId].tsx` rendering MovieDetailScreen
- [ ] T106 Write E2E tests (RED): `tests/e2e/mobile/movie-add.yaml`, `movie-edit.yaml`; `tests/e2e/web/movies.spec.ts` (add movie all fields, edit optional field, invalid content type rejection, duplicate movie rejection)
- [ ] T107 Verify E2E tests pass (GREEN)

**Checkpoint**: User Stories 1 and 2 are both independently functional. Users can add movies to collections and edit them.

---

## Phase 5: User Story 3 — Browse, Search, and Filter Movies (Priority: P3)

**Goal**: Users can browse movies with infinite scroll, select display columns, perform free-text search, and apply dynamic filters.

**Independent Test**: Populate a collection with 5+ diverse movies → verify default columns → add a column → search by title substring → apply genre filter → apply decade filter → apply combined search+filter → verify each step returns the correct subset.

### mc-service: Application Layer (US3)

- [ ] T108 Write unit tests (RED) in `backend/mc-service/src/application/queries/list_movies.rs` `#[cfg(test)]` block: cursor pagination advances page, search term narrows results, each individual filter narrows results, combined search+filter intersects correctly, empty result set
- [ ] T109 Implement `backend/mc-service/src/application/queries/list_movies.rs`: `ListMoviesQuery` + Handler — cursor (Base64 ObjectId), search, contentType, genre (OR), childrens, rated, language, decade (year range), owned, ownedMedia (OR), ripped, ripQuality (OR); batch size 50; return `MovieListDto` with `nextCursor`; pass T108 (GREEN)
- [ ] T110 [P] Write unit tests (RED) in `backend/mc-service/src/application/queries/get_filter_options.rs` `#[cfg(test)]` block: returns only values present in collection for genres, ratings, languages, decades
- [ ] T111 [P] Implement `backend/mc-service/src/application/queries/get_filter_options.rs`: `GetFilterOptionsQuery` + Handler using MongoDB distinct queries; return `FilterOptionsDto`; pass T110 (GREEN)

### mc-service: Adapters Layer (US3)

- [ ] T112 Write integration tests (RED) in `backend/mc-service/tests/integration/movies/list_test.rs`: cursor advances through 50-movie batches, search returns matching titles, filters narrow correctly, filter-options returns only collection-present values; `search_filter_test.rs`: combined search+filter
- [ ] T113 Implement `MongoMovieRepository::list()` in `backend/mc-service/src/adapters/mongodb/movie_repository.rs`: keyset pagination (`_id > cursor`), `$text` search, all filter query params applied as match stage; return items + nextCursor; pass T112 list tests (GREEN)
- [ ] T114 [P] Implement `MongoMovieRepository::get_filter_options()`: MongoDB distinct queries for genres, rated, language, decade (derived from year); pass T112 filter-options tests (GREEN)

### mc-service: API Layer (US3)

- [ ] T115 Write HTTP integration tests (RED) in `backend/mc-service/tests/integration/movies/`: list with all query params, cursor pagination response shape (`nextCursor` null/present), filter-options shape, 404 COLLECTION_NOT_FOUND
- [ ] T116 [P] Implement `backend/mc-service/src/api/movies/list.rs`: `GET /api/v1/collections/:id/movies` — parse all query params, dispatch `ListMoviesQuery`
- [ ] T117 [P] Implement `backend/mc-service/src/api/movies/filter_options.rs`: `GET /api/v1/collections/:id/movies/filter-options` — dispatch `GetFilterOptionsQuery`
- [ ] T118 Wire list + filter-options routes into `backend/mc-service/src/api/router.rs`; pass T115 (GREEN)

### BFF: Movie List & Filter-Options Routes (US3)

- [ ] T119 Write unit tests (RED) in `frontend/mcm-app/tests/app/bff-api/collections/movies-index+api.test.ts` (GET list with query params) and `movies-filter-options+api.test.ts`: all query params forwarded, filter-options proxied
- [ ] T120 [P] Implement `GET` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/index+api.ts`: forward all list query params (cursor, search, contentType, genre, childrens, rated, language, decade, owned, ownedMedia, ripped, ripQuality) to mc-service
- [ ] T121 [P] Implement `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/filter-options+api.ts`: `GET` proxy to mc-service filter-options endpoint
- [ ] T122 Ensure T119 tests pass (GREEN)

### Frontend: Browse/Search/Filter (US3)

- [ ] T123 Write unit tests (RED) for `frontend/mcm-app/src/hooks/unit-tests/use-movies.test.ts` (list/search/filter additions): initial load calls BFF GET, `onEndReached` loads next page with cursor, search term change resets cursor + reloads, filter change resets cursor + reloads, column visibility state toggled correctly, filter-options fetched on mount
- [ ] T124 Update `frontend/mcm-app/src/hooks/use-movies.ts`: add infinite scroll (cursor state), search state (debounced), filter state, column visibility state, filter-options fetcher; pass T123 (GREEN)
- [ ] T125 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-list-item.test.tsx`: renders only visible columns, title always shown
- [ ] T126 [P] Implement `frontend/mcm-app/src/components/movie-list-item.tsx`: single row rendering configurable columns; `testID` per column cell
- [ ] T127 [P] Implement `frontend/mcm-app/src/components/movie-list.tsx` (web, scrollable div with intersection observer) and `frontend/mcm-app/src/components/movie-list.native.tsx` (FlatList with `onEndReached`); triggers next-page load; empty state when no results
- [ ] T128 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/column-selector.test.tsx`: renders all column options, toggle shows/hides column
- [ ] T129 [P] Implement `frontend/mcm-app/src/components/column-selector.tsx`: show/hide panel; default visible columns per FR-018; persists column state in hook
- [ ] T130 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-search-bar.test.tsx`: debounced input triggers search, clear resets
- [ ] T131 [P] Implement `frontend/mcm-app/src/components/movie-search-bar.tsx`: debounced text input (300ms); clears search on empty; `testID` on input
- [ ] T132 [P] Write unit tests (RED) for `frontend/mcm-app/src/components/unit-tests/movie-filter-panel.test.tsx`: loads filter-options on mount, renders chips/selects for each filter type, only shows options present in collection, applies filter on select
- [ ] T133 [P] Implement `frontend/mcm-app/src/components/movie-filter-panel.tsx`: collapsible panel; genre, rated, language, decade, contentType, childrens, owned, ownedMedia, ripped, ripQuality filters; each filter rendered from filter-options response
- [ ] T134 Write unit tests (RED) for `frontend/mcm-app/src/screens/collections/collection-screen.test.tsx`: renders MovieList + SearchBar + FilterPanel + ColumnSelector + "Add Movie" button, navigates to movie on tap
- [ ] T135 Implement `frontend/mcm-app/src/screens/collections/collection-screen.tsx`: compose MovieList + MovieSearchBar + MovieFilterPanel + ColumnSelector + "Add Movie" button; wire to use-movies hook; navigate to MovieDetailScreen on row tap; pass T134 (GREEN)
- [ ] T136 Update `frontend/mcm-app/src/app/(app)/collections/[collectionId].tsx` to render CollectionScreen (replace Phase 3 stub from T065)
- [ ] T137 Write E2E tests (RED): `tests/e2e/mobile/movie-browse.yaml`, `movie-search-filter.yaml`; expand `tests/e2e/web/movies.spec.ts` with browse, column selection, search, filter, combined search+filter scenarios
- [ ] T138 Verify E2E tests pass (GREEN)

**Checkpoint**: User Stories 1, 2, and 3 independently functional. Full browse/search/filter flow works on 10,000-movie collections within 3-second target.

---

## Phase 6: User Story 4 — Remove Movies from a Collection (Priority: P4)

**Goal**: Users can permanently delete a movie after explicitly confirming the irreversible warning.

**Independent Test**: Add a movie → initiate delete → verify warning dialog appears → confirm → verify movie no longer in list → add again → initiate delete → cancel → verify movie still present.

### mc-service: Application Layer (US4)

- [ ] T139 [P] Write unit tests (RED) in `backend/mc-service/src/application/commands/delete_movie.rs` `#[cfg(test)]` block: delete success returns Ok, CollectionNotFound, MovieNotFound
- [ ] T140 [P] Implement `backend/mc-service/src/application/commands/delete_movie.rs`: `DeleteMovieCommand` + Handler (verify collection ownership + movie exists, then delete); pass T139 (GREEN)

### mc-service: Adapters Layer (US4)

- [ ] T141 Write integration tests (RED) in `backend/mc-service/tests/integration/movies/delete_test.rs`: delete success (204), MOVIE_NOT_FOUND (404), COLLECTION_NOT_FOUND (404)
- [ ] T142 Implement `MongoMovieRepository::delete()` in `backend/mc-service/src/adapters/mongodb/movie_repository.rs`; pass T141 (GREEN)

### mc-service: API Layer (US4)

- [ ] T143 Write HTTP integration tests (RED) for `DELETE /api/v1/collections/:id/movies/:movieId`: 204 happy path, 401, 403, 404 COLLECTION_NOT_FOUND, 404 MOVIE_NOT_FOUND, RFC 9457 format
- [ ] T144 Implement `backend/mc-service/src/api/movies/delete.rs`: `DELETE /api/v1/collections/:id/movies/:movieId` → call `DeleteMovieCommand`, return 204
- [ ] T145 Wire movie delete route into `backend/mc-service/src/api/router.rs`; pass T143 (GREEN)

### BFF: Movie Delete Route (US4)

- [ ] T146 Write unit tests (RED) for `DELETE` in `frontend/mcm-app/tests/app/bff-api/collections/movies-movieId+api.test.ts`: 204 forwarded, 404 forwarded, 401 without session
- [ ] T147 Implement `DELETE` in `frontend/mcm-app/src/app/bff-api/collections/[collectionId]/movies/[movieId]+api.ts`: proxy delete to mc-service; pass T146 (GREEN)

### Frontend: Movie Delete (US4)

- [ ] T148 Write unit tests (RED) for delete flow in `frontend/mcm-app/src/screens/movies/movie-detail-screen.test.tsx`: delete tap opens DeleteConfirmationDialog, confirm calls delete mutation + navigates back, cancel closes dialog + movie unchanged
- [ ] T149 Update `frontend/mcm-app/src/screens/movies/movie-detail-screen.tsx`: open DeleteConfirmationDialog on delete tap; on confirm call delete via use-movies hook then navigate back; pass T148 (GREEN)
- [ ] T150 Update `frontend/mcm-app/src/hooks/use-movies.ts`: add `deleteMovie` mutation calling BFF DELETE endpoint; optimistic list removal
- [ ] T151 Write E2E tests (RED): `tests/e2e/mobile/movie-delete.yaml`; expand `tests/e2e/web/movies.spec.ts` with delete + cancel scenarios
- [ ] T152 Verify E2E tests pass (GREEN)

**Checkpoint**: All four user stories independently functional. Full feature end-to-end.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Quality, observability, and documentation across all stories.

- [ ] T153 [P] Add `logger.audit` calls to BFF collection and movie routes for security events: 401 (auth failure), 403 (access denied); update `frontend/mcm-app/src/bff-server/mc-service-client.ts` to log failed mc-service calls
- [ ] T154 [P] Add `tracing` audit spans to mc-service API layer for 401/403 events and all mutating operations; ensure correlation ID propagated to all log entries in `backend/mc-service/src/api/middleware/logging.rs`
- [ ] T155 [P] Run `pnpm nx lint mc-service` (cargo clippy --deny warnings); fix all warnings in `backend/mc-service/src/`
- [ ] T156 [P] Run `cargo fmt --check` on `backend/mc-service/`; apply formatting
- [ ] T157 [P] Run `cargo audit` on `backend/mc-service/`; remediate any moderate or higher vulnerabilities
- [ ] T158 [P] Verify ≥70% unit test line coverage for `backend/mc-service/src/` via `pnpm nx test mc-service -- --workspace`
- [ ] T159 [P] Verify ≥70% unit test line coverage for new `frontend/mcm-app/src/` additions via `pnpm nx test mcm-app`
- [ ] T160 [P] Validate `api-specs/mc-service-api.yaml` matches implementation exactly; update any fields that diverged during implementation
- [ ] T161 [P] Update `docs/MCM-Architecture.md` to reflect mc-service, mc-db, and `infrastructure-as-code/docker/mc-service/compose.yaml` additions
- [ ] T162 Follow `specs/002-manage-movie-collection/quickstart.md` to validate the full stack starts correctly; document any gaps found

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

```
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
