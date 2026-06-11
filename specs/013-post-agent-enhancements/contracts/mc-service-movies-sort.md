# Contract: mc-service movie list — sort + compound cursor

**Endpoint (existing, extended)**: `GET /api/v1/collections/{collectionId}/movies`
**Auth**: unchanged — `auth_layer` (JWT) → `require_app_role` (mc-user OR mc-admin) → per-handler DAC `authorize_collection_access` (Viewer+).

## New query parameters (additive, optional)

| Param | Type | Default | Allowed | On invalid |
|---|---|---|---|---|
| `sortBy` | string | `title` | `title, year, contentType, language, owned, ripped, childrens, rated, runtime` | 400 Problem Details |
| `sortDir` | string | `asc` | `asc, desc` | 400 Problem Details |

All existing filter params (`search, contentType, genre, childrens, rated, language, decade, owned, ownedMedia, ripped, ripQuality`) and `cursor` are unchanged in name. Sort applies **in conjunction** with the filter (filter narrows, sort orders the narrowed set).

## Ordering semantics

- Effective sort spec: `[ (sortBy, dir), (year, dir) if sortBy==title, (_id, asc) ]`.
- Default (no params): `title asc, year asc, _id asc`.
- Tiebreaker `_id asc` is always appended (stable, deterministic order across reloads).

## Cursor (compound keyset) — opaque to clients

- Request `cursor` continues to be an opaque token; clients pass back `nextCursor` verbatim and **must clear it when `sortBy`/`sortDir` changes** (start a new page-1 request).
- A `cursor` minted under a different `(sortBy,sortDir)` than the request → `400` (`Invalid pagination cursor`).
- Response shape unchanged: `{ items: Movie[], nextCursor: string | null }`.

## Example

```
GET /api/v1/collections/abc/movies?sortBy=year&sortDir=desc&owned=true
→ 200 { "items": [ ...owned movies, year desc, _id asc tiebreak... ], "nextCursor": "…" }

GET /api/v1/collections/abc/movies?sortBy=bogus
→ 400 application/problem+json  (invalid sortBy)
```

## Backwards compatibility

Existing callers that omit `sortBy/sortDir` now receive **title→year** order instead of `_id` order. This is the intended improvement and breaks no response contract (same JSON shape, same pagination protocol). The count endpoint is unaffected (it ignores ordering).

## Index

Add compound index `sort_title_year = { collectionId:1, title:1, year:1, _id:1 }` (default sort path). Other scalar sorts served by existing filter indexes + collection-scoped sort.
