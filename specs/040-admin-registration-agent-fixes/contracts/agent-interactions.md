# Contract: Agent Interaction Surfaces (Items 2 & 4)

These are the assistant-facing interaction contracts. All reuse existing surfaces (`render_selection` buttons, `navigate_*` UI-action tool calls) — no new transport, no new intents. Only Item 4(b) touches the golden (model-decision) surface.

---

## Item 2 — Add-from-TMDB: ownership question → add → navigate

**Flow (single add session)**:
1. Curator enriches a TMDB match → movie-card preview (unchanged, read-only).
2. **Ownership stage** (`organizer._add`, `add_stage = "awaiting_ownership"`): the assistant emits a `render_selection` prompt:
   - question: "Do you own this movie?"
   - options: `[{label:"Yes", value:<yes-token>}, {label:"No", value:<no-token>}]`
   - The candidate + resolved target collection are stashed in state; the turn ends.
3. Next turn resolves the tap → sets `owned` (Yes→true, No→false) → `build_add_proposal` → approval card (existing HITL `interrupt`).
4. On approve → `apply_proposal` calls movie-mcp `add_movie` → mc-service creates the movie with the chosen `owned`.
5. **Post-add navigation**: `apply_proposal` captures the created `movieId` from the add `ExecOutcome.data` and emits an `AIMessage` tool call:
   - `{ name: "navigate_to_movie", args: { collectionId, movieId } }`
   - Client (`ui-action-tools.tsx`) authorizes via BFF `/bff-api/agent/ui-action` (target `"movie-detail"`, default-deny) then `router.push('/collections/{collectionId}/movies/{movieId}')`.

**Contract invariants** (assert in tests):
- The ownership question is emitted **before** any write (no `add_movie` call before the answer).
- `owned` in the movie payload equals the user's answer (not hardcoded true).
- A "No" answer still results in an add to the chosen collection (`owned=false`).
- After a successful add, exactly one `navigate_to_movie` tool call is emitted with the created `collectionId`+`movieId`.
- Decline/cancel at the ownership prompt or the approval card ⇒ **no** `add_movie` call.
- No new intent introduced; the flow stays under the existing `add` intent (off-golden).

---

## Item 4 — Navigate-to-collection: stateful disambiguation + classifier

### 4(a) — Stateful `navigate_stage` (pure code)

**Flow**:
1. "navigate to &lt;name&gt;" → `navigate` intent → navigator.
2. If exactly one collection resolves → emit `navigate_to_collection` (existing) and open it.
3. If ambiguous/none-exact → `navigator._clarify` sets `navigate_stage` and emits a `render_selection` with buttons whose `value` is a **bare stage-anchored token** (NOT `"open <name>"`).
4. The tap re-enters the graph; the `graph.py` `navigate_stage` continuation guard keeps it in the navigator, which resolves the token to the chosen collection and emits `navigate_to_collection`.

**Contract invariants** (assert in tests):
- A disambiguation tap results in `navigate_to_collection` for the chosen collection — **never** a movie `search` inside the on-screen collection.
- The button `value` does not carry a verb that the intent classifier maps to `search`.
- `navigate_stage`/`navigate_options` are cleared after resolution (no leak into the next turn).

### 4(b) — Classifier distinguishes "navigate to &lt;collection&gt; collection" (GOLDEN)

**Change**: the `supervisor.py` intent-classifier prompt routes an utterance with a navigate cue + the word "collection" naming an owned collection to `navigate` (not `search`).

**Golden discipline (FR-023)**:
- Re-record `tests/golden/cassettes/us7-intent-search-navigate.json`.
- **Human approval required** before merge — surfaced explicitly at implementation time.

**Contract invariants** (assert in unit/routing tests + golden):
- "navigate to Test Import collection" (with owned "Test Import") → `navigate`.
- "navigate to &lt;movie title&gt;" (a film to find) → still `search` (no regression).
- After navigation fires, the on-screen collection advances (the "stuck on Movie Collection" symptom does not recur).

---

## Item 3 — (no new interaction contract)

Item 3 changes internal reliability of the existing import interaction (re-ask on unparsed answer, always-surface errors, un-throttled dedup reads, handle-based state). Its observable contract: **the import never ends with a blank/no reply**, an answered clarification always advances the import, and a large import completes to the approval/apply step. Covered by the existing import unit/integration suites (extended), not a new surface here.
