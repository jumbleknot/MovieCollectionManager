---
description: "Task list for Clean DAC Foundation (011)"
---

# Tasks: Clean DAC Foundation

**Input**: Design documents from `/specs/011-clean-dac/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/contract-deltas.md](contracts/contract-deltas.md), [quickstart.md](quickstart.md)

**Tests**: REQUIRED — TDD is non-negotiable. Every test task carries a Verify RED; every paired implementation task carries a Verify GREEN.

**Scope**: Backend only — `mc-service` (Clean Architecture). No BFF/client/frontend changes (enforcement is mc-service-only, clarified). No DB schema/index change, no migration. No new endpoints or DTOs. Single-client backend feature → no Platform Parity Table.

**Invocation**: Nx is the primary path. Unit: `pnpm nx test mc-service -- <name>`. Integration (real replica-set MongoDB): `pnpm nx test:integration mc-service -- --test <file>`. (The `@monodon/rust` executor passes args after `--` to cargo.)

---

## Phase 1: Setup

- [x] T001 Confirm the baseline before changing anything: replica-set MongoDB up (`pnpm nx up-keycloak infrastructure-as-code`), and `pnpm nx test mc-service` + `pnpm nx test:integration mc-service` are green, so any later failure is attributable.
- [x] T002 [P] Confirm RTK is active (`rtk gain` works) per the constitution Token Compression requirement.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The DAC primitives every user story depends on — the domain authorization method, the by-id collection load, and the shared handler helper. **No user story can begin until this phase is complete.**

- [x] T003 **Test (RED)** — `MovieCollection::authorizes` role hierarchy, inline `#[cfg(test)]` in `backend/mc-service/src/domain/collection.rs`. Spec: FR-009. Assert: owner satisfies Contributor and Viewer; contributor satisfies Viewer but not Owner; viewer satisfies only Viewer; a user absent from the ACL satisfies nothing.
  - **Verify RED**: `pnpm nx test mc-service -- authorizes` → fails to compile / method missing.
- [x] T004 **Impl (GREEN)** — add `pub fn authorizes(&self, user_id: &str, required: AclRole) -> bool` to `MovieCollection` in `backend/mc-service/src/domain/collection.rs` using rank `Owner=3 > Contributor=2 > Viewer=1` (any ACL entry for `user_id` with rank ≥ required). Prerequisite: T003 RED.
  - **Verify GREEN**: `pnpm nx test mc-service -- authorizes` → all pass.
- [x] T005 **Port + adapter + integration test** — add `find_by_id(id: &str) -> Result<MovieCollection, DomainError>` (by-id only, returns the domain aggregate incl. `acl`+`owner_id`, `CollectionNotFound` if absent) to `backend/mc-service/src/application/ports/collection_repository.rs`; implement it in `backend/mc-service/src/adapters/mongodb/collection_repository.rs` (DAO→domain mapping incl. acl). Add integration test `backend/mc-service/tests/integration/collections/find_by_id_test.rs` asserting it returns the aggregate for any caller (owner and non-owner) and `CollectionNotFound` for a missing id. Spec: research R2.
  - **Verify RED→GREEN**: `pnpm nx test:integration mc-service -- --test find_by_id` (RED before adapter impl → GREEN after).
- [x] T006 **Helper (unit test RED → impl GREEN)** — add `authorize_collection_access(collection_repo, collection_id, caller_id, required: AclRole) -> Result<MovieCollection, DomainError>` in a new Application-Layer module `backend/mc-service/src/application/access_control.rs` (loads via `find_by_id`, returns the collection when `authorizes` holds, else `CollectionNotFound`). Unit-test with a `mockall` `CollectionRepository`: authorized → Ok(collection); unauthorized → `CollectionNotFound`; missing → `CollectionNotFound`. Prerequisite: T004, T005.
  - **Verify RED**: `pnpm nx test mc-service -- authorize_collection_access` → method missing.
  - **Verify GREEN**: same → all pass.

**Checkpoint**: DAC primitives ready — user stories can begin.

---

## Phase 3: User Story 1 — Movie writes authorized against the collection (Priority: P1) 🎯 MVP

**Goal**: create/update/delete a movie require **contributor** access; unauthorized/missing collection → 404, nothing written. Owner unchanged. Closes the finding #2 IDOR.

**Independent Test**: As user B (not on A's collection), create/update/delete a movie in A's collection → 404, no write. As A → success. Duplicate in A's collection still rejected.

- [x] T007 [US1] **Test (RED)** — `backend/mc-service/tests/integration/movies/dac_write_authorization_test.rs` (real MongoDB, two real users; no mocking). Spec: US1-AC1..AC4, FR-001/002/006/007/008. Assert: user B create/update/delete in A's collection → `404` (`COLLECTION_NOT_FOUND`) and no movie written/changed; write to a non-existent collection id → `404`; user A create/update/delete → success; a duplicate `{title, year, contentType}` in A's collection → still rejected (`DuplicateMovie`).
  - **Verify RED**: `pnpm nx test:integration mc-service -- --test dac_write_authorization` → B's writes currently SUCCEED (IDOR) — test fails.
- [x] T008 [US1] **Impl (GREEN)** — Prerequisite: T006, T007 RED. In `create_movie.rs`, `update_movie.rs`, `delete_movie.rs` (under `backend/mc-service/src/application/commands/`): inject `Arc<dyn CollectionRepository>`, call `authorize_collection_access(..., AclRole::Contributor)` before any write, and for create/update stamp `movie.ownerId = collection.owner_id`. Update `MovieRepository` (`ports/movie_repository.rs` + `adapters/mongodb/movie_repository.rs`): `delete` drops the per-caller `owner_id` (delete by `{collectionId, movieId}`); `create`/`update` use the passed **collection owner** for `ownerId`. Update the handler unit-test `mockall` definitions + call sites. Wire `Arc::clone(&collection_repo)` into the three handlers in `backend/mc-service/src/api/router.rs`.
  - **Verify GREEN**: `pnpm nx test:integration mc-service -- --test dac_write_authorization` → all pass.
  - **Also run** (regression): `pnpm nx test mc-service -- create_movie` and `-- update_movie` and `-- delete_movie` → handler unit tests still pass.

**Checkpoint**: Cross-tenant write IDOR closed; US1 shippable as MVP.

---

## Phase 4: User Story 2 — Movie reads authorized by collection access (Priority: P2)

**Goal**: get/list/filter-options require **viewer** access; reads scoped by collection access (query by `collectionId`), not by caller-identity matching. Owner reads unchanged; a seeded viewer can read.

**Independent Test**: As A, list/filter/get movies → identical to today. As B → 404. With a test-seeded viewer ACL entry, B can read.

- [x] T009 [US2] **Test (RED)** — `backend/mc-service/tests/integration/movies/dac_read_authorization_test.rs` (real MongoDB). Spec: US2-AC1..AC3, FR-003/004. Assert: A's list/filter/get return the same data as today; B (unauthorized) list/filter/get → `404`; after seeding `{ userId: B, role: viewer }` into A's collection ACL, B's list/get succeed.
  - **Verify RED**: `pnpm nx test:integration mc-service -- --test dac_read_authorization` → seeded-viewer read currently returns empty/404 (owner-predicate excludes B) — test fails.
- [x] T010 [US2] **Impl (GREEN)** — Prerequisite: T006, T009 RED. In `get_movie.rs`, `list_movies.rs`, and the filter-options query handler (under `backend/mc-service/src/application/queries/`): inject `Arc<dyn CollectionRepository>`, call `authorize_collection_access(..., AclRole::Viewer)` before querying. Update `MovieRepository` (`get_by_id`, `list`, `get_filter_options`) to drop the per-caller `owner_id` and query by `collectionId`[`/movieId`]; update the adapter + the handler `mockall` definitions/call sites. Wire `Arc::clone(&collection_repo)` into the three read handlers in `backend/mc-service/src/api/router.rs`.
  - **Verify GREEN**: `pnpm nx test:integration mc-service -- --test dac_read_authorization` → all pass.
  - **Also run** (regression): `pnpm nx test mc-service -- get_movie` / `-- list_movies` and `pnpm nx test:integration mc-service -- --test list_test` (existing movie list/search/filter integration) → still pass.

**Checkpoint**: Reads authorized by collection access; sharing seam in place.

---

## Phase 5: User Story 3 — Movie owner reference always means the collection owner (Priority: P3)

**Goal**: every write sets `movie.ownerId` to the collection owner, never the acting user. Fix-on-write only.

**Independent Test**: After any create/update, the movie's `ownerId` equals the collection owner; a seeded contributor's write still yields `ownerId` = collection owner.

- [x] T011 [US3] **Test (RED)** — `backend/mc-service/tests/integration/movies/dac_owner_reference_test.rs` (real MongoDB). Spec: US3-AC1/AC2, FR-005. Assert: after owner create/update, the stored movie's `ownerId` == the collection owner; after seeding `{ userId: B, role: contributor }` and having B create/update a movie, the stored movie's `ownerId` == the collection owner (A), not B.
  - **Verify RED**: `pnpm nx test:integration mc-service -- --test dac_owner_reference` → before T012, a contributor's write stamps B (or the test can't run until US1 write path exists) — fails.
- [x] T012 [US3] **Impl (GREEN)** — Prerequisite: T008 (write path), T011 RED. Confirm/ensure `create_movie` and `update_movie` set `movie.ownerId = collection.owner_id` (implemented in T008); adjust if the stamp was missed on the update path. No repository signature change beyond T008/T010.
  - **Verify GREEN**: `pnpm nx test:integration mc-service -- --test dac_owner_reference` → all pass.

**Checkpoint**: Owner reference uniform per collection; DAC seam fully verified (SC-006 covered by the seeded contributor/viewer cases in T009/T011).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T013 [P] Documentation — update the movie route descriptions in `/api-specs` (mc-service OpenAPI) to note that movie operations require collection access and return `404` (`COLLECTION_NOT_FOUND`) when missing/unauthorized. No schema/shape change. **Done when**: the OpenAPI movie paths document the authorization + 404 behavior.
- [x] T014 [P] `pnpm nx lint mc-service` (clippy, no warnings) and `cargo fmt --check`. Expected: clean.
- [x] T015 Coverage ≥70%: `cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --ignore-tests --out Lcov`. Expected: ≥70% line coverage.
- [x] T016 Full regression: `pnpm nx test mc-service` (unit) and `pnpm nx test:integration mc-service` (all movie + collection integration). Expected: green — owner behavior unchanged. Then `rtk gain` (>80%).
- [x] T017 Run [quickstart.md](quickstart.md) end-to-end and confirm each user story's checks.

---

## Dependencies & Execution Order

- **Setup (T001–T002)**: first.
- **Foundational (T003–T006)**: BLOCKS all stories. Order: T003→T004 (authorizes); T005 (find_by_id); T006 (helper, needs T004+T005).
- **US1 (T007–T008)**: after Foundational. T007 RED → T008 GREEN.
- **US2 (T009–T010)**: after Foundational. T009 RED → T010 GREEN. Independent of US1, but both edit `ports/movie_repository.rs`, the adapter, and `router.rs` — run US1 then US2 sequentially (same-file edits), not in parallel.
- **US3 (T011–T012)**: after US1 (reuses the write path). T011 RED → T012 GREEN.
- **Polish (T013–T017)**: after the stories. T013/T014 are `[P]`.

### Parallel opportunities

- T002 `[P]`; T013 + T014 `[P]` (different files). The story phases largely serialize because they share `ports/movie_repository.rs`, the Mongo adapter, and `router.rs`. The three foundational items T003/T004 vs T005 touch different files and could overlap, but T006 needs both.

---

## Implementation Strategy

- **MVP**: Setup → Foundational → US1 (closes the cross-tenant write IDOR — the security fix). Ship/demo.
- **Increment 2**: US2 (read authorization → sharing seam).
- **Increment 3**: US3 (owner-reference integrity) — small, builds on US1's write path.

---

## Completion Checklist

Before marking `011-clean-dac` complete, verify all success criteria from [spec.md](spec.md):

- [x] **SC-001**: Unauthorized create/update/delete/list all denied with `CollectionNotFound` (404), nothing written — `dac_authorization` integration suite.
- [x] **SC-002**: The collection owner retains full movie CRUD; existing suites identical (movies 102 + collections 23 integration green).
- [x] **SC-003**: After any write, the stored `ownerId` equals the collection owner (`owner_reference_is_collection_owner_on_owner_write`).
- [x] **SC-004**: Duplicate movie still rejected (`owner_retains_full_write_access` asserts `DuplicateMovie`); uniqueness unchanged.
- [x] **SC-005**: No regressions — full `cargo test` 255 passed / 0 failed / 21 ignored.
- [x] **SC-006**: Seeded viewer reads but cannot write; seeded contributor write stamps the collection owner — same guards, no code change (`seeded_viewer_can_read_but_not_write`, `seeded_contributor_write_stamps_collection_owner_not_contributor`).
- [x] All test tasks used the TDD checkpoint format (authorizes RED→GREEN; write-authz integration RED on the pre-fix IDOR → GREEN)
- [x] `pnpm nx test mc-service` — unit tests pass (126)
- [x] `pnpm nx test:integration mc-service` — integration tests pass (real replica-set MongoDB; 125 across movies+collections)
- [x] `pnpm nx lint mc-service` — no clippy warnings (clean) + `cargo fmt --check` clean
- [x] **Full-stack web E2E regression** — rebuilt + redeployed mc-service (new image), then `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → **93/93 (54.8s)**. Required even though 011 is backend-only (owner happy path unbroken through BFF → mc-service).
- [x] coverage ≥70% (cargo tarpaulin) — 76.16% (540/709 lines)
- [x] `rtk gain` — active; >80% compression confirmed
