"""T024a — write-tool resilience: retry-with-backoff + dead-letter (FR-018, SC-006).

`invoke_tool` is the single choke point every MCP tool call goes through. A transient
failure (network/transport error, or an upstream 5xx) is retried with exponential backoff;
the deterministic idempotency key (T041/T043) keeps a retried write at-most-once. When retries
are exhausted the call is dead-lettered: the planner gets a user-facing "couldn't complete"
outcome and an audit line is emitted (no token/PII).

The unreachable-server case exercises the REAL streamable-HTTP transport (`call_mcp_tool`)
against a closed port — a genuine connect failure, not a mock. The retry-then-succeed case
injects one transient error before delegating to a success result (a flapping transport cannot
be reproduced deterministically against a real, healthy mc-service). Backoff sleeps are
collapsed so the suite stays fast.

Run:  pnpm nx test:integration movie-assistant -- -k write_resilience
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.mcp_tools import McpCallResult, McpServerConfig, call_mcp_tool, invoke_tool

# A closed loopback port — connecting always raises a transport error.
_UNREACHABLE = McpServerConfig(name="movie-mcp", url="http://127.0.0.1:1/mcp", needs_token=True)
_MOVIE = McpServerConfig(name="movie-mcp", url="http://movie-mcp/mcp", needs_token=True)


def _limiter() -> AgentToolRateLimiter:
    return AgentToolRateLimiter(max_calls=100, window_seconds=60)


async def _grant_token(_subject: str, _audience: str) -> str:
    return "downscoped-tok"


async def _no_sleep(_seconds: float) -> None:
    return None


async def test_write_resilience_dead_letters_when_movie_mcp_unreachable(
    caplog: Any,
) -> None:
    with caplog.at_level(logging.ERROR):
        outcome = await invoke_tool(
            agent="organizer", tool_name="add_movie",
            arguments={"collectionId": "c1", "idempotencyKey": "k1"},
            server=_UNREACHABLE, subject_token="subj", call=call_mcp_tool,
            limiter=_limiter(), acquire_token=_grant_token, max_retries=2, sleep=_no_sleep,
        )

    assert not outcome.ok
    assert "couldn't complete" in (outcome.error or "").lower()
    assert any("dead-letter" in r.message.lower() for r in caplog.records)


async def test_write_resilience_retries_transient_failure_then_succeeds() -> None:
    attempts = 0

    async def flapping_call(
        url: str, tool: str, args: dict[str, Any], token: str | None
    ) -> McpCallResult:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ConnectError("connection reset")  # one transient blip
        return McpCallResult(is_error=False, data={"movieId": "m1"}, text="ok")

    outcome = await invoke_tool(
        agent="organizer", tool_name="add_movie",
        arguments={"collectionId": "c1", "idempotencyKey": "k1"},
        server=_MOVIE, subject_token="subj", call=flapping_call,
        limiter=_limiter(), acquire_token=_grant_token, max_retries=2, sleep=_no_sleep,
    )

    assert outcome.ok and outcome.data == {"movieId": "m1"}
    assert attempts == 2  # retried once, then succeeded
