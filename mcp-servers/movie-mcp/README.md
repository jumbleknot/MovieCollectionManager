# movie-mcp — MCP server for the movie-collection domain (feature 012)

A stateless **streamable-HTTP MCP server** (`FastMCP(stateless_http=True)`) that exposes the
user's collections/movies to the agent as thin tools over **mc-service** REST. It adds **no
domain logic** (FR-022) — it forwards mc-service shapes + errors verbatim — and carries the
caller's **downscoped `aud=mc-service` JWT** out-of-band so every call is the user's own identity
(never an LLM-visible tool arg, SC-004).

Tool contract + per-agent allowlist: [`../../specs/012-multi-agent-mvp/contracts/movie-mcp-tools.md`](../../specs/012-multi-agent-mvp/contracts/movie-mcp-tools.md).

## Tools (`src/tools.py`)

| Tool | Op | Notes |
|---|---|---|
| `list_collections` / `get_collection` / `list_movies` | read | keyset pagination; surfaces 404 (DAC/IDOR parity, feature 011) |
| `create_collection` / `add_movie` | write | `idempotencyKey` header; at-most-once via mc-service uniqueness (dup → 409 → `skipped_duplicate`) |
| `update_movie` / `delete_movie` | write | full-replacement update; 404 → `skipped_missing` |

Writes execute **only** on the agent's approved-resume path. mc-service 4xx/5xx are re-raised as
`McServiceToolError` carrying an `mc-service-status:<code>` sentinel so the gateway can classify
409/404 (T024a).

## Identity capture

`src/context.py` `TokenCaptureMiddleware` (pure-ASGI) captures `Authorization: Bearer` into a
request-scoped ContextVar; handlers read it via `get_request_token()` (fail-closed — no token →
`PermissionError`, never an unauthenticated mc-service call). **The token is never logged** — this
server has no application logging at all (verified by the SC-004 token-leak scan).

## Commands

```bash
pnpm nx test:integration movie-mcp           # vs REAL mc-service (skips if down)
pnpm nx lint movie-mcp                        # ruff + mypy
# Run standalone over HTTP (for agent integration tests):
cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \
  MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server
```

Network: `backend-network` only (reaches mc-service by service DNS); never published to clients.
