"""MCP tools: shared MCP client + per-agent allowlists + tool-call governance.

Implements: T018 (per-agent allowlists), T024 (gateway-side RFC 8693 re-exchange to
aud=mc-service + OPA authz, composed here), Slice F2 (the MCP→agent tool-call choke point).
Curator -> read-only; organizer -> read + write; supervisor -> none.

`invoke_tool` is the single path every agent tool call goes through; it composes the
governance + identity seams in order:

    is_tool_allowed -> AgentToolRateLimiter.check -> (movie-mcp) acquire downscoped token
    -> call_tool over streamable-HTTP -> guard_tool_output -> typed ToolOutcome.

Identity (research R3 / SC-004): the downscoped `aud=mc-service` token is acquired PER CALL
(the ≤60s cache lives in the injected `acquire_token`), forwarded out-of-band as the MCP
request's `Authorization: Bearer` via a dynamic `httpx.Auth` reading a ContextVar set
synchronously just before the call — NEVER an LLM-visible tool argument, never logged.
web-api-mcp carries no user token (outbound-only). The allowlist + composition are PURE/
injectable (unit-tested); the real streamable-HTTP transport (`call_mcp_tool`) is exercised
live in the curator/organizer integration tests.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable, Generator
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

import httpx

from src.guardrails.output_validators import guard_tool_output
from src.tools.agent_rate_limit import AgentRateLimitExceeded, AgentToolRateLimiter
from src.tools.identity import MC_SERVICE_AUDIENCE
from src.tools.token_exchange import TokenExchangeError

logger = logging.getLogger(__name__)

# Tool categories — names match contracts/movie-mcp-tools.md + web-api-mcp-tools.md.
_READ_TOOLS = frozenset(
    {"get_collection", "list_movies", "list_collections", "search_title", "get_movie_details"}
)
_WRITE_TOOLS = frozenset({"add_movie", "update_movie", "delete_movie", "create_collection"})

# Per-agent allowlists (least privilege, deny-by-default). Enforced by configuration.
_AGENT_ALLOWLISTS: dict[str, frozenset[str]] = {
    "supervisor": frozenset(),  # routes only — no domain tools
    "curator": _READ_TOOLS,  # discovery/enrichment — read-only
    "organizer": _READ_TOOLS | _WRITE_TOOLS,  # reorganization — reads + (HITL-gated) writes
}


def is_tool_allowed(agent: str, tool: str) -> bool:
    """Whether `agent` may call the MCP `tool`. Deny-by-default for unknown agent/tool."""
    return tool in _AGENT_ALLOWLISTS.get(agent, frozenset())


# ── Server config + result/outcome types ─────────────────────────────────────


@dataclass(frozen=True)
class McpServerConfig:
    """An MCP server the gateway connects to. `needs_token` marks user-identity servers."""

    name: str
    url: str
    needs_token: bool
    audience: str = MC_SERVICE_AUDIENCE


@dataclass
class McpCallResult:
    """Transport-level result of one MCP tool call (mapped from the SDK CallToolResult)."""

    is_error: bool
    data: Any
    text: str


@dataclass
class ToolOutcome:
    """The governed outcome surfaced to the planner (FR-018): success data or a safe error.

    `status` is the upstream mc-service HTTP status when the tool error carried one (T024a) —
    surfaced via movie-mcp's `mc-service-status:<code>` sentinel so the approval gate can
    classify a duplicate (409) as skipped_duplicate rather than a generic failure.
    """

    ok: bool
    data: Any | None = None
    error: str | None = None
    injection: list[str] = field(default_factory=list)
    status: int | None = None


# movie-mcp re-raises mc-service 4xx/5xx as a tool error prefixed with this sentinel (T024a).
_STATUS_SENTINEL = re.compile(r"mc-service-status:(\d{3})")


def _upstream_status(text: str | None) -> int | None:
    """Extract the upstream mc-service HTTP status from a tool-error text, if present."""
    match = _STATUS_SENTINEL.search(text or "")
    return int(match.group(1)) if match else None


def _is_transient_status(status: int | None) -> bool:
    """A 5xx is transient (retry may help); a 4xx is deterministic (do not retry)."""
    return status is not None and status >= 500


def _is_transient_exc(exc: BaseException) -> bool:
    """Whether a transport exception is worth retrying (connect/timeout/socket failure).

    The MCP streamable-HTTP client runs inside an anyio task group, so a connect failure
    surfaces as an ExceptionGroup wrapping the real httpx/OS error — unwrap it. A non-transport
    error (a bug) is NOT transient and propagates.
    """
    if isinstance(exc, BaseExceptionGroup):
        return any(_is_transient_exc(inner) for inner in exc.exceptions)
    return isinstance(exc, (httpx.TransportError, OSError))


# Injected dependencies (kept as types so `invoke_tool` is pure + unit-testable).
ToolCallFn = Callable[[str, str, dict[str, Any], str | None], Awaitable[McpCallResult]]
AcquireTokenFn = Callable[[str, str], Awaitable[str]]


# ── Per-call downscoped-token transport (out-of-band; never an LLM arg) ───────

_call_token: ContextVar[str | None] = ContextVar("mcp_call_token", default=None)


class DownscopedTokenAuth(httpx.Auth):
    """httpx auth that injects the per-call downscoped token (from a ContextVar) as Bearer.

    Set synchronously just before the call in the same coroutine, so `auth_flow` (same task)
    observes it. No token (web-api-mcp) → no Authorization header added.
    """

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response]:
        token = _call_token.get()
        if token:
            request.headers["Authorization"] = f"Bearer {token}"
        yield request


def _to_call_result(result: Any) -> McpCallResult:
    text = " ".join(c.text for c in result.content if getattr(c, "type", None) == "text")
    data = result.structuredContent
    if isinstance(data, dict) and set(data) == {"result"}:
        data = data["result"]
    return McpCallResult(is_error=bool(result.isError), data=data, text=text)


async def call_mcp_tool(
    server_url: str, tool_name: str, arguments: dict[str, Any], token: str | None
) -> McpCallResult:
    """Real streamable-HTTP MCP tool call. Forwards `token` out-of-band via DownscopedTokenAuth.

    Lazy SDK import keeps module load light for the pure allowlist/composition users. Exercised
    live in the curator/organizer integration tests (a running movie-mcp/web-api-mcp).
    """
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    reset = _call_token.set(token)
    try:
        client = streamablehttp_client(server_url, auth=DownscopedTokenAuth())
        async with client as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
        return _to_call_result(result)
    finally:
        _call_token.reset(reset)


async def list_mcp_tools(server_url: str) -> list[Any]:
    """List a server's tools (name/description/inputSchema) — used to build agent tool sets."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(server_url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = await session.list_tools()
    return list(listed.tools)


# ── The tool-call choke point ────────────────────────────────────────────────


async def invoke_tool(
    *,
    agent: str,
    tool_name: str,
    arguments: dict[str, Any],
    server: McpServerConfig,
    subject_token: str | None,
    call: ToolCallFn,
    limiter: AgentToolRateLimiter,
    acquire_token: AcquireTokenFn,
    rate_scope: str = "",
    max_retries: int = 2,
    backoff_base: float = 0.2,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> ToolOutcome:
    """Run one agent tool call through the governance + identity seams.

    `subject_token` is the run-scoped delegation token (threaded via LangGraph
    `config["configurable"]`, not a fragile deep-graph ContextVar). `acquire_token` is a
    per-call closure over `identity.acquire_downscoped_token` (OPA -> re-exchange -> ≤60s
    cache). Failures degrade gracefully to a typed error (FR-018) — the call is never made
    when blocked.

    Resilience (T024a): a transient transport failure or an upstream 5xx is retried with
    exponential backoff up to `max_retries` times; deterministic idempotency keys (T041/T043)
    keep a retried write at-most-once. Exhausted retries are dead-lettered — the planner gets a
    user-facing "couldn't complete" outcome and an audit line is emitted (no token/PII). A
    deterministic 4xx (e.g. 409 duplicate) is never retried; its status is surfaced for the
    approval gate to classify.
    """
    if not is_tool_allowed(agent, tool_name):
        return ToolOutcome(ok=False, error=f"tool '{tool_name}' is not permitted for {agent}")

    try:
        limiter.check(agent, rate_scope)
    except AgentRateLimitExceeded:
        return ToolOutcome(ok=False, error="The assistant is busy — please try again shortly.")

    token: str | None = None
    if server.needs_token:
        if not subject_token:
            return ToolOutcome(ok=False, error="No caller identity is available for this action.")
        try:
            token = await acquire_token(subject_token, server.audience)
        except (PermissionError, TokenExchangeError):
            return ToolOutcome(ok=False, error="You're not authorized to perform that action.")

    nap = sleep or asyncio.sleep
    attempt = 0
    while True:
        try:
            result = await call(server.url, tool_name, arguments, token)
        except Exception as exc:  # noqa: BLE001 — classify transient vs fatal
            if not _is_transient_exc(exc):
                raise
            if attempt >= max_retries:
                return _dead_letter(agent, tool_name, reason=f"transport:{type(exc).__name__}")
            await nap(backoff_base * 2**attempt)
            attempt += 1
            continue

        if result.is_error and _is_transient_status(_upstream_status(result.text)):
            if attempt >= max_retries:
                return _dead_letter(agent, tool_name, reason="upstream_5xx")
            await nap(backoff_base * 2**attempt)
            attempt += 1
            continue
        break

    guard = guard_tool_output(result.text)
    if result.is_error:
        return ToolOutcome(
            ok=False,
            error="That request couldn't be completed.",
            injection=guard.injection,
            status=_upstream_status(result.text),
        )
    return ToolOutcome(ok=True, data=result.data, injection=guard.injection)


def _dead_letter(agent: str, tool_name: str, *, reason: str) -> ToolOutcome:
    """Audit an exhausted-retry failure (no token/PII) and return a user-facing outcome."""
    logger.error(
        "agent tool call dead-lettered after exhausted retries: agent=%s tool=%s reason=%s",
        agent,
        tool_name,
        reason,
    )
    return ToolOutcome(
        ok=False,
        error="The assistant couldn't complete that action. Please try again in a moment.",
    )
