"""Integration-test fixtures for web-api-mcp (T022).

Runs against the REAL TMDB API — never a cassette (constitution §Test Type Integrity: the
LLM dimension may be replayed, but external APIs under integration stay real). Needs a
TMDB v3 API key in `mcp-servers/web-api-mcp/.env.local` (TMDB_API_KEY) or the environment;
without it the tests skip rather than fail.
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
