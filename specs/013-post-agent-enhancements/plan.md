# Implementation Plan: Post-Agent Enhancements

**Branch**: `013-post-agent-enhancements` | **Date**: 2026-06-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/013-post-agent-enhancements/spec.md`

## Summary

Six additive enhancements that build on the as-built 002 (collection screen) and 012 (agent) features:

1. **Collection movie sort** — the collection screen loads movies in a server-applied sort order (default title↑ then year↑), user-selectable across the currently displayed columns, working in conjunction with the existing filter. Requires extending mc-service keyset pagination from an `_id`-only cursor to a compound `(sort-field, _id)` cursor so pagination follows the sort order.
2. **Collection count info line** — show total movie count, and `filtered/total` when a filter is active, refreshed on every list change (add/delete/filter). The mc-service `GET …/movies/count` endpoint already exists and honours the shared filter; this feature adds the BFF count route and the screen's info line.
3. **Clickable assistant movie card** — populate the movie card's `movieId` + `collectionId` and make the card navigate to that movie's detail screen (in-collection cards only).
4. **Disambiguation buttons** — render the already-stored candidate `options` as selectable buttons; a tap feeds the canonical disambiguator back through the existing pure-code `resolve_option()` path (no new resolution logic, no golden re-record).
5. **TMDB external link** — when the assistant adds a TMDB-scraped movie, populate the `externalIds[].url` with `https://www.themoviedb.org/movie/{id}`.
6. **Navigate to a movie** — extend the navigator to resolve a movie across the user's collections (not only within a named collection) and dispatch the already-allowlisted `navigate_to_movie` UI action; ambiguous/unfound → clarify.

The work spans mc-service (Rust), the Expo frontend + BFF (TypeScript), and the movie-assistant agent (Python). No new projects, no new MCP servers, no new external dependencies.

## Technical Context

**Language/Version**: Rust 1.x (mc-service); TypeScript / React Native 0.85 + Expo SDK 56 (mcm-app); Python 3.13 + uv (movie-assistant)

**Primary Dependencies**: Axum + Tokio + mongodb crate + medi-rs (mc-service); Expo Router + Axios + CopilotKit `@copilotkit/react-native` (mcm-app); LangGraph + MCP (movie-assistant). No new dependencies introduced.

**Storage**: MongoDB `mc_db` (`movies`, `movie_collections`) — unchanged schema; one new compound index for sort. Redis (BFF sessions) — unchanged. Agent `agent-db` (Postgres checkpointer) — unchanged.

**Testing**: cargo test / cargo test --test (mc-service unit + integration); Jest (mcm-app unit + BFF integration); Playwright (web E2E) + Maestro (mobile E2E); pytest + golden-pair cassette replay (movie-assistant). All via Nx targets.

**Target Platform**: Web (React Native Web) + Android (Expo) for the client; Linux containers for mc-service / agent gateway / MCP.

**Project Type**: Polyglot monorepo — web/mobile frontend + BFF, Rust backend service, Python agent layer.

**Performance Goals**: Server-side sort + count (no client-side full-collection load); count via `count_documents`. Collection screen list page = 50 items (existing batch). No page may exceed the constitution's 2 s TTI budget; sort/filter changes re-fetch page 1 only.

**Constraints**: Additive & non-breaking (existing routes/handlers keep working). Cursor pagination must remain keyset (no `skip()`). Generative UI must render from the universal codebase (web + mobile). Agent identity propagation, HITL gates, and UI-action authorization unchanged.

**Scale/Scope**: Personal movie collections (tens–low-thousands of movies per collection). Sortable columns are the displayed movie-list columns; array-valued columns are excluded from server sort (see Research D1).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **Additive & Non-Breaking (Agent Architecture Boundaries)** | PASS — all six items extend existing routes/nodes/components; no existing API contract is removed. Sort/count params are optional (absent ⇒ current behaviour: count omitted, sort defaults to title→year). |
| **The BFF Remains the Security Boundary** | PASS — new BFF count route + clickable-card navigation go through existing BFF/agent routes; client never calls mc-service or the gateway directly. |
| **Agents Never Call Backend Services Directly / Identity Propagation** | PASS — navigator cross-collection resolution and the TMDB-url change use existing MCP tools with the propagated user JWT (token-exchange unchanged). No new ambient privilege. |
| **No Domain Logic in Agents / Frontend** | PASS — sort + count are mc-service domain/application concerns; the agent and frontend only request and present them. Card click and disambiguation selection carry no domain rules. |
| **Centralized Access Control** | PASS — mc-service sort/count handlers sit inside the existing `auth_layer` + `require_app_role` + per-handler DAC (`authorize_collection_access`, Viewer+). The new BFF count route follows the standard `requireAuth`→`requireMcUser`→`createMcServiceClient` proxy pattern. UI-action `movie-detail` target is already role-allowlisted. |
| **Clean Architecture (mc-service)** | PASS — sort flows Domain→Application(`ListMoviesParams`)→Adapter(cursor/index)→API(query param); CQRS query handlers reused; Specification pattern not needed (sort is query logic, not validation). |
| **AG-UI-Native / Universal Generative UI** | PASS — disambiguation buttons + clickable card are ordinary Components-Layer components rendered via CopilotKit `useRenderTool`; no server-only rendering. Card-click and button-tap are client UI-actions/messages, not bespoke BFF event translation. |
| **TDD + Test Type Integrity** | PASS (planned) — every change paired with tests; integration tests hit real mc-service/MCP; agent changes gate on golden replay. Disambiguation-button selection routes through pure-code `resolve_option()` to avoid a model-decision change (no golden re-record); navigator cross-collection resolution is pure code. Verify whether the supervisor intent prompt changes for cross-collection navigate — if it does, re-record intent cassettes. |
| **Platform Parity (web + mobile)** | PASS (planned) — sort, count, clickable card, disambiguation buttons, and navigate-to-movie all get Playwright + Maestro coverage; any N/A justified in the tasks.md parity table. |
| **Behavior-Descriptive Identifiers** | PASS (planned) — no `FR-###`/`US#` in identifiers; provenance recorded in comments only. |
| **SDD artifact separation** | PASS — spec.md stays technology-agnostic; this plan.md holds the HOW. |

No violations. Complexity Tracking table omitted (nothing to justify).

## Project Structure

### Documentation (this feature)

```text
specs/013-post-agent-enhancements/
├── plan.md              # This file
├── research.md          # Phase 0 — sort/cursor decision, disambiguation-button mechanism, count-line strategy
├── data-model.md        # Phase 1 — entities & contract deltas (sort params, count, card props, external-id url)
├── quickstart.md        # Phase 1 — how to run/verify each of the six items
├── contracts/           # Phase 1 — API + tool contract deltas
│   ├── mc-service-movies-sort.md
│   ├── bff-movies-count.md
│   └── agent-tool-deltas.md
├── checklists/
│   └── requirements.md  # (created by /speckit-specify)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root) — touched paths

```text
backend/mc-service/src/
├── application/ports/movie_repository.rs        # add sort fields to ListMoviesParams
├── application/queries/list_movies.rs           # thread sort through query
├── adapters/mongodb/movie_repository.rs         # compound (sort,_id) keyset cursor + sort spec; build_movie_filter unchanged
├── adapters/mongodb/indexes.rs                  # add compound sort index(es)
└── api/movies/list.rs                           # parse sortBy/sortDir query params (+ validation)

frontend/mcm-app/src/
├── app/bff-api/collections/[collectionId]/movies/
│   ├── index+api.ts                             # forward sortBy/sortDir to mc-service
│   └── count+api.ts                             # NEW BFF count route → mc-service GET …/movies/count
├── hooks/use-movies.ts                          # sort state; thread sortBy/sortDir; fetch filtered+total counts; refresh on revision
├── components/
│   ├── movie-sort-control.tsx                   # NEW sort UI (radio-button pattern; column-aware)
│   ├── movie-count-line.tsx                     # NEW info line (total or filtered/total)
│   └── agent/render-movie-card.tsx              # make card a TouchableOpacity → router.push detail
├── screens/collections/collection-screen.tsx    # mount sort control + count line
└── types/collection.ts                          # MovieListQuery sort fields; count types; card collectionId

agents/movie-assistant/src/
├── nodes/navigator.py                           # cross-collection movie resolution + clarify-on-ambiguous
├── nodes/curator.py                             # emit disambiguation-button generative-UI tool alongside text
├── tools/generative_ui_tools.py                 # render_movie_card carries movie_id+collection_id; new render_disambiguation tool
├── tools/ui_action_tools.py                     # (navigate_to_movie already exists — reuse)
└── proposals.py                                 # to_movie_payload adds externalIds[].url for tmdb

frontend/mcm-app/src/components/agent/
├── disambiguation-options.tsx                   # NEW button list; tap → send canonical pick message
├── assistant-dock.tsx                           # register the disambiguation render tool
└── ui-action-tools.tsx                          # (navigate_to_movie handler already exists — reuse)
```

**Structure Decision**: No new projects. Changes land in the three existing project trees (`backend/mc-service`, `frontend/mcm-app`, `agents/movie-assistant`) following each project's established layer conventions (Clean Architecture for Rust; App/BFF/Components/Screens/Utils/Hooks for the frontend; Orchestration/Tools for the agent). No MCP-server changes — `web-api-mcp` already returns the TMDB id and `movie-mcp`'s create accepts the `url` field.

## Phase 0 — Research

See [research.md](./research.md). Decisions resolved:

- **D1 Sort + keyset pagination** — adopt a compound `(sort-field, _id)` keyset cursor (Option A) so pagination follows the displayed sort order; the cursor encodes the sort key value + `_id` tiebreaker. Sortable fields restricted to scalar displayed columns (title, year, contentType, language, owned, ripped, childrens, rated, runtime); array columns (genres, directors, actors, ownedMedia, ripQuality) excluded from server sort. Add a `(collectionId, title, year, _id)` compound index for the default; other scalar sorts fall back to `(collectionId, _id)` + index-served sort where present — re-evaluate index coverage if profiling shows need.
- **D2 Count line** — frontend issues a count request with active filters for the numerator and, when a filter is active, a second unfiltered request for the denominator (skipped when no filter ⇒ one request). Re-fetch is driven by the existing `useFocusEffect` + `useAssistantDataRefresh` revision bump.
- **D3 Disambiguation buttons** — a new generative-UI render tool surfaces the existing `state["options"]`; a button tap posts the canonical disambiguator text (title+year or ordinal) into the chat so the unchanged pure-code `resolve_option()` resolves it — preserving the golden suite.
- **D4 Clickable card** — populate `movie_id` (mc-service id) + `collection_id` on the card tool call from the query/found path; the card becomes a `TouchableOpacity` reusing the existing `navigate_to_movie` route shape. In-collection cards only.
- **D5 Navigate-to-movie** — extend navigator to search the user's collections for the named movie when no collection is given; single match → dispatch `navigate_to_movie`; multiple → clarify. Confirm whether the intent prompt changes; if not, no golden re-record.
- **D6 TMDB url** — `to_movie_payload()` sets `url = https://www.themoviedb.org/movie/{uniqueId}` when `system == "tmdb"` and a uniqueId exists; no url when absent (no malformed link).

## Phase 1 — Design & Contracts

- [data-model.md](./data-model.md) — entity/field deltas (Movie sort fields, cursor shape, count response, card props, external-id url).
- [contracts/](./contracts/) — mc-service movies sort params + cursor; BFF count route; agent tool deltas.
- [quickstart.md](./quickstart.md) — per-item run/verify steps (Nx targets, E2E scopes, golden gate).
- Agent context: CLAUDE.md SPECKIT block updated to point at this plan.

**Post-design Constitution re-check**: No new violations introduced by the design. Sort stays keyset (no `skip()`), count reuses the existing server-side `count_documents` path, generative UI stays universal, and the agent changes preserve identity propagation and the golden gate.

---

## Increment 2 — Post-Testing Bug Fixes & Enhancements (US7–US10)

Second increment on the same branch. Planned for the new stories only (US1–US6 already shipped).
Research decisions: [research-increment2.md](./research-increment2.md) (R-I2-1…R-I2-6).

### Summary

US7 unified assistant **search workflow** (replaces the separate find/navigate resolution for
movie-search prompts; fixes Bug 1 generic-collection resolution + Bug 2 multi-match auto-open),
US8 **article-insensitive search** (Bug 3), US9 **article-insensitive title sort** (New Scope 2),
US10 **clickable TMDB link** on the web-search preview card (New Scope 3). Reuses the 012 agent
stack, 013 generative-UI components, and the US1 keyset-sort machinery.

### Constitution Check (Increment 2)

- **Centralized Access Control** ✅ — reuse mc-service `auth_layer`/`require_app_role`, BFF
  `requireAuth`/`requireMcUser`, and the `/ui-action` `ui-action-authorizer`. No new BFF handler
  needs auth code; any new agent route joins `AGENT_ROUTES` + `route-coverage-map` (deny-by-default).
- **Universal Generative UI** ✅ — `render_selection` + the web preview card are single RN components
  rendered identically on web + Android; web/mobile E2E parity required.
- **TDD (NON-NEGOTIABLE)** ✅ — every story leads with RED tests; Verify RED/GREEN in tasks.
- **Evaluation / Golden-pair gate** ⚠️ EXPECTED CHANGE — the `search` intent forces an intent
  cassette re-record on qwen2.5 + Claude (R-I2-5). Documented, not a deviation; pure-code resolution
  keeps everything else off the golden surface.
- **Behavior-Descriptive Identifiers** ✅ — no FR ids in code; provenance in comments.
- **Test Type Integrity** ✅ — integration tests hit real MCP + mc-service (no mocks).
- No constitution deviations requiring human approval.

### Per-layer design + critical files

**mc-service (US9 — Rust/Axum/Mongo):**
- `src/adapters/mongodb/movie_repository.rs` — derive + persist `titleSort` (lowercase + leading
  `a/an/the` stripped) in the DAO on create/update; the title sort path orders by `titleSort`; the
  keyset cursor's primary value becomes `titleSort` for `sortBy=title`/default.
- `src/adapters/mongodb/indexes.rs` — new `sort_titlesort_year {collectionId,titleSort,year,_id}`.
- A one-shot **backfill** of `titleSort` for existing movies on startup (or a migration helper) so
  the index is populated; unit-test the normalization + cursor; integration-test sorted pagination.
- Article-normalization is a pure helper (domain/adapter) — no FR ids in the name.

**Agent (US7/US8 — Python/LangGraph):**
- `src/nodes/supervisor.py` — add the `search` intent + route the search keywords/bare-title to it.
- `src/nodes/search.py` (new) — the staged search state machine (R-I2-2): pure-code collection
  resolution (ui_snapshot → default → only → scope buttons), owned search (movie-mcp, article-
  insensitive), web search (web-api-mcp), result/control/scope buttons, owned→navigate_to_movie,
  web→preview card, exit. Reuse `organizer._match_movie` (title,year) + a shared article-strip helper.
- `src/tools/generative_ui_tools.py` — `render_selection(options[{label,value,kind}])`; web preview
  card props (extend `render_movie_card` with `url` + an add affordance flag).
- `src/graph.py` / `runtime_nodes.py` — wire the `search` node + production factory.
- `src/eval/` golden — re-record intent cassettes; add a `search-routing` golden kind.

**Frontend (US7/US10 — RN/Expo):**
- `src/components/agent/disambiguation-options.tsx` → generalize to a selection component (label +
  value, ≤5 + overflow) OR add `selection-options.tsx`; register `render_selection` in
  `assistant-dock.tsx`.
- `src/components/agent/render-movie-card.tsx` — web variant: clickable `themoviedb.org` link (reuse
  the detail-screen `openUrl` + US5 url pattern) + an "add to collection" button that posts the add
  message via the dock send path.
- Reuse the existing `navigate_to_movie` UI-action client for owned picks.

### Golden re-record plan (R-I2-5)

1. Change `supervisor.py` intent prompt (+ `search` label, few-shot for the keywords).
2. Delete the stale intent cassettes; `LLM_CASSETTE_MODE=record pnpm nx test:golden movie-assistant`
   against Ollama (qwen2.5) AND `MODEL_PROVIDER=anthropic … ANTHROPIC_API_KEY=… record` for the gate.
3. `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant` → green (drift-proof CI gate).
4. Verify the classifier on the RUNTIME model (qwen2.5), not just Claude.

### Test strategy (per constitution)

- **mc-service**: unit (titleSort normalize + cursor titleSort encode/boundary), integration
  (`movie_sort` extended — article-insensitive global order across pages), backfill test. ≥70% cov.
- **Agent**: unit (search state machine: each resolution branch, disambiguation, web fallback, exit,
  pure-code picks; article match; no-article-injection) + golden replay (re-recorded) + SC-004
  leak-scan + integration vs real MCP+mc-service.
- **Frontend**: unit (selection component label/value/overflow; web card link + add).
- **E2E (web + mobile parity)**: the search workflow end-to-end (resolve→disambiguate→pick→navigate;
  web fallback→preview; exit), article-insensitive sort, web-card link — run vs the dev container +
  containerized gateway (web) and the emulator + `:8123` gateway proxy (mobile), as in Increment 1.

### Phase 1 artifacts (Increment 2)

- [research-increment2.md](./research-increment2.md) — R-I2-1…R-I2-6.
- data-model deltas: Movie gains `titleSort`; new `SearchWorkflowState` (search_stage/scope/results);
  `render_selection` option shape; web-card `url` + add-affordance. (Captured in data-model.md.)
- Contracts: agent tool deltas (`render_selection`, web card); no new BFF route expected (reuse
  `/run` + `/ui-action`).

**Post-design Constitution re-check (Increment 2)**: compliant; the only flagged item is the
expected golden re-record (Evaluation gate), which is a documented model-decision change, not a
deviation.
