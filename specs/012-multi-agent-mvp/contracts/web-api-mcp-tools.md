# Contract: `web-api-mcp` Tool Server

**Feature**: `012-multi-agent-mvp` | `mcp-servers/web-api-mcp/` (Python, MCP over Docker).

**Outbound-only** movie-metadata lookups (TMDB — research R2). **No internal-network access** (must NOT attach to `backend-network`); egress to TMDB only. **Read-only** — never writes domain data. API key injected from **Vault** at runtime (never in source/logs/context). Allowlist: **`curator`** only; `organizer` and `supervisor` may not call these.

Results are typed; "not found" / "ambiguous" are returned as structured outcomes — the agent never fabricates metadata (spec edge case). Rate/quota handled with backoff.

---

## `search_title`
- **Input**: `{ query: string, year?: number }`
- **Output**:
```jsonc
{
  "matchConfidence": "exact | ambiguous | none",
  "results": [
    { "sourceId": "tmdb:603", "title": "The Matrix", "year": 1999, "posterUrl": "…" }
  ]
}
```
- **Behavior**: `ambiguous` → multiple plausible matches returned for the user to choose; `none` → empty results + `matchConfidence:"none"`. Maps to TMDB search.

## `get_movie_details`
- **Input**: `{ sourceId: string }`  (e.g. `"tmdb:603"`)
- **Output**: an `EnrichedMovieCandidate`:
```jsonc
{
  "source": "tmdb",
  "sourceId": "tmdb:603",
  "title": "The Matrix",
  "year": 1999,
  "overview": "…",
  "genres": ["Action", "Science Fiction"],
  "posterUrl": "https://…",
  "language": "English"
}
```
- **Behavior**: shaped to what the `mc-service` add-movie payload accepts so the `curator`/`organizer` can build a proposal without domain transformation. Maps to TMDB details + external-ids.

---

## Invariants

- No internal network reachability; only TMDB egress.
- Read-only; no idempotency key (no writes).
- Fetched candidates are **not persisted** unless their proposal is approved (then written via `movie-mcp`).
- TMDB key from Vault; never logged or placed in agent context/prompt.
