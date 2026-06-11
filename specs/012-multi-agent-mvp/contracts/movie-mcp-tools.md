# Contract: `movie-mcp` Tool Server

**Feature**: `012-multi-agent-mvp` | `mcp-servers/movie-mcp/` (Python, MCP over Docker).

**Thin wrapper** over the existing `mc-service` REST API (`/api/v1/...`, see `api-specs/mc-service-api.yaml`). Introduces **no domain logic** (FR-022). Every call forwards the gateway-exchanged **downscoped `aud=mc-service` JWT** as `Authorization: Bearer`; `mc-service` applies RBAC + DAC unchanged. The agent's reachable scope == the user's own (owner/contributor write, viewer denied identically — FR-010/011/012a). Unauthorized → mirror `mc-service` (404 for IDOR-protected resources, per feature 011 Clean DAC).

Allowlists: **`curator`** may call read tools only; **`organizer`** may call read + write tools; **`supervisor`** none. Enforced at the gateway, not by convention.

Tool results are typed; errors return structured tool errors (not exceptions) surfaced to the planner (FR-018) and never expose `mc-service` internals.

---

## Read tools (curator + organizer)

### `get_collection`
- **Input**: `{ collectionId: string }`
- **Output**: `{ collectionId, name, ownerId, role, movieCount }` (shape per mc-service GET collection).
- **Maps to**: `GET /api/v1/collections/{collectionId}`.

### `list_movies`
- **Input**: `{ collectionId: string, cursor?: string, filter?: { … structural keys … } }`
- **Output**: `{ movies: MovieRef[], nextCursor?: string }` (cursor-based keyset pagination, batch 50).
- **Maps to**: `GET /api/v1/collections/{collectionId}/movies`.
- **Use**: plan-time reads and **approval-time re-validation** (R7).

### `list_collections`
- **Input**: `{ }`
- **Output**: `{ collections: CollectionRef[] }` — only those the user can reach (owned + shared).
- **Maps to**: `GET /api/v1/collections`.

---

## Write tools (organizer only; HITL-gated; idempotent)

Every write **MUST** carry an `idempotencyKey` and **MUST** only execute on the approved-resume path (never autonomously). Retries with the same key are no-ops upstream → at-most-once (FR-009, SC-006).

### `create_collection`
- **Input**: `{ name: string, idempotencyKey: string }`
- **Output**: `{ collectionId, name, ownerId }`
- **Maps to**: `POST /api/v1/collections`. Used for create-if-missing (FR-005a); surfaced in the same approval preview as the movie add.
- **Errors**: duplicate name (per-owner uniqueness) → `DuplicateCollectionName` → reported, not forced.

### `add_movie`
- **Input**: `{ collectionId: string, movie: MoviePayload, idempotencyKey: string }` (`movie` shaped from an `EnrichedMovieCandidate`).
- **Output**: `{ movieId, collectionId }`
- **Maps to**: `POST /api/v1/collections/{collectionId}/movies`.
- **Errors**: duplicate movie (per-collection uniqueness, E11000→`DuplicateMovie`) → at approval time becomes `skipped_duplicate` (FR-009a).

### `update_movie`
- **Input**: `{ collectionId, movieId, changes: Partial<MoviePayload>, idempotencyKey }`
- **Output**: `{ movieId }`
- **Maps to**: `PUT /api/v1/collections/{collectionId}/movies/{movieId}`.
- **Errors**: not found → `skipped_missing` at approval time.

### `delete_movie`
- **Input**: `{ collectionId, movieId, idempotencyKey }`
- **Output**: `{ movieId, deleted: true }`
- **Maps to**: `DELETE /api/v1/collections/{collectionId}/movies/{movieId}`.
- **Errors**: not found → `skipped_missing`.

---

## Out of scope (this MVP)

- Collection **rename / delete** (no `update_collection` / `delete_collection` tool) — FR-005a, spec Out of Scope.
- Any tool not wrapping an existing `mc-service` endpoint (no new domain capability).

## Identity & safety invariants

- Token attached per call is the **gateway-exchanged** downscoped JWT; the subject token never reaches `movie-mcp`; no token is logged.
- `movie-mcp` attaches to `backend-network` (must reach `mc-service`).
- `mc-service` is unchanged; all validation/persistence/authz stays there.
