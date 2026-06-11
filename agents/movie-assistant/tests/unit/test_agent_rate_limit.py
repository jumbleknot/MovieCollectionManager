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
