"""Integration-test fixtures for movie-mcp (T021).

Runs against the REAL local stack (Keycloak + mc-service + MongoDB) — no mocking the
dependency under integration (constitution §Test Type Integrity). A real `mc-user` JWT is
obtained via the dedicated `mcm-bff-test` ROPC client (the same one the BFF integration
harness uses); mc-service accepts it because the realm carries the mc-service audience
mapper on that client. Each test gets a freshly-seeded, isolated collection that is torn
down afterwards (Independent State).

Requires `frontend/mcm-app/.env.e2e.local` (E2E_ROPC_CLIENT_ID/SECRET, E2E_TEST_USER/PASSWORD).
If those are absent, the integration tests skip rather than fail (keeps a credential-less
checkout green); locally they run against the live stack.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[4]


def _load_env_file(path: Path) -> dict[str, str]:
    """Minimal .env parser (no external dep): KEY=value lines, ignores comments/blanks."""
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


_E2E_ENV = _load_env_file(_REPO_ROOT / "frontend" / "mcm-app" / ".env.e2e.local")


def _cfg(key: str, default: str = "") -> str:
    return os.environ.get(key) or _E2E_ENV.get(key) or default


KEYCLOAK_URL = _cfg("KEYCLOAK_URL", "http://localhost:8099")
KEYCLOAK_REALM = _cfg("KEYCLOAK_REALM", "grumpyrobot")
MC_SERVICE_URL = _cfg("MC_SERVICE_URL", "http://localhost:3001")
ROPC_CLIENT_ID = _cfg("E2E_ROPC_CLIENT_ID")
ROPC_CLIENT_SECRET = _cfg("E2E_ROPC_CLIENT_SECRET")
TEST_USER = _cfg("E2E_TEST_USER", "testuser")
TEST_PASSWORD = _cfg("E2E_TEST_PASSWORD", "TestPass1!ok")


@pytest.fixture(scope="session")
def mc_base_url() -> str:
    return MC_SERVICE_URL


@pytest.fixture(scope="session")
def mc_token() -> str:
    """Real mc-user access token via the mcm-bff-test ROPC client."""
    if not ROPC_CLIENT_ID or not ROPC_CLIENT_SECRET:
        pytest.skip(
            "E2E_ROPC_CLIENT_ID/SECRET not set (frontend/mcm-app/.env.e2e.local) — needs live stack"
        )
    token_endpoint = f"{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token"
    try:
        resp = httpx.post(
            token_endpoint,
            data={
                "grant_type": "password",
                "client_id": ROPC_CLIENT_ID,
                "client_secret": ROPC_CLIENT_SECRET,
                "username": TEST_USER,
                "password": TEST_PASSWORD,
                "scope": "openid",
            },
            timeout=15.0,
        )
    except httpx.HTTPError as exc:  # Keycloak not running
        pytest.skip(f"Keycloak unreachable at {KEYCLOAK_URL}: {exc}")
    if resp.status_code != 200:
        pytest.skip(f"ROPC token request failed ({resp.status_code}): {resp.text[:200]}")
    return str(resp.json()["access_token"])


def _movie_body(title: str) -> dict[str, Any]:
    """A fully-populated MovieRequest (mc-service rejects missing non-Option fields)."""
    return {
        "title": title,
        "year": 2001,
        "contentType": "Movie",
        "language": "English",
        "owned": True,
        "ripped": False,
        "childrens": False,
        "ownedMedia": ["DVD"],
        "ripQuality": [],
        "genres": ["Drama"],
        "rated": "PG-13",
        "directors": [],
        "actors": [],
        "tags": [],
        "movieSet": None,
        "originalTitle": None,
        "releaseDate": None,
        "outline": None,
        "plot": None,
        "runtime": None,
        "externalIds": [],
    }


@pytest.fixture
def seeded_collection(mc_base_url: str, mc_token: str) -> Iterator[dict[str, str]]:
    """Create an isolated collection with one movie via mc-service; tear it down after.

    Yields {collectionId, name, movieId, movieTitle}. Setup/teardown use raw mc-service
    REST (the write TOOLS land in T043); the READ tools are what's under test here.
    """
    client = httpx.Client(
        base_url=mc_base_url,
        headers={"Authorization": f"Bearer {mc_token}", "Content-Type": "application/json"},
        timeout=15.0,
    )
    # Unique name avoids per-owner uniqueness collisions across reruns.
    name = f"movie-mcp-it-{os.getpid()}-{id(object())}"
    movie_title = f"MCP Read Probe {id(object())}"
    collection_id = ""
    try:
        r = client.post("/api/v1/collections", json={"name": name})
        r.raise_for_status()
        collection_id = r.json()["collectionId"]

        r = client.post(
            f"/api/v1/collections/{collection_id}/movies", json=_movie_body(movie_title)
        )
        r.raise_for_status()
        movie_id = r.json()["movieId"]

        yield {
            "collectionId": collection_id,
            "name": name,
            "movieId": movie_id,
            "movieTitle": movie_title,
        }
    finally:
        if collection_id:
            client.delete(f"/api/v1/collections/{collection_id}")
        client.close()
