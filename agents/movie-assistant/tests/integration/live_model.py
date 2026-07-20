"""
Helpers for tests that drive the REAL runtime model.

Lives beside `kc_admin.py` rather than in `conftest.py` deliberately: this suite has two conftests,
so `from conftest import …` is ambiguous — the same reason the Keycloak helpers were moved out.
"""

from __future__ import annotations

import pytest

__all__ = ["invoke_or_skip"]

def invoke_or_skip(fn, *args, **kwargs):
    """
    Run a live-model call, converting provider-CAPACITY failures into a skip.

    The suite already skips when the model is unreachable at fixture time. But a module-scoped
    fixture only smoke-tests reachability ONCE: the provider can still return 529 part-way through
    the run, which surfaced as a test failure rather than an infrastructure one.

    Only overload/rate-limit signals are converted. Anything else — a bad key, a malformed request,
    a genuine assertion failure — propagates untouched.
    """
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 - classified below, re-raised if not a capacity signal
        text = f"{type(exc).__name__}: {exc}".lower()
        capacity = ("overloaded" in text or "529" in text or "rate_limit" in text or "429" in text)
        if not capacity:
            raise
        pytest.skip(f"model provider overloaded after retries: {type(exc).__name__}")
