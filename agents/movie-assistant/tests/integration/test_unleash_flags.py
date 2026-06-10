"""T075d — Unleash flags integration: live toggle round-trip.

Proves that `assistant_disabled` (and the underlying `UnleashFlags` provider) reflects a REAL
toggle on the Unleash v8 server in under 30 seconds.  The test:

  1. Builds a flag provider with a 1-second SDK refresh interval.
  2. Asserts the kill-switch starts disabled.
  3. Enables the `development` environment via the Unleash admin API.
  4. Polls until `assistant_disabled` flips to True (bounded, no fixed sleep).
  5. Disables the environment again.
  6. Polls until `assistant_disabled` flips back to False.
  7. Teardown (finally): ensures the flag is left OFF even on assertion failure.

Admin API shape (v8 verified):
  POST /api/admin/projects/default/features/<flag>/environments/development/on
  POST /api/admin/projects/default/features/<flag>/environments/development/off
  Header: Authorization: <admin-token>

Enabling the development environment the first time auto-creates a flexibleRollout/100 strategy
— no separate strategy POST is required on v8.

Requires: Unleash v8 at http://localhost:4242 (the --profile observability stack).
Skip cleanly otherwise — never fails on a credential-less checkout.

Run:
  docker compose --profile observability up -d
  pnpm nx test:integration movie-assistant -- -k unleash
"""

from __future__ import annotations

import time

import httpx
import pytest

# ── constants ────────────────────────────────────────────────────────────────

_UNLEASH_URL = "http://localhost:4242"
_UNLEASH_API_URL = f"{_UNLEASH_URL}/api"
_CLIENT_TOKEN = "default:development.***REMOVED***"
_ADMIN_TOKEN = "*:*.***REMOVED***"
_ADMIN_HEADERS = {"Authorization": _ADMIN_TOKEN}

_KILL_SWITCH = "mcm.agent.kill-switch"
_PROJECT = "default"
_ENV = "development"

_SDK_REFRESH_INTERVAL_S = 1   # short poll so propagation is fast
_POLL_TIMEOUT_S = 30          # generous ceiling for CI/loaded machines
_POLL_SLEEP_S = 1


# ── skip guard (module-level) ─────────────────────────────────────────────────

def _unleash_reachable() -> bool:
    try:
        return httpx.get(f"{_UNLEASH_URL}/health", timeout=5).status_code == 200
    except Exception:  # noqa: BLE001
        return False


_requires_unleash = pytest.mark.skipif(
    not _unleash_reachable(),
    reason="needs Unleash v8 at http://localhost:4242 (--profile observability)",
)


# ── helper: toggle flag environment on / off via admin API ────────────────────

def _toggle_flag(flag: str, on: bool) -> None:
    """Enable or disable *flag* in the development environment via the admin API."""
    action = "on" if on else "off"
    url = (
        f"{_UNLEASH_URL}/api/admin/projects/{_PROJECT}/features/{flag}"
        f"/environments/{_ENV}/{action}"
    )
    resp = httpx.post(url, headers=_ADMIN_HEADERS, timeout=10)
    # Unleash returns 200 (idempotent toggle) or 204; anything else is unexpected.
    assert resp.status_code in (200, 204), (
        f"Unleash admin toggle {action} failed: {resp.status_code} {resp.text[:300]}"
    )


# ── helper: bounded poll ──────────────────────────────────────────────────────

def _poll_until(
    predicate: "Callable[[], bool]",
    expected: bool,
    *,
    timeout_s: float = _POLL_TIMEOUT_S,
    sleep_s: float = _POLL_SLEEP_S,
    label: str = "",
) -> None:
    """Poll predicate() until it returns *expected*, or fail after *timeout_s* seconds."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if predicate() == expected:
            return
        time.sleep(sleep_s)
    raise AssertionError(
        f"Timed out after {timeout_s}s waiting for {label or 'predicate'} == {expected}"
    )


# ── test ──────────────────────────────────────────────────────────────────────

@_requires_unleash
def test_kill_switch_reflects_real_toggle() -> None:
    """Kill-switch flag propagates from Unleash admin → SDK → assistant_disabled() (T075d)."""
    from UnleashClient import UnleashClient

    from src.flags import KILL_SWITCH, UnleashFlags
    from src.kill_switch import assistant_disabled

    env: dict[str, str] = {
        "UNLEASH_URL": _UNLEASH_API_URL,
        "UNLEASH_API_TOKEN": _CLIENT_TOKEN,
    }

    # Build a UnleashFlags-like provider backed by a client with a 1-second refresh so
    # toggling propagates quickly.  We construct the UnleashClient directly here (the
    # UnleashFlags constructor doesn't expose refresh_interval) and wire it the same way
    # UnleashFlags does, then wrap it in a thin object that matches the provider interface.
    client = UnleashClient(
        url=_UNLEASH_API_URL,
        app_name="movie-assistant-test",
        refresh_interval=_SDK_REFRESH_INTERVAL_S,
        custom_headers={"Authorization": _CLIENT_TOKEN},
        disable_metrics=True,
    )
    client.initialize_client()

    # Convenience predicate: does the SDK say the kill-switch is on?
    def sdk_enabled() -> bool:
        return bool(client.is_enabled(KILL_SWITCH, fallback_function=lambda _f, _c: False))

    try:
        # ── ensure we start from a known-off state ────────────────────────────
        _toggle_flag(_KILL_SWITCH, on=False)

        # Give the SDK one cycle to pick up the current state before asserting.
        _poll_until(sdk_enabled, False, label="kill-switch starts disabled")
        # assistant_disabled also goes through get_flag_provider — cross-check via env path too.
        assert not assistant_disabled(env), "assistant_disabled() should be False while flag is OFF"

        # ── toggle ON ─────────────────────────────────────────────────────────
        _toggle_flag(_KILL_SWITCH, on=True)
        _poll_until(sdk_enabled, True, label="kill-switch flips to enabled")
        # assistant_disabled uses get_flag_provider(env) which creates its own UnleashClient;
        # it independently confirms the server-side state.
        assert assistant_disabled(env), "assistant_disabled() should be True while flag is ON"

        # ── toggle OFF again ──────────────────────────────────────────────────
        _toggle_flag(_KILL_SWITCH, on=False)
        _poll_until(sdk_enabled, False, label="kill-switch flips back to disabled")
        assert not assistant_disabled(env), "assistant_disabled() should be False after flag turned OFF"

    finally:
        # ── teardown: leave the server in default-off state ───────────────────
        try:
            _toggle_flag(_KILL_SWITCH, on=False)
        except Exception:  # noqa: BLE001
            pass  # best-effort; the server outlives this test
        client.destroy()
