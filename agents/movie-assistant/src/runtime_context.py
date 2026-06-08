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

import json
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

# Request-local; default None when no run is active. Never checkpointed.
_subject_token: ContextVar[str | None] = ContextVar("agent_subject_token", default=None)
# Request-local sanitized UI snapshot for context-aware "this" resolution (US3/R15). The BFF
# sends it as the `X-UI-Snapshot` header (already allowlist-sanitized); the gateway bridges it
# into config["configurable"]["ui_snapshot"]. Structural, non-secret; never checkpointed.
_ui_snapshot: ContextVar[dict[str, Any] | None] = ContextVar("agent_ui_snapshot", default=None)


def get_subject_token() -> str | None:
    """The current request's run-scoped subject token, or None outside a request."""
    return _subject_token.get()


def get_ui_snapshot() -> dict[str, Any] | None:
    """The current request's sanitized UI snapshot (US3/R15), or None outside a request."""
    return _ui_snapshot.get()


def parse_ui_snapshot(header: str | None) -> dict[str, Any] | None:
    """Parse the `X-UI-Snapshot` header value into a dict, or None if absent/invalid.

    Fail-safe: any malformed value (not a JSON object) yields None so the assistant clarifies
    rather than acting on a corrupt snapshot. The BFF is the sanitization point; this only
    transports the already-sanitized structural object.
    """
    if not header:
        return None
    try:
        parsed = json.loads(header)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


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


class UiSnapshotMiddleware:
    """Pure ASGI middleware that binds the request's `X-UI-Snapshot` header to a ContextVar.

    Mirrors `SubjectTokenMiddleware` (same pure-ASGI discipline so the value propagates into
    the graph run's task — `BaseHTTPMiddleware` would not). The BFF sends the BFF-sanitized
    snapshot per run; `IdentityAwareAGUIAgent.prepare_stream` bridges it into
    `config["configurable"]["ui_snapshot"]` for the organizer's "this" resolution (US3/R15).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        header: str | None = None
        for name, value in scope.get("headers", []):
            if name == b"x-ui-snapshot":
                header = value.decode("latin-1")
                break

        ctx = _ui_snapshot.set(parse_ui_snapshot(header))
        try:
            await self.app(scope, receive, send)
        finally:
            _ui_snapshot.reset(ctx)
