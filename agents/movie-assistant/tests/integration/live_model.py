"""
Helpers for tests that drive the REAL runtime model.

Lives beside `kc_admin.py` rather than in `conftest.py` deliberately: this suite has two conftests,
so `from conftest import …` is ambiguous — the same reason the Keycloak helpers were moved out.
"""

from __future__ import annotations

import pytest

from src.eval.cassette import CassetteMissError

__all__ = ["invoke_or_skip"]


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
        pytest.skip(f"model provider overloaded after retries: {type(exc).__name__}")
