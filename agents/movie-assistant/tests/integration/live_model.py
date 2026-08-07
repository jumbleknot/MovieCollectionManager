"""
Helpers for tests that drive the REAL runtime model.

Lives beside `kc_admin.py` rather than in `conftest.py` deliberately: this suite has two conftests,
so `from conftest import …` is ambiguous — the same reason the Keycloak helpers were moved out.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

import pytest

from src.eval.cassette import CassetteMissError

__all__ = ["invoke_or_skip", "live_model_required", "require_live_credential"]

# ── The pre-deploy live gate: a skip here is a silent pass (048 US2) ────────────────────────────
# `nx test:golden-live` runs the golden-marked tests in `off` mode against the REAL provider, as the
# last check before an image is promoted. Every skip path this suite has — no credential, provider
# unreachable, provider at capacity — was written for a developer's credential-less checkout, where
# skipping clean is right. At the deploy boundary the same skip means the gate verified NOTHING and
# still reported exit 0, which is precisely the defect this feature exists to remove (FR-007,
# US2-AC3). Measured 2026-08-07 before the fix: a credential-less `test:golden-live` reported
# `1 passed, 50 skipped`, exit 0.
#
# So the escalation is opt-in by flag, exactly like MCM_REQUIRE_LIVE_STACK=1: the `test:golden-live`
# target sets it unconditionally, so the gate can never run without it, while a local
# `nx test:integration` on a keyless checkout keeps its skip-clean behaviour.
_REQUIRE_LIVE_MODEL = "MCM_REQUIRE_LIVE_MODEL"


def live_model_required(env: Mapping[str, str] | None = None) -> bool:
    """True when running as the pre-deploy live gate, where a skip is a silent pass."""
    env = os.environ if env is None else env
    return env.get(_REQUIRE_LIVE_MODEL) == "1"


def require_live_credential(env: Mapping[str, str], purpose: str) -> None:
    """Fail (gate) or skip (local) when no Anthropic credential is available.

    FR-007: the live gate MUST fail — not skip — when it cannot obtain a credential.
    """
    if (env.get("ANTHROPIC_API_KEY") or "").strip():
        return
    reason = f"ANTHROPIC_API_KEY not set ({purpose})"
    if live_model_required(env):
        pytest.fail(
            f"{_REQUIRE_LIVE_MODEL}=1: the live pre-deploy golden gate has no Anthropic "
            "credential, so it can verify nothing. Skipping here would promote an image on the "
            "strength of a gate that never ran (FR-007 / US2-AC3), so this FAILS instead. "
            "cd-deploy supplies it as ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_CD_GOLDEN }}. "
            f"[{reason}]"
        )
    pytest.skip(reason)


def invoke_or_skip(fn, *args, **kwargs):
    """
    Run a live-model call, converting provider-CAPACITY failures into a skip.

    The suite already skips when the model is unreachable at fixture time. But a module-scoped
    fixture only smoke-tests reachability ONCE: the provider can still return 529 part-way through
    the run, which surfaced as a test failure rather than an infrastructure one.

    Only overload/rate-limit signals are converted. Anything else — a bad key, a malformed request,
    a genuine assertion failure — propagates untouched.

    Classification is by TYPE first, then by substring. The substring test is a heuristic over the
    provider's error text, and `CassetteMissError` embeds a truncated sha256 cassette key in its
    message: a key beginning `529…` or `429…` would trip it and downgrade a replay DRIFT signal to
    a skip, reporting green for a prompt that genuinely changed (048 FR-003). Drift is never
    capacity, so it is excluded by type before the text is ever inspected.
    """
    try:
        return fn(*args, **kwargs)
    except CassetteMissError:
        raise  # replay drift — re-record, never skip. Checked FIRST, before the text heuristic.
    except Exception as exc:  # noqa: BLE001 - classified below, re-raised if not a capacity signal
        text = f"{type(exc).__name__}: {exc}".lower()
        capacity = "overloaded" in text or "529" in text or "rate_limit" in text or "429" in text
        if not capacity:
            raise
        if live_model_required():
            # US2-AC4: the client has already retried (ANTHROPIC_MAX_RETRIES, default 6, with
            # backoff). A gate that cannot reach the provider has not verified the model decision,
            # so it must not let the deploy through — but the outcome has to stay DISTINGUISHABLE
            # from "the model decided wrongly", which is a product defect and a different response.
            # Hence a failure whose first line names it as infrastructure.
            pytest.fail(
                "PROVIDER CAPACITY (infrastructure, NOT a classification defect): the model "
                f"provider was still overloaded after retries — {type(exc).__name__}: {exc}. "
                "The live pre-deploy gate could not verify the model decision, so the deploy is "
                "blocked rather than promoted on an unverified gate. Re-run when capacity "
                "recovers; do not investigate this as a prompt or routing regression."
            )
        pytest.skip(f"model provider overloaded after retries: {type(exc).__name__}")
