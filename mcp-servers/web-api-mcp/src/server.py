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
from mcp.server.transport_security import TransportSecuritySettings

from src import tools

# DNS-rebinding Host validation is a browser-facing protection; the MCP SDK auto-enables it for
# the default localhost host and its `allowed_hosts` then 421-rejects a Docker service-name Host
# (e.g. `web-api-mcp:8000`), breaking containerized gateway→MCP calls. This server is reachable
# only on a private Docker network with the Agent Gateway as the sole caller, so disable it.
mcp = FastMCP(
    "web-api-mcp",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


_tmdb_key_cache: str | None = None


def _tmdb_key() -> str:
    """TMDB v3 api_key — resolved ONCE (Vault in prod, env in dev; T030a) and cached.

    Resolution can perform a blocking Vault round-trip (hvac uses synchronous `requests`), so it
    must never run on the per-request async hot path — that would stall the event loop on every
    tool call. It is primed at startup in build_app(); this lazy path is the fallback. The static
    key is cached for the process lifetime (a rotated key needs a restart, same as before).
    """
    global _tmdb_key_cache
    if _tmdb_key_cache is None:
        from src.secrets import resolve_secret

        _tmdb_key_cache = resolve_secret("TMDB_API_KEY")
    return _tmdb_key_cache


def _tmdb_base_url() -> str | None:
    return os.environ.get("TMDB_BASE_URL") or None


@mcp.tool()
async def search_title(query: str, year: int | None = None) -> dict[str, Any]:
    """Search TMDB for a title; returns a typed matchConfidence (never fabricates)."""
    from src.observability import tool_span

    with tool_span("search_title"):
        async with tools.make_tmdb_client(_tmdb_key(), _tmdb_base_url()) as client:
            return await tools.search_title(client, query, year)


@mcp.tool()
async def get_movie_details(sourceId: str) -> dict[str, Any]:  # noqa: N803 (MCP arg name)
    """Fetch full TMDB details as an EnrichedMovieCandidate (shaped for the mc-service add)."""
    from src.observability import tool_span

    with tool_span("get_movie_details"):
        async with tools.make_tmdb_client(_tmdb_key(), _tmdb_base_url()) as client:
            return await tools.get_movie_details(client, sourceId)


def build_app() -> Any:
    """Streamable-HTTP ASGI app (no token middleware — web-api-mcp carries no user token)."""
    from src.observability import configure_otel

    configure_otel()  # OTel infra tracing (T030b) — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT set
    _tmdb_key()  # prime the TMDB-key cache at startup — no Vault round-trip on the async path
    return mcp.streamable_http_app()


def main() -> None:
    """Container entrypoint — serve the streamable-HTTP app (outbound-only)."""
    import uvicorn

    host = os.environ.get("WEB_API_MCP_HOST", "0.0.0.0")  # noqa: S104 (container bind)
    port = int(os.environ.get("WEB_API_MCP_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
