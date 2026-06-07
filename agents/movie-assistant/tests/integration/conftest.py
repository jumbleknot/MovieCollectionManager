"""Integration fixtures for the gateway token re-exchange (T024) against REAL Keycloak.

Self-sufficient via the BFF service account: it fetches the confidential `agent-gateway` client
secret through the Admin API and ensures the ROPC client's tokens carry `agent-gateway` in their
`aud` — so a real user token can act as the re-exchange SUBJECT (precondition 1). Shared
Keycloak/admin helpers live in `kc_admin` (importable by test modules; `from conftest import …`
is ambiguous across the two conftests).

Skips cleanly (never fails) when creds/stack are absent or T012 has not been applied — keeps a
credential-less checkout green (constitution §Test Type Integrity: real deps, never mocked).

Requires: `frontend/mcm-app/.env.e2e.local` (E2E_ROPC_*, E2E_TEST_*) and
`frontend/mcm-app/.env.local` (KEYCLOAK_SERVICE_CLIENT_ID/SECRET), plus a live stack with the
T012 script applied (agent-gateway + its audience mappers).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx
import pytest

# Make `kc_admin` importable regardless of pytest's conftest naming/rootdir.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import kc_admin  # noqa: E402

_AGENT_ROOT = Path(__file__).resolve().parents[2]  # agents/movie-assistant


def _load_env_local() -> None:
    """Load agents/movie-assistant/.env.local into os.environ (real env wins via setdefault)."""
    env_path = _AGENT_ROOT / ".env.local"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env_local()


@pytest.fixture(scope="session")
def golden_dataset() -> list[dict]:
    data = json.loads((_AGENT_ROOT / "tests/golden/dataset.json").read_text(encoding="utf-8"))
    return list(data)


@pytest.fixture(scope="session")
def cassettes_dir() -> Path:
    return _AGENT_ROOT / "tests/golden/cassettes"


@pytest.fixture(scope="session")
def reexchange_env() -> dict[str, str]:
    """Env for `reexchange_for_mc_service`: agent-gateway creds (secret fetched via admin)."""
    if not kc_admin.SERVICE_CLIENT_SECRET:
        pytest.skip("KEYCLOAK_SERVICE_CLIENT_SECRET not set (frontend/mcm-app/.env.local)")
    try:
        admin = kc_admin.admin_token()
        secret = kc_admin.gateway_secret(admin)
    except httpx.HTTPError as exc:
        pytest.skip(f"Keycloak admin unreachable: {exc}")
    if not secret:
        pytest.skip(
            f"client {kc_admin.GATEWAY_CLIENT_ID} not found — run the T012 token-exchange script"
        )
    return {
        "KEYCLOAK_URL": kc_admin.KEYCLOAK_URL,
        "KEYCLOAK_REALM": kc_admin.KEYCLOAK_REALM,
        "AGENT_GATEWAY_CLIENT_ID": kc_admin.GATEWAY_CLIENT_ID,
        "AGENT_GATEWAY_CLIENT_SECRET": secret,
    }


@pytest.fixture(scope="session")
def subject_token() -> str:
    """A real user token carrying `agent-gateway` in `aud` — the re-exchange subject."""
    if (
        not kc_admin.ROPC_CLIENT_ID
        or not kc_admin.ROPC_CLIENT_SECRET
        or not kc_admin.SERVICE_CLIENT_SECRET
    ):
        pytest.skip("ROPC / service-account creds not set — needs the live stack")
    try:
        admin = kc_admin.admin_token()
        ropc = kc_admin.find_client(admin, kc_admin.ROPC_CLIENT_ID)
        if not ropc:
            pytest.skip(f"ROPC client {kc_admin.ROPC_CLIENT_ID} not found")
        kc_admin.ensure_ropc_audience(admin, ropc["id"], kc_admin.GATEWAY_CLIENT_ID)
        resp = kc_admin.ropc_token(kc_admin.TEST_USER, kc_admin.TEST_PASSWORD)
    except httpx.HTTPError as exc:
        pytest.skip(f"Keycloak unreachable at {kc_admin.KEYCLOAK_URL}: {exc}")
    if resp.status_code != 200:
        pytest.skip(f"ROPC token request failed ({resp.status_code}): {resp.text[:200]}")
    return str(resp.json()["access_token"])
