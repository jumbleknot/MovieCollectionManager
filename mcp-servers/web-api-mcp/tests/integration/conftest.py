"""Integration-test fixtures for web-api-mcp (T022).

Runs against the REAL TMDB API — never a cassette (constitution §Test Type Integrity: the
LLM dimension may be replayed, but external APIs under integration stay real). Needs a
TMDB v3 API key in `mcp-servers/web-api-mcp/.env.local` (TMDB_API_KEY) or the environment;
without it the tests skip rather than fail — except under MCM_REQUIRE_LIVE_STACK=1, where
that skip is escalated to a failure (see below).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve()
_PROJECT_ROOT = _HERE.parents[2]  # mcp-servers/web-api-mcp


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip()
    return values


_ENV = _load_env_file(_PROJECT_ROOT / ".env.local")


def _cfg(key: str, default: str = "") -> str:
    return os.environ.get(key) or _ENV.get(key) or default


# ── CI gate: a SKIPPED integration suite must not report green (048 FR-012, 059 FR-020a) ────────
# This suite skips when TMDB_API_KEY is absent, which is right locally — a credential-less checkout
# stays green (see the module docstring). It is exactly wrong in CI.
#
# 059 enrolls this suite in app-ci's integration step, where it is the only merge-blocking check of
# the certification extraction against TMDB's real response shape. An absent secret, or lost runner
# egress, would otherwise be indistinguishable from a pass: 5 skipped, exit 0 (measured — that is
# this task's RED). So in CI (MCM_REQUIRE_LIVE_STACK=1, set by the app-ci step) a skip FAILS loudly.
# Locally the var is unset and nothing changes.
#
# Mirrors mcp-servers/movie-mcp/tests/integration/conftest.py and the spreadsheet-mcp conftest,
# including the rule that a legitimate skip is added DELIBERATELY — the red CI is the prompt.
_REQUIRE_LIVE_STACK = os.environ.get("MCM_REQUIRE_LIVE_STACK") == "1"

# Empty by design: this suite's only dependency is TMDB plus a key, and the app-ci step that runs it
# supplies both. No skip is legitimate there.
_LEGITIMATE_SKIPS: tuple[str, ...] = ()


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):  # noqa: ANN001, ANN201, ARG001 - pytest hook signature
    """Escalate credential-absent SKIPs to FAILUREs when MCM_REQUIRE_LIVE_STACK=1 (see above)."""
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
        "MCM_REQUIRE_LIVE_STACK=1: this integration test SKIPPED. In CI the TMDB key and "
        "outbound egress are supposed to be present, so a skip is a BROKEN HARNESS, not a pass — "
        "a silently-skipped suite reports green and gives false confidence about the certification "
        "lookup nothing else checks against the live API. Fix the key/egress (or, if this skip is "
        "genuinely legitimate, add it to _LEGITIMATE_SKIPS in tests/integration/conftest.py "
        "deliberately).\n"
        f"Original skip reason: {reason}"
    )


@pytest.fixture(scope="session")
def tmdb_api_key() -> str:
    key = _cfg("TMDB_API_KEY")
    if not key:
        pytest.skip(
            "TMDB_API_KEY not set (mcp-servers/web-api-mcp/.env.local) — real TMDB required"
        )
    return key


@pytest.fixture(scope="session")
def tmdb_base_url() -> str:
    return _cfg("TMDB_BASE_URL", "https://api.themoviedb.org/3")
