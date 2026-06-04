# Phase 1 Data Model: Clean DAC Foundation

**No stored-schema change, no index change, no migration.** This feature changes authorization behavior and the meaning/stamping of an existing field. The entities below already exist; the additions are a Domain behavior and a clarified invariant.

## MovieCollection (Domain aggregate)

Existing fields (unchanged): `id`, `owner_id`, `name`, `description`, `is_default`, `acl: Vec<AclEntry>`.

**Added behavior**:

| Method | Signature | Rule |
| --- | --- | --- |
| `authorizes` | `fn authorizes(&self, user_id: &str, required: AclRole) -> bool` | True iff some `AclEntry` for `user_id` has a role of rank ≥ `required`'s rank, with `Owner=3 > Contributor=2 > Viewer=1`. |

- The ACL is seeded at creation with a single `{ user_id: owner_id, role: Owner }` entry (already implemented). No new entries are written by this feature (granting is out of scope).

## AclEntry / AclRole (Domain value objects)

Existing (unchanged shape): `AclEntry { user_id: String, role: AclRole }`, `AclRole { Owner, Contributor, Viewer }` (serialized lowercase).

**Role hierarchy (invariant used by `authorizes`)**: `Owner ⊇ Contributor ⊇ Viewer`. Required levels: **writes → Contributor**, **reads → Viewer**. The owner satisfies both via the hierarchy.

## Movie (Domain entity)

Existing fields unchanged. **Clarified invariant**:

| Field | Invariant (this feature) |
| --- | --- |
| `owner_id` | MUST equal the parent collection's `owner_id`. Set on every create/update from the loaded collection, never from the acting user. Fix-on-write only (no back-fill of existing rows; none are drifted today). |

## Uniqueness (unchanged)

Movie uniqueness scope stays per collection: `{ collectionId, title, year, contentType }`. **MUST NOT** be narrowed to include `ownerId` (would break shared-collection uniqueness — see research R6).

## Repository ports (interfaces — not data)

- **`CollectionRepository::find_by_id(id) -> Result<MovieCollection, DomainError>`** *(new)*: by-id-only load of the Domain aggregate (incl. `acl`, `owner_id`) for authorization; `CollectionNotFound` if absent. Distinct from the existing owner-scoped `get_by_id(id, owner_id) -> CollectionDto`.
- **`MovieRepository`** *(signatures change)*: `get_by_id`, `list`, `get_filter_options`, `delete` drop the per-caller `owner_id` parameter (query by `collectionId`[`/movieId`]); `create`/`update` receive the **collection owner** to stamp `movie.ownerId`.

## Authorization decision (transient, per request)

Not persisted. Computed in each movie handler:

1. `collection = collection_repo.find_by_id(collection_id)?` → `CollectionNotFound` (404) if missing.
2. `collection.authorizes(caller_id, required_role)` → false ⇒ return `CollectionNotFound` (404, no existence leak).
3. Proceed; for writes, stamp `movie.ownerId = collection.owner_id`.
