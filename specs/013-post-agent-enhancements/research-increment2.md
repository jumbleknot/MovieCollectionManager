# Research — Increment 2 (US7–US10)

Decisions for the post-testing enhancements. Format: Decision / Rationale / Alternatives.

## R-I2-1 — Article-insensitive title sort key (US9, FR-034/035)

**Decision**: Persist a normalized `titleSort` field on each movie (lowercased title with a leading
`a`/`an`/`the` + following whitespace stripped), maintained on create/update, and a new compound
index `sort_titlesort_year = { collectionId:1, titleSort:1, year:1, _id:1 }`. The TITLE sort path
(default and explicit `sortBy=title`) orders by `titleSort` instead of raw `title`; the compound
keyset cursor carries the `titleSort` value as its primary component. Backfill existing documents
once (startup migration / one-shot) so the index is fully populated.

**Rationale**: US1's pagination is **keyset** on `(sortField, year, _id)` — it needs an *indexed,
stored* ordering key to stay O(log n) and to compute correct page boundaries. A computed/normalized
key must therefore be materialized and indexed. Article stripping is deterministic pure code
(`^(a|an|the)\s+`, case-insensitive), so `titleSort` is cheap to maintain on write.

**Alternatives rejected**: (a) MongoDB **collation** — collation changes case/locale ordering but
does NOT strip articles, so "The Matrix" still sorts under T. (b) **Aggregation `$addFields`** to
strip at query time — forces a blocking in-memory sort and breaks keyset pagination (no index on a
computed field), regressing US1's scale guarantee. (c) Strip only in the cursor boundary — the
underlying `find().sort()` would still order by raw title, mismatching the cursor.

**Impact**: default sort becomes `titleSort↑, year↑, _id↑` (still "title then year" semantically).
Non-title sorts (year, contentType, …) are unchanged. The existing `sort_title_year` index is
superseded by `sort_titlesort_year` for the title path (keep or drop per migration).

## R-I2-2 — Unified search workflow node (US7, FR-021–FR-031)

**Decision**: Add a `search` intent to the supervisor and a pure-code **search state machine**
(new `src/nodes/search.py`) that becomes the single resolution path for movie-search prompts.
State: `search_stage` (`resolving | awaiting_scope | awaiting_collection | awaiting_pick`),
`search_scope` (a collection id, or `web`), `search_results`. Collection resolution is pure code:
current-screen collection (ui_snapshot) → default → only → else emit scope buttons. Owned search =
movie-mcp `list_movies` (article-insensitive match in code, R-I2-4); web search = web-api-mcp
`search_title`. Button taps post canonical tokens that re-enter the node and advance the stage
(mirrors the T069 `add_stage` discipline — picks resolved in PURE CODE, no model call).

**Rationale**: The clarified "replace" decision unifies query(find) + navigator(movie). A single
node with explicit stages keeps the multi-turn flow deterministic and golden-stable except for the
intent-routing prompt. Pure-code pick resolution avoids per-pick golden churn.

**Boundary**: Explicit *collection* navigation ("take me to my Favorites collection") stays on the
existing `navigate` → `navigate_to_collection` path. The search workflow owns *movie*-targeted
prompts. Owned pick → `navigate_to_movie` (existing UI action). Web pick → web preview card (R-I2-3).

**Alternatives rejected**: a multi-node sub-graph (more nodes/edges, more interrupt plumbing) — the
single-node staged machine matches the existing add/organize patterns and reuses their checkpoints.

## R-I2-3 — Generalized selection buttons + web preview card (US7/US10, FR-024/026/028/031/036)

**Decision**: Generalize the button mechanism with a new `render_selection` generative-UI tool
carrying `options: [{ label, value, kind }]` (kind ∈ `movie | collection | scope | control`); a tap
posts `value` (the canonical command/title text) through the existing dock send path. Reuse the
`disambiguation-options` component's ≤5 + "view more" overflow (generalize it; keep
`render_disambiguation` for the US4 movie case or re-express it via `render_selection`). For web
results, extend `render_movie_card` with a `url` (the themoviedb.org link, US10, built by the US5
rule) and an **add affordance** whose tap posts an "add `<title> (<year>)` to `<collection>`"
message → existing curator/organizer approval-gated add (FR-031). No auto-write.

**Rationale**: One generic selectable-button contract covers scope/collection/control/result
buttons with one component and one client mapping, preserving universal web+mobile parity and the
overflow affordance already shipped (US4).

**Alternatives rejected**: bespoke tools per button kind (4× the client tools + dock registrations);
embedding controls as plain chat text (loses tappability / parity).

## R-I2-4 — Article-insensitive movie matching + no article injection (US8, FR-032/033)

**Decision**: In the search node's owned-movie matching (and the web query text), strip a leading
`a`/`an`/`the` from BOTH the user query token and the candidate/stored title before comparison
(same regex as R-I2-1, pure code). Fix the extraction that appended "the" (Bug 3a): the search/curator
entity-extract prompt must echo the user's title verbatim — never prepend an article — verified on
the RUNTIME model (qwen2.5), not just Claude.

**Rationale**: Matching is an agent/MCP-side concern (the movie-mcp/list_movies search is substring;
the agent post-filters/resolves). Article-stripping there fixes Bug 3 without an mc-service change.

## R-I2-5 — Golden re-record plan (intent routing)

**Decision**: The supervisor intent prompt gains a `search` label and routes all search keywords
(search/open/navigate to/go to/show me/look up/find/bare-title) to it. This is a model-decision
change → **delete the stale intent cassettes and re-record** on BOTH qwen2.5 (runtime,
`LLM_CASSETTE_MODE=record` against Ollama) and Claude (gate, `MODEL_PROVIDER=anthropic`), then verify
`LLM_CASSETTE_MODE=replay` green. Add a `search-routing` golden kind. All pure-code resolution
(collection pick, disambiguation, article match) stays OUT of the golden surface.

## R-I2-6 — Access control & BFF reuse

**Decision**: Reuse existing surfaces — owned navigate via `navigate_to_movie` (BFF `/ui-action` +
ui-action-authorizer); web search + add via `/run` (gateway → web-api-mcp / curator add). No new BFF
route is expected; if one is added it joins the protected `AGENT_ROUTES` set + `route-coverage-map`
(centralized access control, deny-by-default). Reads/writes stay within the user's own scope under
the existing centralized auth.
