# web-api-mcp — MCP server for external movie metadata (feature 012)

A stateless **streamable-HTTP MCP server** that enriches movie metadata from **TMDB** for the
curator. **Outbound-only** (no `backend-network`, no mc-service, no user token) — it touches no
domain data and carries no identity; the TMDB key is the user's own, forwarded per request by the
gateway as the `X-TMDB-Key` header (there is no shared/server-side key).

Tool contract: [`../../specs/012-multi-agent-mvp/contracts/web-api-mcp-tools.md`](../../specs/012-multi-agent-mvp/contracts/web-api-mcp-tools.md).

## Tools (`src/tools.py`)

| Tool | Returns |
|---|---|
| `search_title` | typed `matchConfidence` ∈ `none` \| `exact` \| `ambiguous` + results |
| `get_movie_details` | `EnrichedMovieCandidate` (year from release_date, poster CDN URL, original-language) |

TMDB errors → MCP tool errors (`isError`, FR-018). The curator fetches details only on an
`exact` match; `ambiguous` → offer options (disambiguation), `none` → "couldn't find it".

## Commands

```bash
pnpm nx test:integration web-api-mcp          # vs REAL TMDB (needs TMDB_API_KEY; skips if absent)
pnpm nx lint web-api-mcp                       # ruff + mypy
# Run standalone over HTTP:
cd mcp-servers/web-api-mcp && WEB_API_MCP_PORT=8765 WEB_API_MCP_HOST=127.0.0.1 \
  uv run python -m src.server   # callers must send X-TMDB-Key
```

`TMDB_API_KEY` (read by the integration tests) lives in `mcp-servers/web-api-mcp/.env.local` (gitignored). No application logging
(SC-004 — verified by the token-leak scan; though this server carries no user token anyway).
