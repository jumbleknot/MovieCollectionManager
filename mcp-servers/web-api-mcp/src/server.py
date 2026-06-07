"""web-api-mcp MCP server: registers the TMDB tools over streamable-HTTP.

Implements: T022. Outbound-only — no internal-network access (no backend-network), egress
to TMDB only. Carries NO per-user token: it authenticates to TMDB with its own v3 API key
from the environment (Vault-injected in prod), read lazily so it is never captured at
import. The key is never logged or placed in agent context. Tool errors surface as MCP
tool errors (FR-018). Stateless streamable-HTTP.
"""

from __future__ import annotations

import os
from typing import Any

from mcp.server.fastmcp import FastMCP

from src import tools

mcp = FastMCP("web-api-mcp", stateless_http=True, json_response=True)


def _tmdb_key() -> str:
    return os.environ.get("TMDB_API_KEY", "")


def _tmdb_base_url() -> str | None:
    return os.environ.get("TMDB_BASE_URL") or None


@mcp.tool()
async def search_title(query: str, year: int | None = None) -> dict[str, Any]:
    """Search TMDB for a title; returns a typed matchConfidence (never fabricates)."""
    async with tools.make_tmdb_client(_tmdb_key(), _tmdb_base_url()) as client:
        return await tools.search_title(client, query, year)


@mcp.tool()
async def get_movie_details(sourceId: str) -> dict[str, Any]:  # noqa: N803 (MCP arg name)
    """Fetch full TMDB details as an EnrichedMovieCandidate (shaped for the mc-service add)."""
    async with tools.make_tmdb_client(_tmdb_key(), _tmdb_base_url()) as client:
        return await tools.get_movie_details(client, sourceId)


def build_app() -> Any:
    """Streamable-HTTP ASGI app (no token middleware — web-api-mcp carries no user token)."""
    return mcp.streamable_http_app()


def main() -> None:
    """Container entrypoint — serve the streamable-HTTP app (outbound-only)."""
    import uvicorn

    host = os.environ.get("WEB_API_MCP_HOST", "0.0.0.0")  # noqa: S104 (container bind)
    port = int(os.environ.get("WEB_API_MCP_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
