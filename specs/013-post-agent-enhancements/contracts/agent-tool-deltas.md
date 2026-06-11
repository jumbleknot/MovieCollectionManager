# Contract: agent tool & node deltas

All changes are additive to the movie-assistant orchestration; identity propagation, HITL gates, per-agent tool allowlists, and UI-action authorization are unchanged.

## 1. `render_movie_card` (generative-UI tool) — populate ids

- Args gain a populated `movie_id` (was always `None`) and a new `collection_id`, supplied on the query/"found-in-collection" path.
- Client (`render-movie-card.tsx`): when both ids are present, the card is a `TouchableOpacity` → `router.push('/collections/{collectionId}/movies/{movieId}')` (the existing detail route; `movie-detail` already BFF-authorized). Ids absent ⇒ non-interactive (look-up-only cards).
- No allowlist/authorization change — navigation reuses the existing in-app route push; the dock's index-prefixed keying is reused.

## 2. `render_disambiguation` (generative-UI tool) — new

- Emitted by the curator when `add_stage == "awaiting_pick"`, **alongside** the existing text message (text remains the accessible fallback).
- Args: `options: list[{ sourceId, title, year }]` (the existing `state["options"]`; all candidates).
- Client (`disambiguation-options.tsx`): renders ≤5 candidate buttons + an overflow affordance for the rest. A tap **posts a chat message** = the candidate's canonical disambiguator (`"{title} ({year})"` or 1-based ordinal). Resolution is the unchanged pure-code `resolve_option()` — **no golden re-record**.

## 3. Navigator — cross-collection movie resolution

- `navigate` intent extended: when a movie is named without a collection, search the user's collections (existing read tools) for a title match.
  - exactly one → dispatch existing `navigate_to_movie(collection_id, movie_id)` UI action (target `movie-detail`, already allowlisted).
  - multiple → clarify (do not guess).
  - none → report not found.
- Resolution is pure code (length-guarded title match; `(title, year)` discrimination per Phase-9 hardening). **Golden gate**: re-record ONLY if the supervisor intent prompt text changes; otherwise replay-clean.

## 4. `to_movie_payload` — TMDB external-id url

- When building `externalIds` from `candidate.source_id` (`system:uniqueId`): if `system == "tmdb"` and `uniqueId` present, set `url = "https://www.themoviedb.org/movie/{uniqueId}"`.
- If no usable id, emit no `externalIds` entry (no malformed/placeholder url).
- mc-service `ExternalIdentifier{ system, uniqueId, url? }` already supports `url`; movie-mcp `add_movie` already forwards the payload. No MCP/mc-service change.

## Non-changes (explicit)

- `ui_action_tools.navigate_to_movie` — already exists; reused as-is.
- BFF `ui-action-authorizer` `NAVIGABLE_TARGETS.movie-detail` — already present; no change.
- `web-api-mcp` / `movie-mcp` source — unchanged (ids already returned; url field already accepted). The one possible exception is widening `search_title`'s result limit if ">5 candidates" is unreachable for broad titles (see research D3 open item).
