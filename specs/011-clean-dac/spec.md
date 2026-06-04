# Feature Specification: Clean DAC Foundation

**Feature Branch**: `011-clean-dac`

**Created**: 2026-06-04

**Status**: Draft

**Input**: User description: "docs\PRD-CleanDAC.md"

## Clarifications

### Session 2026-06-04

- Q: Where should the per-collection ACL authorization be enforced? → A: mc-service (the movie service / resource server) ONLY. The request-forwarding layer (BFF) holds no domain/authorization logic per the constitution; it keeps only its existing application-role gate.
- Q: How should US3 (movie owner reference = collection owner) handle existing rows whose stored owner already differs? → A: Fix-on-write only — set the owner reference to the collection owner on every create/update; no data migration / back-fill (today the acting user is always the owner, so no drift exists).

## User Scenarios & Testing *(mandatory)*

Today any authenticated movie-collection user can write a movie into **any** collection by supplying that collection's identifier — the movie service stamps the caller as the movie's owner and never checks that the caller is authorized for the target collection. This is a cross-tenant access flaw (review finding #2): an injected movie isn't *visible* to the victim (reads are owner-scoped) but it pollutes the victim's collection and can block the victim from adding the same title (a uniqueness collision), a cross-tenant denial of service.

This feature closes that flaw by authorizing every movie operation against the collection's **access list** — the same enforcement seam the product's planned sharing model (one owner, plus optional contributors and viewers) will use. It is deliberately built as the **foundation of Discretionary Access Control (DAC)** so the fix is the first slice of sharing, not a throwaway owner-equality check.

### User Story 1 - A user cannot write movies into a collection they are not authorized for (Priority: P1)

A collection belongs to its owner. When any user tries to create, update, or delete a movie in a collection, the system first checks whether that user is authorized on the collection. Only the owner (today) — or, in future, a contributor — may write. An unauthorized user (or a non-existent collection) gets a "not found" outcome that reveals nothing about whether the collection exists.

**Why this priority**: This is the security fix (the cross-tenant write flaw). It is the MVP: on its own it eliminates the data-pollution / cross-tenant denial-of-service vector and delivers the core value.

**Independent Test**: As user A, create a collection. As user B (authenticated, not on A's collection), attempt to create/update/delete a movie in A's collection by its identifier → each attempt is denied with "not found" and no movie is written. As user A, the same operations succeed.

**Acceptance Scenarios**:

1. **Given** user A owns a collection and user B is not on its access list, **When** user B attempts to create a movie in it, **Then** the request is denied with "not found" and no movie is created.
2. **Given** the same, **When** user B attempts to update or delete a movie in A's collection, **Then** each is denied with "not found" and the data is unchanged.
3. **Given** a collection identifier that does not exist, **When** any user attempts a movie write to it, **Then** the result is "not found" — indistinguishable from the unauthorized case (no existence leak).
4. **Given** user A owns the collection, **When** user A creates, updates, or deletes a movie in it, **Then** the operation succeeds exactly as today.

---

### User Story 2 - Movie reads are authorized by collection access, not by owner-identity matching (Priority: P2)

When a user lists, filters, or fetches movies in a collection, the system authorizes the read against the collection's access list and then returns the collection's movies. Authorization is decided by collection membership, not by matching the caller's identity against each movie's stored owner field — so a future viewer/contributor can read a shared collection without any change to how movies are queried.

**Why this priority**: Reads are already owner-scoped today (so this is not a live security hole), but the current owner-identity matching structurally blocks sharing. Reworking read authorization now removes that blocker as part of the foundation. It is independently testable and shippable after US1.

**Independent Test**: As the collection owner, list/filter/fetch movies → identical results to today. As an unauthorized user, list/filter/fetch movies in another's collection → "not found". (With a test-seeded viewer entry, that viewer can read — proving the seam.)

**Acceptance Scenarios**:

1. **Given** user A owns a collection with movies, **When** user A lists, filters, or fetches its movies, **Then** the results are identical to today's behavior.
2. **Given** user B is not authorized on A's collection, **When** user B lists/filters/fetches its movies, **Then** the result is "not found".
3. **Given** an access-list entry granting user B viewer access to A's collection (test-seeded), **When** user B lists/fetches its movies, **Then** user B can read them — using the same authorization path, with no query rework.

---

### User Story 3 - A movie's owner reference always means the collection owner (Priority: P3)

Each movie carries a denormalized "owner" reference. This feature fixes its canonical meaning: it always equals the owner of the movie's parent collection, never "the user who created or edited the movie." On every movie write, the system sets the movie's owner reference to the collection's owner, regardless of which authorized user performed the write.

**Why this priority**: This keeps the denormalized field coherent once collections are shared (uniform across a collection, a valid fast "whose collection" filter and audit field). It is data-integrity hardening that prevents a future correctness bug; lowest priority because today the acting user and the owner are always the same, so there is no user-visible change yet.

**Independent Test**: After any movie write, the movie's owner reference equals the parent collection's owner. With a test-seeded contributor performing a write, the resulting movie's owner reference is still the collection owner, not the contributor.

**Acceptance Scenarios**:

1. **Given** a movie is created or updated in a collection, **When** the write completes, **Then** the movie's owner reference equals the parent collection's owner.
2. **Given** a test-seeded contributor (not the owner) writes a movie, **When** the write completes, **Then** the movie's owner reference is the collection owner, not the contributor.

---

### Edge Cases

- **Non-existent collection on write or read**: returns "not found", identical to the unauthorized case (no existence leak).
- **Movie fetch by identifier in an inaccessible collection**: "not found", regardless of whether the movie exists.
- **Owner performing a write**: the owner satisfies the contributor requirement via the role hierarchy (owner ⊇ contributor ⊇ viewer) — no special-case code.
- **Collection deleted between the authorization check and the write**: the write fails cleanly with no orphaned movie.
- **A pre-existing movie whose owner reference differs from its collection's owner**: on the next write the reference is corrected to the collection owner.
- **Duplicate movie in the same collection**: still rejected — the uniqueness scope stays per-collection (see FR-007).

## Requirements *(mandatory)*

### Functional Requirements

**Write authorization (US1)**

- **FR-001**: The system MUST authorize every movie create, update, and delete against the parent collection's access list; a caller without at least contributor authorization MUST be denied before any data is written.
- **FR-002**: A movie write targeting a non-existent collection OR a collection the caller is not authorized for MUST return the same "not found" outcome — the two cases MUST be indistinguishable to the caller (no existence leak).
- **FR-008**: Authorization MUST be deny-by-default: no movie operation proceeds without an explicit authorization pass.

**Read authorization (US2)**

- **FR-003**: The system MUST authorize every movie read (fetch, list, filter) against the parent collection's access list; a caller without at least viewer authorization MUST receive "not found".
- **FR-004**: Movie reads MUST be authorized by collection access (membership in the access list), NOT by matching the caller's identity against a movie's stored owner reference — so shared (non-owner) access works without changing how movies are queried.

**Owner-reference integrity (US3)**

- **FR-005**: On every movie create and update, the movie's denormalized owner reference MUST be set to the parent collection's owner, regardless of which authorized user performs the write.

**Cross-cutting**

- **FR-006**: The collection owner MUST retain full create, read, update, and delete on their own collections — no behavior change for existing single-owner users.
- **FR-007**: Movie uniqueness MUST remain scoped per collection (a collection MUST NOT hold two identical movies); the uniqueness scope MUST NOT be narrowed to per-owner.
- **FR-009**: The authorization role model MUST be hierarchical — owner authorization satisfies contributor and viewer requirements, and contributor satisfies viewer — so adding contributor or viewer access-list entries later requires no change to the movie authorization guards.
- **FR-010**: Each change MUST be delivered test-first (a failing test demonstrating the gap, then the fix turning it green) with real-dependency integration tests; all existing automated suites MUST remain green.

### Key Entities *(include if feature involves data)*

- **Collection**: Belongs to one owner. Holds an **access list** of entries, each pairing a user with a role (owner / contributor / viewer). Today the access list contains only the owner entry, seeded at creation.
- **Movie**: Belongs to exactly one collection. Carries a denormalized **owner reference** that, after this feature, always equals the parent collection's owner.
- **Authorization role**: One of owner, contributor, viewer, ordered owner ⊇ contributor ⊇ viewer. Writes require contributor-level; reads require viewer-level.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authenticated user not on a collection's access list cannot create, update, delete, or read any movie in that collection — 100% of such attempts are denied with "not found", and no data is written.
- **SC-002**: A collection owner can perform 100% of movie create/read/update/delete operations on their own collections, with results identical to today.
- **SC-003**: After any movie write, the movie's owner reference equals the parent collection's owner in 100% of cases.
- **SC-004**: Adding a duplicate movie (same title, year, and type) to the same collection is still rejected; the uniqueness scope is unchanged.
- **SC-005**: No regressions — all existing movie and collection automated suites remain green.
- **SC-006**: With a contributor or viewer access-list entry seeded on a collection, that user can perform the operations their role allows (contributor: read + write; viewer: read only) and is denied the rest — using the same authorization guards, with no code change. This verifies the DAC seam.

## Assumptions

- **Source of truth**: Derived from `docs/PRD-CleanDAC.md` (review finding #2, deferred from feature 009).
- **Enforcement location (decided 2026-06-04)**: Authorization is enforced at the movie service (the resource server / authority) ONLY. The request-forwarding layer (BFF) holds no domain/authorization logic per the constitution and is unchanged except that its existing application-role gate (must hold the application user/admin role) remains in place. No BFF-side ACL check.
- **"Not found" over "forbidden"**: Unauthorized and non-existent are reported identically ("not found") to avoid leaking collection existence — consistent with the 009 convention.
- **Granting/revoking is out of scope**: Creating UI or endpoints to add/remove contributor/viewer entries is the broader DAC feature, not this one. This feature builds and verifies the enforcement seam; non-owner roles are exercised here only via test-seeded access-list entries.
- **No user-visible change today**: Every collection's access list currently contains only the owner entry, so owner-only behavior is preserved; only the (previously missing) write authorization and the read-authorization mechanism change internally.
- **No data migration and no uniqueness-index change (decided 2026-06-04)**: The stored shape and the per-collection uniqueness rule are unchanged. The movie owner reference is (re)set to the collection owner on writes (fix-on-write only) — already the same value today since the acting user is the owner, so there is no drift to back-fill and no migration is performed.

## Dependencies

- The collection access list already exists and is seeded with the owner entry at collection creation.
- The existing real-dependency integration test harness (movie service against a real database) is the regression gate for FR-010 / SC-005.
- This feature is the first slice of the planned DAC/sharing feature; grant/revoke flows depend on this seam but are out of scope here.
