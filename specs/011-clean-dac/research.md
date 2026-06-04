# Phase 0 Research: Clean DAC Foundation

No blocking unknowns — the stack, the existing ACL shape (`MovieCollection.acl`, `AclRole {Owner, Contributor, Viewer}`), and the two scope decisions (mc-service-only enforcement; fix-on-write owner reference) are settled by the spec + clarifications. This records the HOW decision per area.

---

## R1 — Authorization placement & role hierarchy (US1/US2, FR-001/003/008/009)

**Decision**: Add a Domain-Layer method `MovieCollection::authorizes(&self, user_id: &str, required: AclRole) -> bool`. It scans `self.acl` and returns true if any entry for `user_id` has a role whose rank ≥ the required rank, where rank is `Owner=3 > Contributor=2 > Viewer=1` (owner ⊇ contributor ⊇ viewer). Each movie Application-Layer handler calls it after loading the parent collection: **Contributor** for create/update/delete, **Viewer** for get/list/filter-options.

**Rationale**: The constitution puts validation in the Specification pattern but explicitly assigns "least privilege controls (authorization, RBAC)" to the **Application-Layer**, with domain rules expressed as aggregate behavior. `authorizes` is behavior on the `MovieCollection` aggregate (Domain); the handler orchestrates (Application). The hierarchy means adding contributor/viewer ACL entries later needs zero guard changes (FR-009).

**Alternatives rejected**: a `Specification<MovieCollection>` for authz (the constitution reserves Specifications for *validation*, not access control or queries); an owner-equality check `collection.owner_id == caller` (rejects future contributors — the exact throwaway the PRD warns against); enforcing in the API-Layer handler body directly (scatters logic, no reusable aggregate behavior).

---

## R2 — Loading the collection for authorization (R-dependency)

**Decision**: Add `CollectionRepository::find_by_id(id: &str) -> Result<MovieCollection, DomainError>` — a **by-id-only** load returning the Domain aggregate (including `acl` and `owner_id`), `CollectionNotFound` if absent. Movie handlers use it purely to authorize.

**Rationale**: The existing `get_by_id(id, owner_id)` is **owner-scoped** (filters by caller) and returns a `CollectionDto` (no acl) — it would 404 for a legitimate non-owner viewer/contributor and lacks the acl needed to authorize. A by-id load returning the aggregate is the minimal correct primitive and keeps repositories returning Domain objects (Clean Architecture).

**Alternatives rejected**: reuse `get_by_id(id, caller)` (structurally excludes shared access — the whole point of DAC); return a DTO and re-hydrate acl in the handler (leaks adapter mapping into the Application-Layer).

---

## R3 — Read-query rework: drop the per-caller `ownerId` predicate (US2, FR-004)

**Decision**: After the ACL check, movie reads (`get_by_id`, `list`, `get_filter_options`) and `delete` query by `{ collectionId }` (+ `movieId` where applicable), **not** `{ collectionId, ownerId=caller }`. The `owner_id` parameter is removed from these `MovieRepository` methods.

**Rationale**: The current `ownerId=caller` predicate is what blocks sharing and conflates authorization with the query. Moving authorization into the handler (R1) and querying by collection makes reads correct for owner-only today and shared access later, with no further query rework. It is also robust to any `ownerId` drift (a row whose stored owner ≠ collection owner is still returned), which a "pass collection owner into the predicate" shortcut would silently hide.

**Alternatives rejected**: keep `{ collectionId, ownerId }` but pass `collection.owner_id` instead of the caller (works only while no drift exists; leaves a misleading dead parameter; hides drifted rows); filter in application code after fetching all (wasteful, breaks keyset pagination).

---

## R4 — Owner-reference stamping on writes (US3, FR-005)

**Decision**: `create` and `update` set `movie.ownerId = collection.owner_id` (resolved from the loaded collection), regardless of the acting user. The create/update repository methods take the collection owner for this purpose (the handler passes `collection.owner_id`). Fix-on-write only — no back-fill (clarification).

**Rationale**: Keeps `ownerId` uniform per collection (a valid fast "whose collection" filter + audit field) and unambiguous once collections are shared. Today the acting user is the owner, so this is behavior-preserving; it becomes meaningful when contributors exist.

**Alternatives rejected**: `ownerId = acting user` (mixed-owner movies in a shared collection — breaks per-collection invariants); a one-time migration to back-fill (dead work — no drift exists today; explicitly out of scope).

---

## R5 — Unauthorized → 404 (no existence leak) (FR-002, US1/US2)

**Decision**: A missing collection AND an unauthorized caller both return `DomainError::CollectionNotFound`, which the existing `error_handler` maps to **404**. No 403, no new error variant.

**Rationale**: The 404 mapping already exists; returning it for "not authorized" avoids leaking whether a collection exists — consistent with the 009 convention. A distinct 403 would confirm existence to an unauthorized caller.

**Alternatives rejected**: 403 Forbidden (leaks existence); a new `Unauthorized`/`Forbidden` domain variant (unnecessary — `CollectionNotFound` already conveys the safe outcome).

---

## R6 — No uniqueness-index change, no migration (FR-007)

**Decision**: Keep the movie uniqueness scope per collection (`{ collectionId, title, year, contentType }`). Do not add `ownerId`. No data migration.

**Rationale**: With write authorization (R1) and uniform `ownerId` (R4), the existing per-collection key already behaves correctly; adding `ownerId` would weaken uniqueness to per-(collection, owner) and create a DAC regression for shared collections. The PRD records this as an explicit "do not implement."

---

## R7 — Centralized-access-control tension (constitution)

**Decision**: Keep authn + application-role in the centralized Tower layer (unchanged); implement per-collection DAC as a single shared Application-Layer helper `authorize_collection_access(collection_repo, collection_id, caller, required_role) -> Result<MovieCollection, DomainError>` that every movie handler calls. Cover each operation with an integration test.

**Rationale**: Resource-level (per-record) authorization cannot be a blanket pre-route middleware — it depends on the specific resource. The constitution assigns it to the Application-Layer. A single shared helper makes the check uniform and hard to omit (the omission risk the "centralized" principle guards against), and the per-operation tests fail if a handler forgets it.

**Alternatives rejected**: per-handler ad-hoc checks (drift/omission risk); attempting a generic middleware (cannot know the resource's ACL before the handler resolves the id).

---

## Cross-cutting decisions

- **Test-first (FR-010)**: each slice gets a failing integration test first (cross-tenant write denied, cross-tenant read denied, owner allowed, seeded-contributor write, seeded-viewer read-only, owner-ref = collection owner), then the implementation turns it green.
- **No regressions**: existing mc-service unit + integration suites (movies, collections) are the regression gate; the handler unit tests' `mockall` mocks gain the new `CollectionRepository` dependency + the changed `MovieRepository` signatures.
- **API-specs**: no schema change; update the affected route descriptions in `/api-specs` to note that movie operations require collection access and return 404 otherwise (documentation task).
