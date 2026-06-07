"""Per-request subject-token capture for the Agent Gateway (T024 piece 3).

The BFF supplies the run-scoped subject token as `Authorization: Bearer <token>` on each
AG-UI request. The gateway captures it into a ContextVar bound to the request so the (US1)
MCP-client tool path can read it at tool-call time via `get_subject_token()` and re-exchange
it (see `tools/identity.acquire_downscoped_token`).

INVARIANT (SC-004 / `state.forbid_token_fields`): the subject token lives ONLY in this
request-local ContextVar — it is never written to GraphState, the Postgres checkpoint,
traces, or logs.

Capture uses a PURE ASGI middleware, NOT Starlette's `BaseHTTPMiddleware`: the latter runs
the endpoint in a separate anyio task, which does not inherit a ContextVar set in the
middleware. A pure ASGI middleware sets the value in the same task that awaits the inner
app, so the graph run (and its tool calls) observe it.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

# Request-local; default None when no run is active. Never checkpointed.
_subject_token: ContextVar[str | None] = ContextVar("agent_subject_token", default=None)


def get_subject_token() -> str | None:
    """The current request's run-scoped subject token, or None outside a request."""
    return _subject_token.get()


def extract_bearer(authorization: str | None) -> str | None:
    """Return the token from an `Authorization: Bearer <token>` header value, else None."""
    if not authorization:
        return None
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return None
    token = authorization[len(prefix) :].strip()
    return token or None


Scope = dict[str, Any]
Receive = Callable[[], Awaitable[Any]]
Send = Callable[..., Awaitable[Any]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class SubjectTokenMiddleware:
    """Pure ASGI middleware that binds the request's bearer subject token to the ContextVar.

    Sets the token before delegating to the inner app and resets it afterward so it never
    leaks across requests. Only HTTP scopes are touched; other scopes pass through.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        authorization: str | None = None
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                authorization = value.decode("latin-1")
                break

        ctx_token = _subject_token.set(extract_bearer(authorization))
        try:
            await self.app(scope, receive, send)
        finally:
            _subject_token.reset(ctx_token)
