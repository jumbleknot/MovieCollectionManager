# Research: Manage Movie Collection

**Branch**: `002-manage-movie-collection` | **Date**: 2026-05-22

All `NEEDS CLARIFICATION` items resolved here before design begins.

---

## Decision 1: MongoDB Schema — Embed vs Separate Collections

**Question**: Should movies be embedded documents inside the `movie_collections` document, or stored in a separate `movies` collection?

**Decision**: Separate `movies` collection, referenced by `collectionId`.

**Rationale**:
- MongoDB documents are capped at 16 MB. A collection of 10,000 movies with rich metadata would easily exceed this limit.
- Separate collections allow independent querying, indexing, cursor-based pagination, and text search on movies without loading the entire collection document.
- The architecture doc (`docs/MCM-Architecture.md`) already names `movie_collections` and `movies` as distinct shared MongoDB collections.

**Alternatives considered**:
- Embedded array: rejected due to 16 MB document limit and inability to index sub-fields for text search.
- Single collection with type discrimination: rejected; complicates query scoping and index design.

---

## Decision 2: Infinite Scroll Pagination Strategy

**Question**: How should the movie list API implement infinite scroll? Offset-based or cursor-based pagination?

**Decision**: Cursor-based pagination using the MongoDB `_id` field as the cursor (keyset pagination). Batch size: 50 movies per request.

**Rationale**:
- Offset-based pagination (`skip()`) degrades at high offsets (O(N) scan). At 10,000 movies, `skip(9950)` scans almost all documents.
- Keyset pagination with `{ _id: { $gt: lastSeenId } }` is O(log N) via the `_id` index.
- Cursor is stable under concurrent inserts (unlike offset, which shifts results when new documents are inserted before the current page).
- Batch size of 50 balances initial load time with scroll responsiveness.

**Alternatives considered**:
- Offset pagination: rejected — performance degrades at scale, unstable under concurrent writes.
- Time-based cursor: rejected — timestamp collisions possible; `_id` (ObjectId) is guaranteed unique and monotonically increasing by insertion order.

---

## Decision 3: Text Search Implementation

**Question**: How to implement free-text search across title, originalTitle, directors, actors, movieSet, tags, outline, plot (FR-021) on self-hosted MongoDB Community?

**Decision**: MongoDB `$text` index with a compound text index across the searchable fields.

**Rationale**:
- Self-hosted MongoDB Community Server 8.x does not support Atlas Search (cloud-only feature).
- `$text` indexes provide full-text search with language-aware stemming (English) and stop-word filtering.
- A single compound text index can cover all required fields with field weights for relevance scoring.
- `$text` search can be combined with other filters in the same query (combinable with FR-022 filters per FR-025).

**Alternatives considered**:
- Application-level regex search: rejected — no index support, O(N) scan of all movies.
- Atlas Search: rejected — requires MongoDB Atlas (cloud), not self-hosted.
- Meilisearch or Elasticsearch sidecar: rejected — adds operational complexity not justified for this feature's scope.

---

## Decision 4: Case-Insensitive Uniqueness Enforcement

**Question**: How to enforce case-insensitive uniqueness for collection names (FR-004) and movie title+year+contentType (FR-016a)?

**Decision**: MongoDB collection-level collation `{ locale: "en", strength: 2 }` on the relevant unique indexes.

**Rationale**:
- Collation strength 2 treats characters as equal regardless of case (and ignores accents at strength 1).
- Database-level enforcement prevents race conditions that application-level checks cannot prevent.
- Keyed on `{ ownerId, name }` for collections and `{ collectionId, title, year, contentType }` for movies.
- Duplicate writes trigger a MongoDB `E11000` duplicate key error, translated to a domain `DuplicateName`/`DuplicateMovie` error by the Adapters layer.

**Alternatives considered**:
- Storing a `nameLower: String` derived field and indexing that: rejected — adds redundant data and requires coordinated writes.
- Application-level uniqueness check before write: rejected — race condition between check and write; requires a distributed lock.

---

## Decision 5: Decade Filter Implementation

**Question**: How to implement the decade filter (FR-022, FR-023) without a stored `decade` field?

**Decision**: Compute decade range at query time. For a selected decade `D` (e.g., 1980), add filter `{ year: { $gte: D, $lte: D + 9 } }` to the MongoDB query. The API accepts the decade as an integer (e.g., `1980`).

**Rationale**:
- The `year` field is required on all movies (FR-011), so all movies are decade-filterable.
- Range query on the `year` field uses the `{ collectionId, year }` compound index efficiently.
- No derived field needs to be stored or kept in sync.

**Alternatives considered**:
- Store a `decade: i32` derived field: rejected — redundant with `year`, requires coordinated writes and migration if logic changes.

---

## Decision 6: JWT Validation in mc-service (Rust)

**Question**: How does mc-service validate JWTs from the BFF without calling Keycloak on every request?

**Decision**: Use `axum-keycloak-auth` crate. On startup, mc-service fetches Keycloak's JWKS (JSON Web Key Set) endpoint and caches the public key. Each request's JWT is validated locally against the cached public key — no per-request Keycloak call.

**Rationale**:
- Matches the architecture diagram in `constitution.md` (backend fetches public key on startup).
- `axum-keycloak-auth` integrates natively with Axum extractors and handles JWKS fetching/caching.
- JWT claims validated per constitution: `iss`, `aud`, `azp`, `exp`, `nbf`.
- Role extraction from `resource_access.movie-collection-manager.roles` claim checks `mc-user` or `mc-admin`.

**Alternatives considered**:
- Introspection endpoint per request: rejected — network call per request, adds latency, creates Keycloak dependency on every API call.
- Manual JWT validation with `jsonwebtoken` crate: rejected — `axum-keycloak-auth` provides the same using battle-tested libraries and integrates with Axum extractors, reducing boilerplate.

---

## Decision 7: CQRS Mediator in mc-service

**Question**: How to implement the CQRS pattern required by the constitution in Rust?

**Decision**: Use `medi-rs` crate as the mediator to dynamically dispatch commands and queries from the API-Layer to the Application-Layer handlers.

**Rationale**:
- `medi-rs` is the constitutionally mandated mediator library for this project.
- Provides `CommandHandler<C>` and `QueryHandler<Q>` traits, enabling clean CQRS separation with type-safe dispatch.

---

## Decision 8: ACL Structure for Future Sharing

**Question**: Since DAC (movie collection sharing) is out of scope for this feature but defined in the architecture, should the data model accommodate it now?

**Decision**: Yes — store an `acl: [{ userId: String, role: String }]` array in `movie_collections`. For this feature, only the creator's userId appears with role `"owner"`. No sharing logic is implemented.

**Rationale**:
- Adding the ACL field later would require a data migration on potentially thousands of documents.
- Including it now costs nothing (empty array or single-entry array) and keeps the data model aligned with the architecture doc.
- The `ownerId` field is retained as a denormalized field for fast ownership queries without scanning the ACL array.

---

## Decision 9: BFF → mc-service HTTP Client

**Question**: How does the BFF call mc-service?

**Decision**: Extend the existing `mc-service-client.ts` BFF server module (new file) using Axios with the mc-service base URL configured from environment variable `MC_SERVICE_URL`. The BFF forwards the user's JWT (extracted from the session) in the `Authorization: Bearer` header on every call to mc-service.

**Rationale**:
- Consistent with the existing `api-client.ts` pattern in the BFF.
- JWT propagation satisfies the constitution's Identity Propagation requirement.
- The mc-service URL is a runtime environment variable, not hardcoded.

---

## Decision 10: mc-service Docker Networking

**Question**: How does mc-service connect to MongoDB and Keycloak in Docker?

**Decision**:

- mc-service and mc-db are defined in a new, separate compose file: `infrastructure-as-code/docker/mc-service/compose.yaml`.
- mc-service connects to MongoDB via `MC_DB_URL=mongodb://mc-db:27017/mc_db` (internal Docker network hostname `mc-db`).
- mc-service connects to Keycloak via `KEYCLOAK_URL=http://keycloak-service:8080` (existing internal hostname from feature 001).
- Both mc-service and mc-db join the `backend-network` Docker network (existing from feature 001 setup).
- The BFF connects to mc-service via `MC_SERVICE_URL=http://mc-service:3001` on the `backend-network` (the BFF exists on both `bff-network` and `backend-network`).

**Rationale**:

- Keeping mc-service in its own compose file maintains service boundary separation and avoids growing the BFF compose file with unrelated services.
- Matches the networking pattern already established in `infrastructure-as-code/docker/`.
- mc-service listens on port 3001 internally (8080 is reserved for Keycloak).
