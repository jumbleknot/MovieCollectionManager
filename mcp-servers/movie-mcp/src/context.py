"""Per-request downscoped-token capture for movie-mcp (MCP transport, T043).

The gateway reaches movie-mcp over streamable-HTTP and supplies the gateway-exchanged
`aud=mc-service` JWT as the request `Authorization: Bearer` header — out-of-band, never an
LLM-visible tool argument (SC-004). `TokenCaptureMiddleware` (pure ASGI — NOT Starlette
`BaseHTTPMiddleware`, whose separate task would break ContextVar propagation, mirroring the
gateway's SubjectTokenMiddleware) captures it into a request-scoped ContextVar; tool
handlers read it via `get_request_token()`. The token is never logged or persisted.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from contextvars import ContextVar
from typing import Any

_request_token: ContextVar[str | None] = ContextVar("mc_request_token", default=None)

# Standard ASGI3 typing — kept local so this module has no framework dependency, while
# remaining structurally compatible with Starlette's app signature.
_Scope = MutableMapping[str, Any]
_Message = MutableMapping[str, Any]
_Receive = Callable[[], Awaitable[_Message]]
_Send = Callable[[_Message], Awaitable[None]]
_App = Callable[[_Scope, _Receive, _Send], Awaitable[None]]


def set_request_token(token: str | None) -> None:
    """Set (or clear, with None) the request-scoped downscoped token."""
    _request_token.set(token)


def current_request_token() -> str | None:
    """Peek the request-scoped token without raising (None when unset)."""
    return _request_token.get()


def get_request_token() -> str:
    """Return the request-scoped downscoped token; raise if absent (fail-closed).

    A movie-mcp tool call without a forwarded token is a misconfiguration or an attempt to
    reach mc-service without identity — refuse rather than call unauthenticated.
    """
    token = _request_token.get()
    if not token:
        raise PermissionError("no downscoped token in request context (forward Authorization)")
    return token


class TokenCaptureMiddleware:
    """Pure-ASGI middleware: capture `Authorization: Bearer` into the request ContextVar."""

    def __init__(self, app: _App) -> None:
        self.app = app

    async def __call__(self, scope: _Scope, receive: _Receive, send: _Send) -> None:
        if scope.get("type") == "http":
            headers = dict(scope.get("headers") or [])
            raw = headers.get(b"authorization")
            if raw is not None:
                value = raw.decode("latin-1")
                if value.lower().startswith("bearer "):
                    reset = _request_token.set(value[7:])
                    try:
                        await self.app(scope, receive, send)
                    finally:
                        _request_token.reset(reset)
                    return
        await self.app(scope, receive, send)
