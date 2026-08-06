"""Unit tests for the per-agent tool-call rate limiter (T027a).

Constitution §Agent Security requires rate limiting "per authenticated user AND per
agent". The per-user request/cost limits live in the BFF (T027); this caps each
specialist's (curator/organizer) tool-call rate at the gateway. A breach raises
`AgentRateLimitExceeded` so the tool path can degrade gracefully to a "couldn't
complete" message (FR-018) rather than spending unboundedly.

Pure, process-local, injectable clock — no network needed to test.
"""

from __future__ import annotations

import pytest

from src.tools.agent_rate_limit import (
    AgentRateLimitExceeded,
    AgentToolRateLimiter,
    build_default_limiter,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_allows_up_to_cap_then_raises_naming_the_agent() -> None:
    limiter = AgentToolRateLimiter(max_calls=3, window_seconds=60, clock=_Clock())
    for _ in range(3):
        limiter.check("curator")
    with pytest.raises(AgentRateLimitExceeded) as excinfo:
        limiter.check("curator")
    assert "curator" in str(excinfo.value)
    assert excinfo.value.agent == "curator"


def test_counters_are_independent_per_agent() -> None:
    limiter = AgentToolRateLimiter(max_calls=2, window_seconds=60, clock=_Clock())
    limiter.check("curator")
    limiter.check("curator")
    # organizer has its own budget — unaffected by curator hitting its cap.
    limiter.check("organizer")
    limiter.check("organizer")
    with pytest.raises(AgentRateLimitExceeded):
        limiter.check("curator")


def test_counters_are_independent_per_scope() -> None:
    limiter = AgentToolRateLimiter(max_calls=1, window_seconds=60, clock=_Clock())
    limiter.check("organizer", scope="thread-a")
    # A different thread/user is a separate bucket.
    limiter.check("organizer", scope="thread-b")
    with pytest.raises(AgentRateLimitExceeded):
        limiter.check("organizer", scope="thread-a")


def test_window_slides_and_allows_calls_again() -> None:
    clock = _Clock()
    limiter = AgentToolRateLimiter(max_calls=2, window_seconds=60, clock=clock)
    limiter.check("organizer")
    limiter.check("organizer")
    with pytest.raises(AgentRateLimitExceeded):
        limiter.check("organizer")

    clock.now += 61  # the earlier calls fall out of the window
    limiter.check("organizer")  # allowed again


def test_per_agent_override_caps_a_specific_specialist() -> None:
    limiter = AgentToolRateLimiter(
        max_calls=5, window_seconds=60, clock=_Clock(), per_agent_overrides={"curator": 1}
    )
    limiter.check("curator")
    with pytest.raises(AgentRateLimitExceeded):
        limiter.check("curator")  # override (1) applies, not the default (5)


def test_build_default_limiter_reads_env() -> None:
    limiter = build_default_limiter(
        {"AGENT_TOOL_CALL_LIMIT": "2", "AGENT_TOOL_CALL_WINDOW_SECONDS": "30"}
    )
    assert isinstance(limiter, AgentToolRateLimiter)
    limiter.check("curator")
    limiter.check("curator")
    with pytest.raises(AgentRateLimitExceeded):
        limiter.check("curator")


def test_build_default_limiter_uses_defaults_when_env_absent() -> None:
    limiter = build_default_limiter({})
    # Defaults are generous; a couple of calls must not trip the limit.
    limiter.check("organizer")
    limiter.check("organizer")


# ── 047 US3 (T047/T048): the bulk exemption, pinned ──────────────────────────────────────────────
#
# FR-019a. An approved import is code-orchestrated over a FINITE list the member explicitly
# confirmed — it is not a runaway LLM loop, which is what the per-agent limiter exists to stop.
# 014 shipped without this and a 200-row import was capped at 30, failing the other 170 with no
# explanation. The exemption is already in place; this pins it, because it is a one-word change
# (`skip_rate_limit=True`) that a future refactor could drop silently and the symptom would be a
# partially-applied import rather than an error.

from typing import Any  # noqa: E402

from src.tools.mcp_tools import (  # noqa: E402
    McpCallResult,
    McpServerConfig,
    invoke_tool,
)

_MOVIE = McpServerConfig(name="movie-mcp", url="http://movie-mcp/mcp", needs_token=True)


async def _ok(_url: str, _tool: str, _args: dict[str, Any], _tok: str | None) -> McpCallResult:
    return McpCallResult(False, {"movieId": "m"}, "")


async def _grant(_subject: str, _audience: str) -> str:
    return "downscoped"


@pytest.mark.asyncio
async def test_bulk_exemption_lets_2000_approved_writes_through_a_30_call_limiter() -> None:
    """A 2,000-item apply issues 2,000 writes with ZERO limiter rejections."""
    limiter = AgentToolRateLimiter(max_calls=30, window_seconds=60)  # production default

    outcomes = []
    for i in range(2000):
        outcomes.append(
            await invoke_tool(
                agent="organizer", tool_name="add_movie", arguments={"i": i}, server=_MOVIE,
                subject_token="subj", call=_ok, limiter=limiter, acquire_token=_grant,
                skip_rate_limit=True,
            )
        )

    assert len(outcomes) == 2000
    rejected = [o for o in outcomes if not o.ok]
    assert rejected == [], (
        f"{len(rejected)} approved writes were throttled — FR-019a: an approved bulk import runs "
        f"under its own allowance. First: {rejected[0].error if rejected else ''}"
    )


@pytest.mark.asyncio
async def test_without_the_exemption_the_same_traffic_is_throttled() -> None:
    """The converse — proves the test above is not passing because the limiter is inert."""
    limiter = AgentToolRateLimiter(max_calls=30, window_seconds=60)

    outcomes = [
        await invoke_tool(
            agent="organizer", tool_name="add_movie", arguments={"i": i}, server=_MOVIE,
            subject_token="subj", call=_ok, limiter=limiter, acquire_token=_grant,
        )
        for i in range(60)
    ]

    assert any(not o.ok for o in outcomes), "the limiter did not throttle unexempt traffic at all"
    assert sum(1 for o in outcomes if o.ok) == 30
