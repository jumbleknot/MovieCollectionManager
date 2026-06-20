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
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

# Request-local; default None when no run is active. Never checkpointed.
_subject_token: ContextVar[str | None] = ContextVar("agent_subject_token", default=None)
# Request-local sanitized UI snapshot for context-aware "this" resolution (US3/R15). The BFF
# sends it as the `X-UI-Snapshot` header (already allowlist-sanitized); the gateway bridges it
# into config["configurable"]["ui_snapshot"]. Structural, non-secret; never checkpointed.
_ui_snapshot: ContextVar[dict[str, Any] | None] = ContextVar("agent_ui_snapshot", default=None)
# Request-local import-file reference for the import flow (014 US2). The BFF sends it as the
# `X-Import-File` header — a JSON object `{handle, filename}` naming the transient upload store
# entry; the gateway bridges it into config["configurable"] (file_handle/filename). The handle is
# an opaque store key (NOT file bytes, NOT a credential); never checkpointed.
_import_file: ContextVar[dict[str, Any] | None] = ContextVar("agent_import_file", default=None)
# Request-local per-user agent config (018 US2). The BFF sends the run-scoped resolved config
# (provider / model base URL / decrypted provider+TMDB keys) as the `X-Agent-Config` header; the
# gateway bridges it into config["configurable"]["agent_config"], and each model-building node
# RE-SETS it on this ContextVar within its own task (see runtime_nodes) so the pure model-build
# closures — which receive no `config` — source the per-run provider/keys here instead of the
# shared process env. INVARIANT (SC-004/SC-006): it carries secrets, so it is NEVER written to
# GraphState, the checkpoint, traces, or logs (state.forbid_token_fields + the leak scan guard it).
_agent_config: ContextVar[dict[str, Any] | None] = ContextVar("agent_config", default=None)


def get_subject_token() -> str | None:
    """The current request's run-scoped subject token, or None outside a request."""
    return _subject_token.get()


def get_ui_snapshot() -> dict[str, Any] | None:
    """The current request's sanitized UI snapshot (US3/R15), or None outside a request."""
    return _ui_snapshot.get()


def get_import_file() -> dict[str, Any] | None:
    """The current request's import-file reference `{handle, filename}`, or None (014 US2)."""
    return _import_file.get()


def get_agent_config() -> dict[str, Any] | None:
    """The current run's per-user agent config (018 US2), or None when unset.

    Read by the model-build closures (curator/organizer/query) to source the per-run provider +
    keys. The value is set by the request-task middleware (for the prepare_stream bridge) and
    re-set per node task by `agent_config_scope` (for the deep model build).
    """
    return _agent_config.get()


@contextmanager
def agent_config_scope(cfg: dict[str, Any] | None) -> Iterator[None]:
    """Bind the per-run agent config to the ContextVar for the duration of a node's execution.

    The graph's per-node executor runs in a task that does NOT reliably inherit the value the
    ASGI middleware set at the request boundary (same reason the subject token is bridged via
    `config["configurable"]`). A model-building node therefore re-sets it here — from its own
    `config["configurable"]["agent_config"]` — inside its own task, so the synchronous model
    build that follows (same task) observes it. Reset on exit so it never leaks across runs.
    """
    token = _agent_config.set(cfg)
    try:
        yield
    finally:
        _agent_config.reset(token)


def parse_agent_config(header: str | None) -> dict[str, Any] | None:
    """Parse the `X-Agent-Config` header into a config dict, or None if absent/invalid.

    Fail-safe (mirrors `parse_ui_snapshot`): anything that isn't a JSON object yields None so a
    corrupt header degrades to the off/short-circuit behaviour rather than a half-applied config.
    """
    if not header:
        return None
    try:
        parsed = json.loads(header)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_import_file(header: str | None) -> dict[str, Any] | None:
    """Parse the `X-Import-File` header into `{handle, filename}`, or None if absent/invalid.

    Fail-safe: anything that isn't a JSON object with a non-empty `handle` yields None (the import
    node then asks the user to attach a file rather than acting on a corrupt reference).
    """
    if not header:
        return None
    try:
        parsed = json.loads(header)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict) or not str(parsed.get("handle") or "").strip():
        return None
    return parsed


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


def make_header_context_middleware(
    name: str,
    header: bytes,
    ctx_var: ContextVar[Any],
    parse: Callable[[str | None], Any],
) -> Callable[[ASGIApp], ASGIApp]:
    """Build a pure-ASGI middleware that binds one request header to a ContextVar (018 review #9).

    One generalized per-run-config channel replaces the four near-identical copies (subject token /
    UI snapshot / import file / agent config) — the SC-004 discipline (set in the request task so
    the graph run observes it, reset in `finally` so it never leaks across requests, HTTP-only) now
    lives in EXACTLY ONE place. `header` is the lowercased header name bytes; `parse` maps the raw
    decoded header (or None) to the value stored on `ctx_var`. The captured value may carry
    identity/secrets and is never logged.
    """

    class _HeaderContextMiddleware:
        def __init__(self, app: ASGIApp) -> None:
            self.app = app

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            if scope.get("type") != "http":
                await self.app(scope, receive, send)
                return

            raw: str | None = None
            for hname, value in scope.get("headers", []):
                if hname == header:
                    raw = value.decode("latin-1")
                    break

            ctx = ctx_var.set(parse(raw))
            try:
                await self.app(scope, receive, send)
            finally:
                ctx_var.reset(ctx)

    _HeaderContextMiddleware.__name__ = name
    _HeaderContextMiddleware.__qualname__ = name
    return _HeaderContextMiddleware


# The four per-run channels (T023 subject token, US3/R15 UI snapshot, 014 import file, 018 US2
# agent config) — same mechanism, one factory. The gateway (gateway.py) adds these by name.
SubjectTokenMiddleware = make_header_context_middleware(
    "SubjectTokenMiddleware", b"authorization", _subject_token, extract_bearer
)
UiSnapshotMiddleware = make_header_context_middleware(
    "UiSnapshotMiddleware", b"x-ui-snapshot", _ui_snapshot, parse_ui_snapshot
)
ImportFileMiddleware = make_header_context_middleware(
    "ImportFileMiddleware", b"x-import-file", _import_file, parse_import_file
)
AgentConfigMiddleware = make_header_context_middleware(
    "AgentConfigMiddleware", b"x-agent-config", _agent_config, parse_agent_config
)
