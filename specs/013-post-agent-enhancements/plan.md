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
