# Research: Post-Agent Enhancements

**Feature**: 013-post-agent-enhancements | **Date**: 2026-06-11

All decisions below are grounded in the as-built code (mc-service movie query path, the Expo collection screen + BFF routes, and the movie-assistant agent nodes/tools). No NEEDS CLARIFICATION remained from the spec; the open engineering questions are resolved here.

---

## D1 — Sort applied server-side, in conjunction with keyset pagination

**Context**: `GET …/movies` today hardcodes `sort(doc! { "_id": 1 })` and paginates with a keyset cursor = `base64(hex(_id))` (`backend/mc-service/src/adapters/mongodb/movie_repository.rs:444-552`). There is no sort parameter. The default the spec mandates is title↑ then year↑. The clarification scoped sortable fields to "any currently displayed movie-list column."

**Decision**: Add optional `sortBy` + `sortDir` to the list query and switch the keyset cursor to a **compound `(sort-field, year, _id)`** cursor so pagination follows the displayed order. `_id` is always appended as the final, unique, immutable tiebreaker. The cursor encodes the sort key value(s) + `_id`. The keyset boundary becomes the standard lexicographic comparison:

```
(sortVal > cur.sortVal)
  OR (sortVal == cur.sortVal AND (year > cur.year OR (year == cur.year AND _id > cur._id)))
```

(For `sortBy == "title"` the field IS title and year is the documented secondary key; for other scalar fields the secondary key is `_id` only.)

- **Default**: `sortBy=title`, `sortDir=asc`; secondary key `year asc`; final tiebreaker `_id asc`. Applies when params absent ⇒ non-breaking for existing callers (they currently get `_id` order; after this change they get the documented title→year order, which is the intended improvement).
- **Sortable fields** (scalar, server-side): `title, year, contentType, language, owned, ripped, childrens, rated, runtime`.
- **Excluded from server sort**: array-valued columns `genres, directors, actors, ownedMedia, ripQuality` (no single well-defined sort key). The sort control offers only scalar columns; the spec's "any displayed column" is honoured for the orderable columns and array columns are simply not offered as sort keys (documented limitation).
- **Index**: add a `(collectionId, title, year, _id)` compound index in `indexes.rs` for the default order. Other scalar sorts are served by their existing `(collectionId, <field>)` filter indexes plus an in-collection sort; given personal-collection scale this is acceptable. Re-evaluate adding more compound indexes only if profiling shows a hot path.

**Rationale**: Keyset must follow the visible order or "next page" overlaps/skips (the in-memory-resort alternative breaks pagination UX — Explorer Option B). Compound keyset is the standard correct pattern and keeps the no-`skip()` constraint. Restricting to scalar fields avoids ill-defined array ordering while still satisfying the user-visible requirement.

**Alternatives rejected**:
- *In-memory re-sort of each 50-item page keyed by `_id`* — simplest but the cursor no longer matches the displayed order, producing confusing gaps/overlaps on scroll. Rejected.
- *One compound index per sortable column* — premature; index bloat for a personal-scale dataset. Deferred behind profiling.

**Edge handling**: invalid `sortBy`/`sortDir` ⇒ 400 (whitelist validation in `api/movies/list.rs`, consistent with existing param validation). A cursor minted under one sort is only valid for that sort; changing the sort resets to page 1 (cursor cleared) — the frontend already resets the cursor on filter change and will do the same on sort change.

---

## D2 — Count info line (total and filtered/total)

**Context**: mc-service `GET …/movies/count` already exists and reuses the shared `build_movie_filter` (`adapters/mongodb/movie_repository.rs:562-576`, `api/movies/count.rs`), so it returns a server-side `count_documents` honouring the same filter as the list. There is **no BFF count route** and **no count display** on the screen. The list response is `{ items, nextCursor }` only.

**Decision**:
- Add a **BFF count route** `GET /bff-api/collections/:id/movies/count` proxying mc-service, forwarding the same filter query params (the standard `requireAuth`→`requireMcUser`→`createMcServiceClient` pattern; joins `AGENT_ROUTES`/route-coverage map as a normal protected route).
- The frontend requests the count **with the active filter** for the numerator, and — only when a filter is active — a second **unfiltered** request for the denominator. With no filter, one request suffices and the line shows the total. Display: `total` when unfiltered, `filtered/total` when filtered.
- Refresh: reuse the existing mechanisms — `useFocusEffect` (after add/edit/delete navigations) and `useAssistantDataRefresh` (revision bump on approved assistant writes). The count hook re-runs whenever the list re-fetches.

**Rationale**: Reuses the existing efficient server-side count (no client full-collection load, satisfies "applied at mc-service"). Two light count calls only when filtered is acceptable and keeps the contract simple; embedding counts in the list response was considered but would change the existing `MovieListResponse` shape (less additive) and still need an unfiltered total.

**Alternatives rejected**: *Client-side `items.length`* — wrong once paginated (only counts loaded pages). *Add `total` to list response* — mutates an existing contract and can't express the unfiltered denominator under an active filter.

---

## D3 — Disambiguation candidates as buttons

**Context**: Ambiguous look-ups already store candidates in `state["options"]` (`{sourceId, title, year, posterUrl}`) and render them as comma-separated text (`agents/movie-assistant/src/nodes/curator.py:174-175`). The user must type a disambiguator, resolved deterministically in pure code by `resolve_option()` (year → longest-title → ordinal → 1-based index; `nodes/supervisor.py:43-85`).

**Decision**: Add a **generative-UI render tool** (e.g., `render_disambiguation`) that the curator emits alongside the existing text when `add_stage == "awaiting_pick"`, carrying the `options` list. A new universal component (`disambiguation-options.tsx`) renders one button per candidate (title + year). **Tapping a button posts a chat message containing that candidate's canonical disambiguator** (its `title (year)`, or its 1-based ordinal) — i.e., it injects exactly the text a user would have typed — so the unchanged `resolve_option()` resolves it. No new resolution path; the model's decisions are unchanged.

**Rationale**: This is the established 012 discipline (memory: resolve picks in pure code; avoid golden re-record). Because selection rides the existing text-resolution path, the golden cassettes don't change and `resolve_option()` stays the single source of truth. Cap at 5 buttons with an overflow affordance (spec FR-014a) — show the first 5, with a "more" control revealing the rest (the `options` list already holds all candidates returned by `search_title`).

**Alternatives rejected**: *A dedicated "pick by id" resume path* — would add a second resolution mechanism and risk diverging from `resolve_option()`; also pushes a model/state change that could force golden re-record. Rejected.

**Open item for tasks**: confirm `search_title` returns enough candidates to make ">5" reachable for broad titles (e.g., "Star Wars"); if it caps below the overflow need, widen its result limit (web-api-mcp `search_title`) — verify no token/latency regression.

---

## D4 — Clickable movie card → detail screen

**Context**: `render_movie_card` (generative-UI tool, `tools/generative_ui_tools.py:22-38`) accepts an optional `movie_id` that is currently passed as `None`; the frontend card (`components/agent/render-movie-card.tsx`) is a non-interactive `<View>` and has no `collectionId`. The `navigate_to_movie` route shape `/collections/:collectionId/movies/:movieId` already exists and `movie-detail` is already role-allowlisted at the BFF.

**Decision**: On the query/"found-in-collection" path, populate the card tool call with the resolved **mc-service `movie_id`** and its **`collection_id`**. Make the card a `TouchableOpacity` whose press navigates to `/collections/${collectionId}/movies/${movieId}` (reusing the existing detail route; the same de-dupe/keying already present in the dock). Scope: **in-collection cards only** — cards for look-up-only results (not yet added) carry no `movie_id`/`collection_id` and remain non-navigable (per spec Assumptions).

**Rationale**: All the plumbing (route, BFF authorization for `movie-detail`, dock keying) already exists; the only gap is threading the two ids onto the card and making it pressable. Minimal, additive.

**Open item**: confirm the query/found node has the mc-service movie id + collection id available at card-render time (the read that produced the "found" card carries them). If the found path only has a TMDB id, resolve to the stored movie's id via the same read.

---

## D5 — Navigate to a specific movie (cross-collection)

**Context**: The navigator resolves a movie only **within a named/resolved collection** (`nodes/navigator.py:79-91,145-153`) and dispatches `navigate_to_movie`. It cannot yet handle "take me to <movie>" when the collection isn't named.

**Decision**: Extend navigator target resolution: when the user names a movie but not a collection, search the user's collections (existing list/read MCP tools) for a title match. **Exactly one match → dispatch `navigate_to_movie`** with that collection+movie id. **Multiple matches → clarify** (ask which collection / which title+year), consistent with the spec's "ambiguous → clarify, never guess." **No match → report not found.** Resolution stays pure code; reuse the same match helpers used elsewhere (length-guarded title match, `(title, year)` discrimination per the Phase-9 hardening discipline).

**Rationale**: The dispatch + BFF authorization + client handler already exist; only the resolution breadth changes. Pure-code resolution keeps the golden suite stable.

**Open item (golden gate)**: determine whether the **supervisor intent prompt** needs any change to route bare "navigate to <movie>" to the `navigate` intent. Per memory, navigate phrasing is already classified; if no prompt text changes, **no golden re-record**. If the prompt changes, delete stale intent cassettes and re-record on BOTH the runtime model (qwen2.5) and Claude (gate), per the established US3-navigate lesson.

---

## D6 — TMDB external-ID URL on scraped adds

**Context**: `to_movie_payload()` builds `externalIds = [{system, uniqueId}]` from `candidate.source_id` partition (`agents/movie-assistant/src/proposals.py:146-149`); the mc-service `ExternalIdentifier` shape already supports an optional `url` (camelCase `{system, uniqueId, url?}`). No url is populated today. The TMDB numeric id is embedded in `source_id` as `tmdb:{id}` (web-api-mcp `get_movie_details`/`search_title`).

**Decision**: In `to_movie_payload()`, when `system == "tmdb"` and a `uniqueId` exists, set `url = f"https://www.themoviedb.org/movie/{uniqueId}"`. When there is no usable id, emit no `externalIds` entry (and therefore no url) — never a malformed/placeholder link (spec FR-018).

**Rationale**: The id and the payload field already exist; this is a one-line construction with a guard. The detail screen's `openUrl` helper already renders external-id URLs as tappable links (per CLAUDE.md), so no frontend change is needed for the link to be usable.

**Alternatives rejected**: building the URL in the MCP server or mc-service — wrong layer; the URL is a presentation/source-link concern assembled where the candidate is turned into a payload, and keeps mc-service/​MCP as thin pass-throughs.

---

## Cross-cutting: testing & gates

- **TDD**: each item gets failing tests first. mc-service sort/cursor → unit (adapter cursor encode/decode + boundary) + integration (real Mongo, real pagination across a sort). Count → BFF integration (real mc-service) + frontend unit. Agent items → unit (pure-code resolution, payload builder) + integration (real MCP) + golden replay where a model decision is in play.
- **Golden gate**: D3 and D4 avoid model-decision changes by design (pure-code routing). D5 is the one item that *may* touch the intent prompt — gate on `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`, re-record only if the prompt changes.
- **Platform parity**: sort, count line, clickable card, disambiguation buttons, navigate-to-movie each need Playwright (web) + Maestro (mobile) coverage; justify any N/A in the tasks.md parity table.
- **E2E discipline (R15)**: agent-flow E2E must navigate IN-APP, never deep-load a non-home route before driving the dock (resets CopilotKit).
