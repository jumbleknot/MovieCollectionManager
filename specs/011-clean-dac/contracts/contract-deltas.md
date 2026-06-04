# Contract Deltas: Clean DAC Foundation

**No external API schema change.** All `/api/v1/collections/{collectionId}/movies...` endpoints keep their request/response shapes and already declare `404`. The deltas are behavioral (authorization + which cases now 404) plus one new internal repository port. `/api-specs` route descriptions get a documentation touch only.

---

## External API — behavioral deltas (mc-service `/api/v1`)

All require the existing authn + application-role (mc-user/mc-admin) layer first (unchanged). The **new** check is per-collection ACL authorization.

### Movie writes — `POST/PUT/DELETE /collections/{collectionId}/movies[/{movieId}]`
- **Before**: create stamped the caller as `ownerId` with **no** collection-ownership check (cross-tenant IDOR); update/delete were scoped to `{ collectionId, movieId, ownerId=caller }`.
- **After**: the caller MUST have **contributor** access on the collection (owner qualifies). Missing collection OR unauthorized ⇒ `404` (`COLLECTION_NOT_FOUND`), indistinguishable, before any write. On success, `movie.ownerId` = the collection owner.
- **Contract**: foreign-collection write ⇒ `404`, nothing written. Owner write ⇒ unchanged success. Duplicate `{title, year, contentType}` in the collection ⇒ still rejected (uniqueness unchanged).

### Movie reads — `GET /collections/{collectionId}/movies`, `.../movies/{movieId}`, `.../movies/filter-options`
- **Before**: scoped by `{ collectionId, ownerId=caller }` (owner-only by query predicate).
- **After**: the caller MUST have **viewer** access (contributor/owner qualify); then movies are returned for the collection (queried by `collectionId`). Missing/unauthorized ⇒ `404`.
- **Contract**: owner read ⇒ identical results to today. Unauthorized read ⇒ `404`. A seeded viewer/contributor ⇒ can read (same path, no query rework).

---

## Internal port — new (Application-Layer)

### `CollectionRepository::find_by_id(id: &str) -> Result<MovieCollection, DomainError>`
- By-id-only load of the Domain aggregate (incl. `acl`, `owner_id`); `CollectionNotFound` if absent.
- Distinct from owner-scoped `get_by_id(id, owner_id) -> CollectionDto` (which can't authorize a non-owner and lacks the acl).

### `MovieRepository` — handler now passes the collection owner (signatures unchanged)
- **Implemented (2026-06-04):** the `MovieRepository` signatures are **unchanged**; instead every movie handler authorizes via the ACL helper and then passes **`collection.owner_id`** (the collection owner, resolved after authorization) as the `owner_id` argument to all repo calls — never the caller's identity. The existing `{ collectionId, ownerId }` predicate therefore returns exactly the collection's movies (every movie shares the collection owner per FR-005), and create/update stamp `movie.ownerId = collection.owner_id`. This satisfies FR-004 with much lower churn than removing the parameter (see research R3 deviation note).

---

## Shared helper (Application-Layer)

`authorize_collection_access(collection_repo, collection_id, caller_id, required: AclRole) -> Result<MovieCollection, DomainError>`: loads the collection (`find_by_id`) and returns it when `authorizes(caller_id, required)` holds, else `CollectionNotFound`. Every movie handler calls it (uniform, hard to omit).

---

## Verification

- Real-MongoDB integration tests (no mocking the DB): cross-tenant write denied (404, nothing written), cross-tenant read denied (404), owner full CRUD unchanged, seeded-contributor write allowed, seeded-viewer read-only, owner-ref = collection owner after write, duplicate still rejected.
- Handler unit tests (`mockall`) updated for the new `CollectionRepository` dependency + changed `MovieRepository` signatures.
- No OpenAPI schema change; `/api-specs` movie route descriptions note the collection-access requirement + 404.
