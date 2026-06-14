# Contract: mc-service `language` Optional (US1) — API Delta

Backward-compatible change to existing movie endpoints. **No new endpoints.** Update `api-specs/mc-service-api.yaml` accordingly.

## Affected endpoints

- `POST /api/v1/collections/{collectionId}/movies` (create)
- `PUT /api/v1/collections/{collectionId}/movies/{movieId}` (update / full-replace)
- `GET …/movies`, `GET …/movies/{movieId}` (read — response shape)
- `GET …/movies/filter-options` (language facet must tolerate absent values)

## Schema change

`Movie`, `CreateMovieRequest`, `UpdateMovieRequest`, `MovieResponse`:

| Property | Before | After |
|---|---|---|
| `language` | `type: string`, **required** | `type: string`, **optional** (removed from `required`; may be absent or omitted) |

All other properties unchanged. `title`, `year`, `contentType` remain required.

## Behavioral contract

- **Create**: a request body **without** `language` (or with it omitted) MUST succeed `201` and persist the movie with no language. A request **with** `language` behaves exactly as today (no regression).
- **Update**: a full-replace PUT that omits `language` clears it; a PUT that includes it sets it. (Consistent with the existing full-replace semantics; the import update path composes a full payload, so it only clears when the import explicitly has no language AND the existing value is intentionally dropped — see data-model §6 compose-then-replace, which preserves existing values unless overwritten.)
- **Read**: `MovieResponse.language` MAY be absent/null; clients MUST render a neutral placeholder.
- **Filter options**: the distinct-languages facet MUST exclude null/absent (no empty entry).
- **Validation**: the `RequiredString` specification no longer applies to `language`; it still applies to `title`.
- **Canonical absence (normalization)**: an empty or whitespace-only `language` MUST be normalized to absence (`None`) at the create/update command boundary — the domain models "unknown language" as a single representation (absence), never an empty string. This keeps storage, the filter-options facet, and sort consistent and means the facet's empty-string exclusion is defense-in-depth rather than load-bearing. (Implemented in `create_movie.rs` / `update_movie.rs`; added during the 014 implementation review when the handlers were found to persist `""` verbatim.)

## Compatibility

- Existing clients (web form, mobile form, agent/MCP create) that always send `language` are unaffected.
- Existing stored documents all carry `language`; no migration. The MongoDB DAO uses a serde default so future documents missing the field deserialize.
- RFC 9457 Problem Details error shape unchanged.
