# Contract: Generative-UI Tools & UI-Action Tools

**Feature**: `012-multi-agent-mvp` | `agents/movie-assistant/src/tools/{generative_ui_tools,ui_action_tools}.py` + client adapters `frontend/mcm-app/src/components/agent/render-*.tsx` (via CopilotKit `useRenderTool`).

Fixed naming so the BFF routes results to the correct AG-UI event **without inspecting orchestration internals**: generative-UI = `render_*`, UI-action = `navigate_*` / `prefill_*`. Generative UI renders from the **shared universal codebase** (web + mobile) using existing Components-Layer components — **no** React Server Components / `streamUI` (constitution Universal Generative UI). UI actions are **allowlisted**; unknown/unauthorized actions are audited and discarded at the BFF.

---

## Generative-UI tools (return structured props only; client renders)

### `render_movie_card`
- **Props**:
```jsonc
{ "movieId": "string | null", "title": "…", "year": 1982, "posterUrl": "…",
  "genres": ["…"], "overview": "…", "source": "tmdb | mc-service",
  "proposalItemId": "string | null" }   // links a preview card to a pending ProposalItem
```
- **Renders**: existing movie-card / movie-detail Components-Layer component, inline in chat.

### `render_collection_summary`
- **Props**: `{ "collectionId": "…", "name": "…", "movieCount": 0, "role": "owner|contributor|viewer" }`
- **Renders**: existing collection summary component. (A "wishlist" renders here too — it is a user-named collection.)

### `render_wishlist`
- **Props**: `{ "collectionId": "…", "name": "…", "movies": [MovieRef…] }`
- **Renders**: the same collection/list component as above; alias retained for the PRD's named capability.

**Data path**: generative-UI tools fetch via `movie-mcp` (downscoped JWT) then return props — they perform no writes and carry no token to the client.

---

## UI-action tools (return a client instruction; no MCP server involved)

All `navigate_*` targets are authorized at the BFF against the user's JWT roles before emission (UI-Action Authorisation). `prefill_*` that affect **unsaved** user state are HITL-gated (constitution).

### `navigate_to_collection`
- **Args**: `{ "collectionId": "string" }`
- **Effect**: client navigates to that collection screen — only if the user is authorized for it.

### `navigate_to_movie`
- **Args**: `{ "collectionId": "string", "movieId": "string" }`
- **Effect**: navigate to the movie-detail screen.

### `prefill_add_movie`
- **Args**: `{ "collectionId": "string", "movie": MoviePayloadDraft }`
- **Effect**: opens + pre-fills the existing add-movie form on the current collection (does **not** submit — the user still confirms). Pre-filling unsaved fields is HITL-surfaced.

---

## Invariants

- Generative UI is identical on web + mobile (universal components; no server-rendered UI).
- UI actions are allowlisted and role-authorized at the BFF; anything else is audited + discarded.
- No tool here writes domain data; writes go only through `movie-mcp` on the approved-resume path.
- Emitted events are native AG-UI; the BFF proxies them unchanged.
