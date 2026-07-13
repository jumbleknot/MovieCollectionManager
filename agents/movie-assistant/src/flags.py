"""Feature-flag provider (research R16). Config-gated: UNLEASH_URL set -> Unleash, else env flags.

Every flag is DEFAULT-OFF so an unconfigured / unreachable provider matches today's behavior.

Usage (call sites wired in the next task — T075c):
    provider = get_flag_provider(os.environ)
    if provider.enabled(KILL_SWITCH):
        ...
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Mapping
from typing import Protocol

KILL_SWITCH = "mcm.agent.kill-switch"
FRONTIER_ESCALATION = "mcm.agent.frontier-escalation"
DEGRADE = "mcm.agent.degrade"

# Only the kill-switch had a pre-existing env flag; escalation/degrade default off.
_ENV_BY_FLAG: dict[str, str] = {KILL_SWITCH: "AGENT_KILL_SWITCH"}
_TRUTHY: frozenset[str] = frozenset({"1", "true", "yes", "on", "disabled"})


class FlagProvider(Protocol):
    def enabled(self, flag: str) -> bool: ...


class EnvFlags:
    """Pure env-var flag provider — no network, no SDK dependency."""

    def __init__(self, env: Mapping[str, str]) -> None:
        self._env = env

    def enabled(self, flag: str) -> bool:
        var = _ENV_BY_FLAG.get(flag)
        if var is None:
            return False  # default-off (escalation/degrade had no env flag historically)
        return (self._env.get(var) or "").strip().lower() in _TRUTHY


class UnleashFlags:
    """Unleash-backed flag provider; falls back to EnvFlags when Unleash can't answer."""

    def __init__(self, url: str, env: Mapping[str, str]) -> None:
        from UnleashClient import UnleashClient

        # The gateway runs non-root with no writable HOME (feature 034). Unleash's FileCache
        # defaults to ~/.cache/... → /home/app, which the app user can't create → PermissionError
        # crashes every request (prod agent outage 2026-07-08). Pin the cache to a writable,
        # ephemeral temp dir; operators may relocate it via UNLEASH_CACHE_DIR.
        cache_dir = (env.get("UNLEASH_CACHE_DIR") or "").strip() or os.path.join(
            tempfile.gettempdir(), "unleash-movie-assistant"
        )
        self._client = UnleashClient(
            url=url,
            app_name="movie-assistant",
            cache_directory=cache_dir,
            custom_headers={"Authorization": env.get("UNLEASH_API_TOKEN", "")},
        )
        self._client.initialize_client()
        self._fallback = EnvFlags(env)

    def enabled(self, flag: str) -> bool:
        # Unleash is authoritative; env fallback is called only when Unleash has no answer.
        return bool(
            self._client.is_enabled(
                flag, fallback_function=lambda f, _ctx: self._fallback.enabled(f)
            )
        )


def get_flag_provider(env: Mapping[str, str]) -> FlagProvider:
    """Return the appropriate flag provider based on the environment configuration."""
    url = (env.get("UNLEASH_URL") or "").strip()
    return UnleashFlags(url, env) if url else EnvFlags(env)
