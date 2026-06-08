"""Assistant kill switch (T061, FR-019 / SC-009).

The assistant feature MUST be independently disableable without affecting any existing app
functionality. `assistant_disabled(env)` is the single predicate the graph entry checks per
run: when the switch is on, the supervisor short-circuits to a graceful "unavailable" reply
with ZERO side effects (no classify, no tool call, no write) — and because the assistant is an
additive overlay (the dock; SC-005), disabling it leaves every existing app flow untouched.

For the MVP the switch is the env flag `AGENT_KILL_SWITCH` (truthy = disabled). In production
it is backed by the Unleash kill switch from the Control Tower (T030) — that wiring replaces the
env read with a per-run Unleash flag lookup; the predicate signature here stays the call site.
"""

from __future__ import annotations

from collections.abc import Mapping

_TRUTHY = frozenset({"1", "true", "yes", "on", "disabled"})


def assistant_disabled(env: Mapping[str, str]) -> bool:
    """Whether the assistant kill switch is engaged (the feature is disabled) for this run."""
    return (env.get("AGENT_KILL_SWITCH") or "").strip().lower() in _TRUTHY
