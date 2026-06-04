# Implementation Plan: Clean DAC Foundation

**Branch**: `011-clean-dac` | **Date**: 2026-06-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/011-clean-dac/spec.md`

## Summary

Authorize every movie operation in **mc-service** against the parent collection's ACL, fixing the cross-tenant write IDOR (review finding #2) and laying the DAC enforcement seam. Three slices, **mc-service only** (no BFF/client change per clarification):

1. **US1 — Write authorization**: create/update/delete a movie require **contributor** access on the parent collection; unauthorized or missing collection → `CollectionNotFound` (404, no existence leak).
2. **US2 — Read authorization**: get/list/filter movies require **viewer** access; reads are scoped by collection access (ACL check + query by `collectionId`), not by matching the caller to `movie.ownerId`.
3. **US3 — Owner-reference integrity**: on every write, `movie.ownerId` is set to the **collection owner**, never the acting user (fix-on-write; no back-fill).

The enforcement primitive is a Domain-Layer `MovieCollection::authorizes(user_id, required_role)` with the hierarchy owner ⊇ contributor ⊇ viewer, called from each movie Application-Layer handler after loading the parent collection. Today every ACL holds only the owner entry, so user-visible behavior is unchanged; the seam is exercised in tests via seeded contributor/viewer entries.

## Technical Context

**Language/Version**: Rust (2021 edition), Tokio async

**Primary Dependencies**: Axum, medi-rs (CQRS mediator), mongodb crate, mockall (unit tests), axum-keycloak-auth (existing authn/role layer — unchanged)

**Storage**: MongoDB (`mc_db`; `movie_collections` with `acl: [{ userId, role }]`, `movies` with `ownerId`). No schema change, no migration, no index change.

**Testing**: cargo unit tests (inline `#[cfg(test)]`, `mockall` for repos) + integration tests in `backend/mc-service/tests/integration/` against a real replica-set MongoDB; run via `pnpm nx test mc-service` / `test:integration mc-service`.

**Target Platform**: Linux container (Rust/Axum service)

**Project Type**: Backend microservice (Clean Architecture, 4 layers). Single project; no frontend changes.

**Performance Goals**: One extra collection lookup per movie operation (load parent collection for the ACL check). Acceptable — bounded, indexed by `_id`; no N+1 (single document load per request).

**Constraints**: Enforcement is mc-service-only (BFF holds no domain logic — clarification). Unauthorized and not-found are indistinguishable (404). No uniqueness-index change. Fix-on-write only for `ownerId` (no migration).

**Scale/Scope**: ~6 movie handlers (create/update/delete/get/list/filter-options), 1 new domain method, 1 new repository port method + adapter impl, MovieRepository signature changes (drop per-caller `ownerId` predicate on reads/delete; stamp collection owner on writes), router wiring, plus unit + integration tests. No new endpoints, no DTO changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
| --- | --- | --- |
| **Security → Authorization → Access Control (DAC) / Deny by default / Least privilege** | ✅ Strengthened | Every movie op is authorized against the collection ACL; default is deny (404). Fixes the finding #2 IDOR. |
| **Security → Centralized Access Control** | ✅ Compliant (with note) | Authn + application-role are already enforced by the centralized Tower layer (a new endpoint is authn-protected by default). **Resource-level** (per-collection) DAC is inherently per-resource and the constitution explicitly assigns "applying least privilege controls (authorization, RBAC)" to the **Application-Layer**. Mitigation against omission: a single shared handler helper (`authorize_collection_access`) used by every movie handler, covered by per-operation integration tests. |
| **Clean Architecture — layer boundaries** | ✅ Compliant | `authorizes()` is Domain behavior on the `MovieCollection` aggregate; handlers (Application) orchestrate the check via the `CollectionRepository` port; the Mongo adapter loads the aggregate. No layer inversion. |
| **Clean Architecture — Specification pattern for validation only** | ✅ Compliant | Authorization is **not** a Specification — it is access control in the Application-Layer handler (aggregate behavior + handler orchestration). No Specification used for query or for authz. Adapters use no ORM; queries stay hand-written. |
| **Error Handling — Typed Result + Safe Errors** | ✅ Compliant | Reuses `DomainError::CollectionNotFound` (→ 404) for missing-or-unauthorized; no new variant; no internals leaked. |
| **API-First / Specification-First** | ✅ N/A schema; ⚠ doc touch | No endpoint, request, or response **schema** change (404 already declared on these routes). The behavioral tightening (foreign-collection write now 404s) is documented in `/api-specs` route descriptions (tasks-level), no contract-shape change. |
| **TDD (NON-NEGOTIABLE)** | ✅ Planned | Every change RED→GREEN; integration tests use a real second user / seeded ACL entry (no mocking of the DB). |
| **Test Type Integrity** | ✅ Planned | Authorization integration tests run against real MongoDB; unit tests (`mockall`) cover the handler/domain logic. No mocked DB under `tests/integration/`. |
| **Backend stack (Rust/Axum/mongodb/medi-rs/Nx)** | ✅ Compliant | No stack deviation; reuses existing ports/handlers/mediator. |
| **Behavior-Descriptive Identifiers** | ✅ Compliant | New symbols named behaviorally (`authorizes`, `authorize_collection_access`, `find_by_id`); requirement IDs in doc-comments only. |

**Result**: PASS. The feature strengthens Access Control with no constitution violation. The one note (per-resource DAC is handler-level, not blanket middleware) is inherent to resource authorization and mitigated by the shared helper + tests. Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/011-clean-dac/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── contract-deltas.md   # Behavioral + internal-port contract deltas
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
backend/mc-service/src/
├── domain/
│   └── collection.rs                 # ADD MovieCollection::authorizes(user_id, AclRole) + role hierarchy + unit tests
├── application/
│   ├── ports/
│   │   ├── collection_repository.rs  # ADD find_by_id(id) -> MovieCollection (by-id only, for authz)
│   │   └── movie_repository.rs       # CHANGE: reads/delete drop per-caller owner_id; create/update take collection owner
│   ├── commands/
│   │   ├── create_movie.rs           # inject CollectionRepository; authorize Contributor; stamp owner=collection owner
│   │   ├── update_movie.rs           # inject; authorize Contributor; stamp owner=collection owner
│   │   └── delete_movie.rs           # inject; authorize Contributor
│   └── queries/
│       ├── get_movie.rs              # inject; authorize Viewer; query by collectionId
│       ├── list_movies.rs           # inject; authorize Viewer; query by collectionId
│       └── (filter-options handler)  # inject; authorize Viewer; query by collectionId
├── adapters/mongodb/
│   ├── collection_repository.rs      # impl find_by_id (DAO→domain incl. acl + owner_id)
│   └── movie_repository.rs           # reads/delete by {collectionId[/movieId]}; create/update stamp ownerId=collection owner
└── api/
    ├── router.rs                     # wire Arc::clone(&collection_repo) into all 6 movie handlers
    └── state.rs                      # (handler field types unchanged; constructor args change)

backend/mc-service/tests/integration/movies/
└── dac_authorization_test.rs         # NEW: cross-tenant write/read denied (404); owner allowed; seeded contributor/viewer seam; owner-ref = collection owner
```

**Structure Decision**: Pure backend change confined to mc-service, following the existing 4-layer Clean Architecture. The DAC primitive is Domain behavior; orchestration is Application-Layer (where the constitution places authorization); the only adapter change is one new load method + dropping the per-caller predicate. A shared `authorize_collection_access` helper (Application-Layer) keeps every movie handler's check identical.

## Phase 0 — Research

See [research.md](research.md): authorization placement + role hierarchy (R1), the by-id collection load for authz (R2), the read-query rework (R3), owner-reference stamping (R4), unauthorized→404 mapping (R5), no-index/no-migration (R6), and the centralized-access-control tension mitigation (R7).

## Phase 1 — Design & Contracts

- [data-model.md](data-model.md) — `MovieCollection` (acl + `authorizes`), `Movie.ownerId` semantics, `AclRole` hierarchy; no schema/index change.
- [contracts/contract-deltas.md](contracts/contract-deltas.md) — per-operation behavioral deltas (authz + 404) and the new internal `CollectionRepository::find_by_id` port; confirms no OpenAPI schema change.
- [quickstart.md](quickstart.md) — verification runbook (real-Mongo integration tests; cross-tenant + seeded-role cases).
- Agent context: the `CLAUDE.md` SPECKIT block is updated to point at this plan.
