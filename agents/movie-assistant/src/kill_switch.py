"""Assistant kill switch (T061, FR-019 / SC-009).

The assistant feature MUST be independently disableable without affecting any existing app
functionality. `assistant_disabled(env)` is the single predicate the graph entry checks per
run: when the switch is on, the supervisor short-circuits to a graceful "unavailable" reply
with ZERO side effects (no classify, no tool call, no write) — and because the assistant is an
additive overlay (the dock; SC-005), disabling it leaves every existing app flow untouched.

The switch is backed by the flag provider (T075b): Unleash when UNLEASH_URL is set, else the
env flag AGENT_KILL_SWITCH (truthy = disabled). When UNLEASH_URL is unset the behavior is
byte-for-byte identical to the original env-only implementation.
"""

from __future__ import annotations

from collections.abc import Mapping

from src.flags import KILL_SWITCH, get_flag_provider


def assistant_disabled(env: Mapping[str, str]) -> bool:
    """Kill switch engaged? Unleash when UNLEASH_URL is set, else the AGENT_KILL_SWITCH env flag."""
    return get_flag_provider(env).enabled(KILL_SWITCH)
