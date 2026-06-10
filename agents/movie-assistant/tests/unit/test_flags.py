"""Feature-flag provider (T075b, research R16).

EnvFlags: pure env-var reads, default-off.
UnleashFlags: wraps UnleashClient; env-fallback when Unleash can't answer.
get_flag_provider: returns EnvFlags when UNLEASH_URL is unset, UnleashFlags otherwise.

Tests are fully network-free: UnleashFlags construction is monkeypatched so the SDK
never connects to a server.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from src.flags import FRONTIER_ESCALATION, KILL_SWITCH, EnvFlags, get_flag_provider


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
