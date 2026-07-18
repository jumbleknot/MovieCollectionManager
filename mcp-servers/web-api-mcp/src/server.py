"""web-api-mcp MCP server: registers the TMDB tools over streamable-HTTP.

Implements: T022. Outbound-only — no internal-network access (no backend-network), egress
to TMDB only. Carries NO per-user token: it authenticates to TMDB with the requesting USER's
own v3 API key, forwarded per request by the gateway as the `X-TMDB-Key` header (FR-021).
There is NO shared/operator TMDB key — per-user credentials only (PRD-Vault). The key is never
logged or placed in agent context. Tool errors surface as MCP tool errors (FR-018). Stateless
streamable-HTTP.
"""

from __future__ import annotations

import logging
import os
import re
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


# Per-request TMDB key: the user's own v3 key, supplied by the gateway as the `X-TMDB-Key` header
# (FR-021). Bound by `TmdbKeyMiddleware` into this request-local ContextVar — never logged
# (SC-004 scan). This is the SOLE source of the TMDB key: there is NO shared env/Vault fallback
# (FR-021 / PRD-Vault — per-user credentials only; no-fallbacks decision 2026-06-19).
_request_tmdb_key: ContextVar[str | None] = ContextVar("request_tmdb_key", default=None)


def _tmdb_key() -> str:
    """TMDB v3 api_key for the current call — the per-request `X-TMDB-Key` key, and nothing else.

    There is NO shared env/Vault fallback (intentional, per the per-user-credentials design): when
    no per-request key is bound, RAISE a clear configuration error rather than issue an
    unauthenticated TMDB request that 401s and surfaces as a confusing "couldn't find it". The
    gateway MUST forward the user's key as `X-TMDB-Key` on every web-api-mcp call.
    """
    per_request = _request_tmdb_key.get()
    if not per_request:
        raise RuntimeError(
            "No TMDB key for this call: the request carried no X-TMDB-Key and there is no shared "
            "fallback (by design — per-user credentials only). The gateway must forward the user's "
            "TMDB key as X-TMDB-Key on every web-api-mcp call."
        )
    return per_request


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


class _RedactApiKeyFilter(logging.Filter):
    """Redact `api_key=<secret>` from ANY log record (defense in depth).

    TMDB v3 authenticates via an `api_key` QUERY PARAM, so the secret is embedded in every request
    URL. Anything that stringifies that URL into a log leaks the user's key.
    """

    _PATTERN = re.compile(r"(api_key=)[^&\s\"']+")

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str) and "api_key=" in record.msg:
            record.msg = self._PATTERN.sub(r"\1[REDACTED]", record.msg)
        if record.args:
            args = record.args if isinstance(record.args, tuple) else (record.args,)
            record.args = tuple(
                self._PATTERN.sub(r"\1[REDACTED]", a)
                if isinstance(a, str) and "api_key=" in a
                else a
                for a in args
            )
        return True


def _silence_credential_logging() -> None:
    """Stop the user's TMDB key from reaching the logs (FR-021 / SC-004).

    httpx logs every request at INFO as `HTTP Request: GET <full-url> "HTTP/1.1 200 OK"`, and the
    TMDB v3 URL carries `?api_key=<SECRET>` — so a SUCCESSFUL call leaked the key to stdout, which
    CI captures into container logs and uploads as an artifact. (The sibling OTel-span leak was
    already closed in `observability.tool_span`; this closes the logging one.) Raise httpx to
    WARNING to drop the per-request line, and attach a redacting filter to the root handler so any
    other path that stringifies the URL is scrubbed too.
    """
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    redactor = _RedactApiKeyFilter()
    root = logging.getLogger()
    root.addFilter(redactor)
    for handler in root.handlers:
        handler.addFilter(redactor)


def build_app() -> Any:
    """Streamable-HTTP ASGI app, wrapped to capture the per-run `X-TMDB-Key` header (FR-021).

    The user's TMDB key arrives per request from the gateway; there is NO shared env/Vault key to
    prime (per-user credentials only). `_tmdb_key()` raises if a call arrives without one.
    """
    from src.observability import configure_otel

    _silence_credential_logging()  # must precede any TMDB call — see the docstring above
    configure_otel()  # OTel infra tracing (T030b) — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT set
    return TmdbKeyMiddleware(mcp.streamable_http_app())


def main() -> None:
    """Container entrypoint — serve the streamable-HTTP app (outbound-only)."""
    import uvicorn

    host = os.environ.get("WEB_API_MCP_HOST", "0.0.0.0")  # noqa: S104 (container bind)
    port = int(os.environ.get("WEB_API_MCP_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
