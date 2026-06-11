# Data Model & Contract Deltas: Post-Agent Enhancements

**Feature**: 013-post-agent-enhancements | **Date**: 2026-06-11

This feature introduces **no new persisted entities** and **no schema migration** beyond one additive MongoDB index. The deltas below are to existing query contracts, in-memory state, and UI payloads.

---

## 1. Movie list query — sort parameters (mc-service)

**Entity touched**: the movie list query (CQRS `ListMoviesQuery` / `ListMoviesParams`), not the `Movie` document.

`ListMoviesParams` (application/ports/movie_repository.rs) gains:

| Field | Type | Default | Validation |
|---|---|---|---|
| `sort_by` | `Option<String>` | `title` | one of: `title, year, contentType, language, owned, ripped, childrens, rated, runtime` (whitelist) → else 400 |
| `sort_dir` | `Option<String>` | `asc` | one of: `asc, desc` → else 400 |

- `cursor` (existing) is reinterpreted as a **compound keyset cursor** (see §2). It remains `Option<String>` and absent on page 1.
- The `Movie` document, `MovieDto`, and `MovieDao` are **unchanged** (all sort keys are existing scalar fields).
- Default ordering (params absent): `title asc, year asc, _id asc`.

**Sortable vs non-sortable columns**

- Server-sortable (scalar): `title, year, contentType, language, owned, ripped, childrens, rated, runtime`.
- Not server-sortable (array-valued, excluded from the sort control): `genres, directors, actors, ownedMedia, ripQuality`.

---

## 2. Pagination cursor — compound keyset (mc-service)

**Current**: `cursor = base64(hex(_id))`; boundary `{_id: {$gt: last_id}}`; sort `{_id: 1}`.

**New**: cursor encodes the active sort key value(s) + `_id`:

```
cursorPayload = { v: 1, sortBy, sortDir, sortVal, year?, id }   // base64(JSON)
```

- `sortVal` = the last item's value for the active sort field; `year` carried when `sortBy == "title"` (secondary key); `id` = last item's `_id` hex.
- Sort spec applied to the query: `[ (sortBy, ±1), (year, ±1 when sortBy==title), (_id, +1) ]`.
- Boundary (ascending shown; mirror for desc):
  `sortVal > cur.sortVal OR (== AND (year > cur.year OR (== AND _id > cur.id)))`.
- A cursor is only valid for the `(sortBy, sortDir)` it was minted under; the client clears the cursor (page 1) on any sort change. A cursor whose `sortBy/sortDir` disagree with the request ⇒ 400 (`Invalid pagination cursor`), matching existing invalid-cursor handling.

**Index delta** (adapters/mongodb/indexes.rs): add
`sort_title_year` = `{ collectionId: 1, title: 1, year: 1, _id: 1 }`.
Existing `collection_cursor` `{collectionId,_id}` and per-filter indexes are retained.

---

## 3. Movie count (mc-service exists; BFF + types new)

- **mc-service**: `GET /api/v1/collections/:id/movies/count` → `{ count: u64 }` honouring the shared filter. **Unchanged** (already built in 012/US4).
- **BFF (new route)**: `GET /bff-api/collections/:id/movies/count` → `{ count: number }`, forwarding the same filter query params.
- **Frontend types** (types/collection.ts):

| Type | Shape | Notes |
|---|---|---|
| `MovieCountResponse` | `{ count: number }` | BFF count response |
| `MovieCountLine` (view state) | `{ filtered: number; total: number; isFiltered: boolean }` | drives the info line; `filtered === total` when unfiltered |

Display rule: `isFiltered ? "{filtered}/{total}" : "{total}"`.

---

## 4. Assistant movie card props (agent tool + frontend)

`render_movie_card` tool args / `MovieCardProps` gain the two ids needed to navigate:

| Field | Type | Source | Notes |
|---|---|---|---|
| `movie_id` / `movieId` | `string \| null` | mc-service movie id from the found-in-collection read | already declared; was always `null` — now populated on the in-collection path |
| `collection_id` / `collectionId` | `string \| null` | the collection the found movie belongs to | NEW prop |

Behaviour: card is pressable **iff** both ids are present ⇒ `router.push('/collections/{collectionId}/movies/{movieId}')`. Look-up-only cards (ids null) remain non-interactive.

---

## 5. Disambiguation options (agent state → render tool)

No new state field — reuses the existing `state["options"]` (`list[{ sourceId, title, year, posterUrl }]`) and `add_stage == "awaiting_pick"`.

New generative-UI tool payload `render_disambiguation`:

| Field | Type | Notes |
|---|---|---|
| `options` | `list[{ sourceId, title, year }]` | the candidates (all of them; client shows ≤5 + overflow) |

Selection contract: a button tap **posts a chat message** = the candidate's canonical disambiguator (`"{title} ({year})"` or its 1-based ordinal). No state mutation from the client; resolution stays in `resolve_option()`.

---

## 6. External identifier URL (agent payload → existing mc-service field)

`Movie.externalIds[]` (mc-service `ExternalIdentifier`) already = `{ system, uniqueId, url? }`. This feature **populates** the existing optional `url`:

| Field | Before | After |
|---|---|---|
| `externalIds[].url` (tmdb) | absent | `https://www.themoviedb.org/movie/{uniqueId}` when `system=="tmdb"` and `uniqueId` present; otherwise the entry is omitted entirely (no malformed url) |

No mc-service schema change — the field already exists; the detail screen's `openUrl` already renders it as a tappable link.

---

## State transitions

None beyond the existing add-flow state machine (`add_stage`: `awaiting_pick → resolved`). Sort/count/card/navigate/url changes are stateless request/response or one-shot UI actions.
