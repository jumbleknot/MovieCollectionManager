# PRD: Clean DAC Foundation — Movie Write Authorization & Owner-Scoped Reads

**Status**: Draft proposal
**Author**: review follow-up (derived from `docs/PRD-MCMFullRepoReview.md` finding #2, deferred from feature `009-review-remediation`)
**Related**: [MCM-Architecture.md §Discretionary Access Control (DAC)](MCM-Architecture.md#L47-L53), [PRD-MCMFullRepoReview.md #2](PRD-MCMFullRepoReview.md)

## Problem

`mc-service` lets any authenticated `mc-user` write a movie into **any** collection by passing its `collectionId` — the create path stamps the caller's id as the movie's `ownerId` and never checks that the caller owns (or is authorized for) the target collection ([api/movies/create.rs](../backend/mc-service/src/api/movies/create.rs) → [application/commands/create_movie.rs](../backend/mc-service/src/application/commands/create_movie.rs) → [adapters/mongodb/movie_repository.rs `create`](../backend/mc-service/src/adapters/mongodb/movie_repository.rs)). This is the IDOR (Insecure Direct Object Reference) described as finding #2. Reads are owner-scoped, so an injected movie isn't *visible* to the victim, but it still causes a cross-tenant denial of service via the movie uniqueness index and pollutes the data store with orphan rows.

The target end-state is the **DAC** model already documented for the product: a collection has one **owner** and 0+ **contributors** (view + update) and 0+ **viewers** (view), enforced from the `movie_collections.acl` array. Today only the `owner` ACL entry is written and nothing enforces the ACL yet.

The remediation of #2 and the implementation of DAC are the **same access-control change**. This PRD specifies the foundation so #2 is fixed *as* the first slice of DAC rather than with a throwaway owner-equality check that DAC would later have to tear out.

## Goals

1. **Authorize movie writes against the collection's ACL** (today: owner-only) instead of trusting the `collectionId` in the request.
2. **Authorize movie reads against the ACL** instead of the current `ownerId` shortcut, so sharing can be added without re-plumbing every query.
3. **Fix the canonical meaning of `movie.ownerId`** so the denormalization stays coherent once collections are shared.
4. Leave a clean seam for contributor/viewer roles with **no schema migration of the uniqueness index** required later.

## Non-Goals

- Implementing contributor/viewer **granting/revoking** UI or endpoints (that is the full DAC feature; this PRD is its access-control foundation).
- Changing rate limiting, sessions, or any other `009` finding.
- Re-keying the movie uniqueness index (see "Explicitly Out of Scope").

---

## Proposal

### Part 1 — Authorize movie writes against the ACL (the #2 fix, DAC-ready)

Replace the missing/owner-equality check with an **ACL authorization check** at the point a movie is created, updated, or deleted. The check asks "is the caller authorized on this collection at the required level?", not "is the caller the owner?".

- Add a domain helper on the collection, e.g. `Collection::authorizes(user_id, required: Role) -> bool`, that scans `acl: [{ userId, role }]` with the role hierarchy `owner ⊇ contributor ⊇ viewer`.
  - Writes (create/update/delete movie) require **contributor**.
  - Reads (get/list/filter movies) require **viewer**.
- The movie command/query handlers load the parent collection and call `authorizes(...)` before any movie operation. An unauthorized (or non-existent) collection returns **404 Not Found** — consistent with the existing "don't leak existence" convention from `009`.
- **Today's behavior is unchanged for users**: the ACL contains only `{ userId: ownerId, role: "owner" }`, so `authorizes(owner, contributor)` is true and everyone else is 404 — i.e., exactly today's intended owner-only semantics, now actually enforced on the create path too.

> **Why an ACL check, not `owner_id == caller`:** a hardcoded owner-equality check would reject a legitimate contributor once sharing lands and would have to be ripped out. The ACL check is the *same enforcement point* DAC needs; building it now means DAC is "add roles to the ACL + expose grant/revoke", not "re-find and rewrite every guard".

### Part 2 — Read authorization (`{collectionId, ownerId}` → ACL check)

The movie read filter is currently `{ collectionId, ownerId }` ([movie_repository.rs `list`/`get_by_id`](../backend/mc-service/src/adapters/mongodb/movie_repository.rs)). Under sharing, a viewer/contributor is **not** the owner, so an `ownerId` predicate on reads structurally excludes shared access.

- Move authorization out of the Mongo predicate and into the handler: verify `collection.authorizes(caller, Role::Viewer)` (404 otherwise), then query movies by **`collectionId` alone** (plus the existing pagination/filter predicates).
- This makes reads correct for owner-only today and for shared access later, with no further query rework.

### Part 3 — Decision: `movie.ownerId` always means **collection owner**, never the contributor

Fix the canonical meaning of the denormalized field:

- **`movie.ownerId` == the owner of the movie's parent collection.** It is *not* "the user who created/edited the movie."
- On create/update, the handler sets `movie.ownerId = collection.ownerId` (derived from the loaded collection), regardless of which authorized user performs the write.

Rationale:
- Keeps every movie in a collection uniform (`ownerId` is constant across the collection), so the field remains a valid fast "whose collection is this" filter and an attribution/audit field tied to the data's owner.
- Avoids mixed-owner movies inside one shared collection, which would otherwise break per-collection invariants and make the uniqueness scope ambiguous.
- "Who last touched this movie" is a separate concern; if needed later, capture it as an explicit `lastModifiedBy` field — do **not** overload `ownerId`.

---

## Explicitly Out of Scope — do **not** add `ownerId` to the movie uniqueness index

The movie uniqueness index is `{ collectionId, title, year, contentType }` ([adapters/mongodb/indexes.rs](../backend/mc-service/src/adapters/mongodb/indexes.rs)). A tempting "defense-in-depth" for #2 is to re-key it to include `ownerId`. **This is intentionally NOT to be implemented**, because it conflicts with DAC:

- The correct uniqueness scope under sharing is **per-collection** — a shared collection must not hold two identical movies *regardless of which contributor added one*.
- Adding `ownerId` to the key would weaken that to per-(collection, owner). Combined with any future move toward creator-scoped ids, two contributors could each insert the same movie into one shared collection without a collision → duplicate rows in a shared collection.
- With Part 1 + Part 3 in place, the index needs no `ownerId`: writes are ACL-authorized (no foreign-collection inserts) and `movie.ownerId` is constant per collection, so the existing key already behaves as per-collection uniqueness.

**Decision: keep the movie uniqueness index as `{ collectionId, title, year, contentType }`. No index migration.** This is recorded here so a future contributor doesn't "helpfully" add `ownerId` and create a DAC regression.

---

## Acceptance Criteria

1. An authenticated user who is not on a collection's ACL cannot create, update, or delete a movie in it (404), and cannot read its movies (404).
2. The collection owner retains full create/read/update/delete on their own collections (no behavior change for existing users).
3. After a write, `movie.ownerId` equals the parent collection's `ownerId`, never the acting user's id (when acting user ≠ owner — testable once contributor grants exist; today they're identical).
4. Movie reads return the same results as today for owners, with the `ownerId` predicate removed in favor of an ACL authorization check.
5. The movie uniqueness index is unchanged; adding a duplicate `{title, year, contentType}` to the same collection is still rejected.
6. Each change is delivered test-first (RED→GREEN) with real-MongoDB integration tests; the existing suites stay green.

## Sequencing & Relationship to `009-review-remediation`

- `009` deliberately leaves #2 out of scope (clarified 2026-06-02) precisely so it can be done here, as the DAC foundation, rather than with a disposable owner-equality guard.
- This PRD is the natural **first slice of the DAC feature**: Parts 1–3 are the enforcement seam; the remaining DAC work (grant/revoke endpoints + UI, contributor/viewer flows) layers on top by writing additional ACL entries — no further guard rework.
- Suggested follow-up: run this through the SDD flow (`/speckit-specify docs\PRD-CleanDAC.md`) as its own feature, or fold it into the broader DAC feature spec.

## Constitution Alignment

- **Access Control (DAC) / Deny by default / Least privilege**: authorization is evaluated for every movie operation against the ACL; default is deny (404).
- **Centralized Access Control**: mc-service already enforces auth as a Tower layer; this adds *resource-level* authorization in the Application-Layer handlers (the documented place for least-privilege/authorization), keeping the Specification pattern for validation only.
- **Clean Architecture**: `authorizes` is a Domain-Layer behavior on the `Collection` aggregate; handlers (Application-Layer) orchestrate the check; adapters/queries lose the `ownerId` read shortcut. No layer inversion, no ORM, no Specification-for-query.
