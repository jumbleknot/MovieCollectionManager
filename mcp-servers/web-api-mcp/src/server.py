"""web-api-mcp MCP server: registers the TMDB tools over streamable-HTTP.

Implements: T022. Outbound-only — no internal-network access (no backend-network), egress
to TMDB only. Carries NO per-user token: it authenticates to TMDB with its own v3 API key
from the environment (Vault-injected in prod), read lazily so it is never captured at
import. The key is never logged or placed in agent context. Tool errors surface as MCP
tool errors (FR-018). Stateless streamable-HTTP.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
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

# Per-request TMDB key (018 US2): the user's own v3 key, supplied by the gateway as the
# `X-TMDB-Key` header so this server uses per-user credentials instead of a shared key (FR-021).
# Bound by `TmdbKeyMiddleware` into this request-local ContextVar — never logged (SC-004 scan).
_request_tmdb_key: ContextVar[str | None] = ContextVar("request_tmdb_key", default=None)


def _static_tmdb_key() -> str:
    """Resolve + cache the shared/static TMDB key (env/Vault). Empty string when none is set.

    Tolerant of an absent key so `build_app()` can prime the cache off the async hot path even in
    a per-user-only deployment (where no shared key exists). The resolution can do a blocking Vault
    round-trip (hvac uses synchronous `requests`), so it is primed once at startup and cached for
    the process lifetime; `None` is the "not yet primed" sentinel, `""` is a valid primed value.
    """
    global _tmdb_key_cache
    if _tmdb_key_cache is None:
        from src.secrets import resolve_secret

        _tmdb_key_cache = resolve_secret("TMDB_API_KEY") or ""
    return _tmdb_key_cache


def _tmdb_key() -> str:
    """TMDB v3 api_key for the current call.

    Prefers the PER-REQUEST key the gateway forwarded as `X-TMDB-Key` (018 US2 / FR-021): the
    user's own credential, scoped to this run, never persisted. Falls back to the static env/Vault
    key (dev / tests / non-user paths). When neither is available, RAISE rather than issue an
    unauthenticated TMDB request that 401s and surfaces as a confusing "couldn't find it" (018
    review #6) — a missing credential is a configuration error, not an empty search result.
    """
    per_request = _request_tmdb_key.get()
    if per_request:
        return per_request
    static = _static_tmdb_key()
    if not static:
        raise RuntimeError(
            "No TMDB key available for this call: the request carried no X-TMDB-Key and no shared "
            "TMDB_API_KEY is configured. In the per-user runtime the gateway must forward the "
            "user's key; configure a fallback TMDB_API_KEY only for dev/test."
        )
    return static


Scope = dict[str, Any]
Receive = Callable[[], Awaitable[Any]]
Send = Callable[..., Awaitable[Any]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class TmdbKeyMiddleware:
    """Pure ASGI middleware binding the request's `X-TMDB-Key` header to a ContextVar (018 US2).

    Pure ASGI (not BaseHTTPMiddleware) so the value is set in the same task that runs the tool
    handler — `_tmdb_key()` (same task) then observes it. Reset after the request so a key never
    leaks across requests. Non-HTTP scopes (lifespan) pass through untouched. Never logs the key.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        key: str | None = None
        for name, value in scope.get("headers", []):
            if name == b"x-tmdb-key":
                key = value.decode("latin-1") or None
                break

        ctx = _request_tmdb_key.set(key)
        try:
            await self.app(scope, receive, send)
        finally:
            _request_tmdb_key.reset(ctx)


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
    """Streamable-HTTP ASGI app, wrapped to capture the per-run `X-TMDB-Key` header (018 US2).

    The user's TMDB key arrives per request from the gateway (FR-021); the static env/Vault key is
    only a fallback. Priming the fallback at startup keeps any Vault round-trip off the async hot
    path; it is best-effort now that a shared key may be absent in the user-facing runtime.
    """
    from src.observability import configure_otel

    configure_otel()  # OTel infra tracing (T030b) — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT set
    # Prime the static fallback cache (tolerant — may be "" in a per-user-only deploy).
    _static_tmdb_key()
    return TmdbKeyMiddleware(mcp.streamable_http_app())


def main() -> None:
    """Container entrypoint — serve the streamable-HTTP app (outbound-only)."""
    import uvicorn

    host = os.environ.get("WEB_API_MCP_HOST", "0.0.0.0")  # noqa: S104 (container bind)
    port = int(os.environ.get("WEB_API_MCP_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
