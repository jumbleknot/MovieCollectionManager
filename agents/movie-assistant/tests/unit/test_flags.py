"""Feature-flag provider (T075b, research R16).

EnvFlags: pure env-var reads, default-off.
UnleashFlags: wraps UnleashClient; env-fallback when Unleash can't answer.
get_flag_provider: returns EnvFlags when UNLEASH_URL is unset, UnleashFlags otherwise.

Tests are fully network-free: UnleashFlags construction is monkeypatched so the SDK
never connects to a server.

T075c additions: frontier_escalation_enabled predicate on models.py.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from src.flags import FRONTIER_ESCALATION, KILL_SWITCH, EnvFlags, get_flag_provider
from src.models import frontier_escalation_enabled


def test_unset_url_returns_envflags() -> None:
    assert isinstance(get_flag_provider({}), EnvFlags)


def test_envflags_reads_env_truthy() -> None:
    assert EnvFlags({"AGENT_KILL_SWITCH": "true"}).enabled(KILL_SWITCH) is True
    assert EnvFlags({"AGENT_KILL_SWITCH": "1"}).enabled(KILL_SWITCH) is True
    assert EnvFlags({"AGENT_KILL_SWITCH": "disabled"}).enabled(KILL_SWITCH) is True
    assert EnvFlags({}).enabled(KILL_SWITCH) is False
    assert EnvFlags({"AGENT_KILL_SWITCH": "false"}).enabled(KILL_SWITCH) is False


def test_default_off_for_unmapped_flag() -> None:
    # FRONTIER_ESCALATION had no pre-existing env flag — must default off.
    assert EnvFlags({}).enabled(FRONTIER_ESCALATION) is False
    assert EnvFlags({"AGENT_KILL_SWITCH": "true"}).enabled(FRONTIER_ESCALATION) is False


def test_envflags_case_insensitive() -> None:
    assert EnvFlags({"AGENT_KILL_SWITCH": "TRUE"}).enabled(KILL_SWITCH) is True
    assert EnvFlags({"AGENT_KILL_SWITCH": "  True  "}).enabled(KILL_SWITCH) is True


def test_set_url_returns_unleashflags() -> None:
    # Patch UnleashFlags.__init__ to a no-op so no real SDK connection is made.
    with patch("src.flags.UnleashFlags.__init__", return_value=None):
        provider = get_flag_provider({"UNLEASH_URL": "http://unleash.example/api"})
    assert provider.__class__.__name__ == "UnleashFlags"


def test_unleashflags_pins_writable_cache_directory() -> None:
    # Regression (prod agent down 2026-07-08): the gateway runs non-root with no writable
    # HOME (feature 034), so Unleash's FileCache default (~/.cache → /home/app) crashes with
    # PermissionError on every request. UnleashFlags MUST pass an explicit, writable
    # cache_directory so fcache never touches HOME.
    import os
    import tempfile

    with patch("UnleashClient.UnleashClient") as mock_client:
        from src.flags import UnleashFlags

        UnleashFlags("http://unleash.example/api", {})

    _, kwargs = mock_client.call_args
    cache_dir = kwargs.get("cache_directory")
    assert cache_dir, "UnleashClient must be constructed with an explicit cache_directory"
    # Default lives under the system temp dir — a writable, ephemeral location.
    assert cache_dir.startswith(tempfile.gettempdir())
    assert os.path.dirname(cache_dir), "cache_directory must be an absolute path"


def test_unleashflags_cache_directory_env_override() -> None:
    # Operators can relocate the cache via UNLEASH_CACHE_DIR.
    with patch("UnleashClient.UnleashClient") as mock_client:
        from src.flags import UnleashFlags

        UnleashFlags(
            "http://unleash.example/api", {"UNLEASH_CACHE_DIR": "/var/cache/unleash"}
        )

    _, kwargs = mock_client.call_args
    assert kwargs.get("cache_directory") == "/var/cache/unleash"


def test_unleashflags_delegates_to_client() -> None:
    # Verify that UnleashFlags.enabled delegates to the UnleashClient and returns its value.
    fake_client = MagicMock()
    fake_client.is_enabled.return_value = True

    with patch("src.flags.UnleashFlags.__init__", return_value=None):
        from src.flags import UnleashFlags

        flags = UnleashFlags.__new__(UnleashFlags)
        flags._client = fake_client  # noqa: SLF001
        flags._fallback = EnvFlags({})  # noqa: SLF001

    assert flags.enabled(KILL_SWITCH) is True
    fake_client.is_enabled.assert_called_once()


def test_unleashflags_env_fallback_on_false() -> None:
    # When Unleash returns False AND the env var says True, the fallback (env) is consulted
    # via the fallback_function — but is_enabled's own return value is authoritative.
    # Here we just verify the fallback_function kwarg is plumbed correctly: call it and check.
    fake_client = MagicMock()

    # Capture the fallback_function passed to is_enabled.
    captured: dict[str, object] = {}

    def _capture_call(flag: str, fallback_function: object = None) -> bool:
        captured["fallback_function"] = fallback_function
        return False  # Unleash says disabled

    fake_client.is_enabled.side_effect = _capture_call

    with patch("src.flags.UnleashFlags.__init__", return_value=None):
        from src.flags import UnleashFlags

        flags = UnleashFlags.__new__(UnleashFlags)
        flags._client = fake_client  # noqa: SLF001
        flags._fallback = EnvFlags({"AGENT_KILL_SWITCH": "true"})  # noqa: SLF001

    result = flags.enabled(KILL_SWITCH)
    assert result is False  # Unleash is authoritative
    # The fallback_function was passed and, if called, would return True from env.
    fb = captured.get("fallback_function")
    assert callable(fb) and fb(KILL_SWITCH, None) is True


# ── T075c: frontier_escalation_enabled predicate (models.py) ─────────────────────────────────


def test_frontier_escalation_disabled_by_default() -> None:
    # No UNLEASH_URL and no env flag → default-off.
    assert frontier_escalation_enabled({}) is False


def test_frontier_escalation_unaffected_by_kill_switch_env() -> None:
    # AGENT_KILL_SWITCH=true is the KILL_SWITCH flag, not FRONTIER_ESCALATION — must stay False.
    assert frontier_escalation_enabled({"AGENT_KILL_SWITCH": "true"}) is False


def test_frontier_escalation_enabled_via_stub_provider() -> None:
    # When the provider returns True for FRONTIER_ESCALATION the predicate returns True.
    # The function uses a lazy `from src.flags import get_flag_provider` — patch at the source.
    fake = MagicMock()
    fake.enabled.return_value = True
    with patch("src.flags.get_flag_provider", return_value=fake):
        assert frontier_escalation_enabled({}) is True
    fake.enabled.assert_called_once_with(FRONTIER_ESCALATION)
