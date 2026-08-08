"""Integration fixtures for spreadsheet-mcp against a REAL Redis (048 US3).

Two concerns live here, and both exist because a test suite that has never been run in CI accretes
defects that look like product bugs and are not.

1. **The event-loop defect (FR-010).** `store._make_redis()` memoises one `redis.asyncio` client in
   a module-level `_shared_client`. That is CORRECT for production: the MCP server is a single
   long-lived process, and building a client (and its connection pool) per tool call would leak
   pools and sockets — it matches movie-mcp's single-backend-client pattern. But pytest-asyncio
   gives every test its own event loop, and a redis.asyncio client binds to the loop that created
   it. So the first test cached a client bound to loop A; the second test ran on loop B, reused it,
   and died with "Future attached to a different loop" / "Event loop is closed". The failure is in
   the TEST's lifetime assumption, not in the store, so the fix belongs here and `src/store.py` is
   deliberately NOT modified.

2. **Skip-escalation in CI (FR-012).** See below.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest

from src import store


@pytest.fixture(autouse=True)
async def reset_shared_redis_client() -> AsyncIterator[None]:
    """Give every test a fresh, loop-local Redis client (FR-010).

    Teardown runs inside the same event loop as the test, which is the only place the client can be
    closed cleanly — closing it from another loop is the very error this fixture exists to prevent.
    """
    store._shared_client = None
    yield
    client = store._shared_client
    store._shared_client = None
    if client is not None:
        await client.aclose()


# ── CI gate: a SKIPPED integration suite must not report green (FR-012) ─────────────────────────
# This suite skips when Redis is absent, which is right locally — a developer without the stack up
# still gets a green checkout. It is exactly wrong in CI. These tests are being enrolled in `app-ci`
# by 048 US3 precisely BECAUSE they never ran anywhere; enrolling them in a state where a missing
# Redis skips every test and exits 0 would restore the same illusion in a new place, which the PRD
# explicitly rejected as "option C".
#
# So in CI (MCM_REQUIRE_LIVE_STACK=1, set by the app-ci step that brings Redis up) a skip means the
# harness is broken and must FAIL loudly. Locally the var is unset and skip-clean behaviour stands.
# This deliberately mirrors agents/movie-assistant/tests/integration/conftest.py, including the rule
# that every legitimate skip is listed DELIBERATELY — the red CI is the prompt to make that call.
_REQUIRE_LIVE_STACK = os.environ.get("MCM_REQUIRE_LIVE_STACK") == "1"

# Skips that stay legitimate even with the full stack up. Empty by design: this suite's ONLY
# external dependency is Redis, which app-ci brings up, so there is no such skip today. Adding one
# is a deliberate act, not a convenience.
_LEGITIMATE_SKIPS: tuple[str, ...] = ()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):  # noqa: ANN001, ANN201, ARG001 - pytest hook signature
    """Escalate stack-absent SKIPs to FAILUREs when MCM_REQUIRE_LIVE_STACK=1 (see above)."""
    outcome = yield
    if not _REQUIRE_LIVE_STACK:
        return
    report = outcome.get_result()
    if not report.skipped:
        return
    longrepr = report.longrepr
    # A skip's longrepr is normally the (path, lineno, "Skipped: <reason>") triple.
    if isinstance(longrepr, tuple) and len(longrepr) == 3:
        reason = str(longrepr[2])
    else:
        reason = str(longrepr)
    if any(pattern in reason.lower() for pattern in _LEGITIMATE_SKIPS):
        return
    report.outcome = "failed"
    report.longrepr = (
        "MCM_REQUIRE_LIVE_STACK=1: this integration test SKIPPED. In CI the backing services are "
        "supposed to be up, so a skip is a BROKEN HARNESS, not a pass — a silently-skipped suite "
        "reports green and gives false confidence, which is the whole reason these tests sat "
        "un-run and broken from 2026-06-14. Fix the stack (Redis), or, if this skip is genuinely "
        "legitimate, add it to _LEGITIMATE_SKIPS in tests/integration/conftest.py deliberately.\n"
        f"Original skip reason: {reason}"
    )
