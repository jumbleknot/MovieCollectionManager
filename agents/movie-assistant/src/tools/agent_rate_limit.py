"""Per-agent tool-call rate limiter (T027a).

The constitution's §Agent Security requires rate limiting "per authenticated user AND
per agent". The per-user request/cost limits live in the BFF (`agent-rate-limiter.ts`,
T027); this module is the per-AGENT counterpart enforced at the gateway: it caps how
many tool calls each specialist (curator/organizer) may make within a sliding window,
scoped per (agent, scope) where `scope` is typically the thread/user.

On breach it raises `AgentRateLimitExceeded`; the tool-call path (US1) calls
`limiter.check(agent, scope)` before each MCP tool call — next to `is_tool_allowed` —
and degrades gracefully to a "couldn't complete" AG-UI message (FR-018) instead of
spending unboundedly. Process-local (the gateway is a single process) and pure (the
clock is injectable), so it is fully unit-testable without a store or network.
"""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Callable, Mapping

# Generous defaults — high enough that normal multi-tool turns are unaffected, low
# enough to stop a runaway loop. Overridable via env (see build_default_limiter).
_DEFAULT_LIMIT = 30
_DEFAULT_WINDOW_SECONDS = 60.0


class AgentRateLimitExceeded(Exception):
    """Raised when an agent exceeds its tool-call rate within the window."""

    def __init__(self, agent: str) -> None:
        self.agent = agent
        super().__init__(f"agent '{agent}' exceeded its tool-call rate limit")


class AgentToolRateLimiter:
    """Sliding-window tool-call rate limiter, bucketed per (agent, scope).

    Each call records a timestamp; `check` prunes timestamps older than the window and
    raises before recording when the bucket is already at its cap. A per-agent override
    lets a specific specialist be capped tighter than the default.
    """

    def __init__(
        self,
        *,
        max_calls: int,
        window_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        per_agent_overrides: Mapping[str, int] | None = None,
    ) -> None:
        self._max_calls = max_calls
        self._window = window_seconds
        self._clock = clock
        self._overrides = dict(per_agent_overrides or {})
        self._buckets: dict[tuple[str, str], list[float]] = defaultdict(list)

    def _cap_for(self, agent: str) -> int:
        return self._overrides.get(agent, self._max_calls)

    def check(self, agent: str, scope: str = "") -> None:
        """Record a tool call for (agent, scope); raise AgentRateLimitExceeded if over cap."""
        now = self._clock()
        cutoff = now - self._window
        timestamps = self._buckets[(agent, scope)]
        # Drop calls that have aged out of the window.
        timestamps[:] = [t for t in timestamps if t > cutoff]
        if len(timestamps) >= self._cap_for(agent):
            raise AgentRateLimitExceeded(agent)
        timestamps.append(now)


def build_default_limiter(env: Mapping[str, str]) -> AgentToolRateLimiter:
    """Construct the gateway's per-agent limiter from env, falling back to defaults.

    Env: AGENT_TOOL_CALL_LIMIT (int), AGENT_TOOL_CALL_WINDOW_SECONDS (float).
    """
    max_calls = int(env.get("AGENT_TOOL_CALL_LIMIT", _DEFAULT_LIMIT))
    window = float(env.get("AGENT_TOOL_CALL_WINDOW_SECONDS", _DEFAULT_WINDOW_SECONDS))
    return AgentToolRateLimiter(max_calls=max_calls, window_seconds=window)
