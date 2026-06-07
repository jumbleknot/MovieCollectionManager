"""Integration fixtures for the gateway token re-exchange (T024) against REAL Keycloak.

Self-sufficient via the BFF service account (the same one the BFF integration harness uses):
it fetches the confidential `agent-gateway` client secret through the Admin API and ensures
the `mcm-bff-test` ROPC client's tokens carry `agent-gateway` in their `aud` — so a real user
token can act as the re-exchange SUBJECT (precondition 1). The full BFF→subject→gateway mint
chain is exercised end-to-end in US1/E2E; here we verify the re-exchange FUNCTION + the
agent-gateway CONFIG (aud=[movie-collection-manager, mc-service] + agent_origin + ≤60 s TTL).

Skips cleanly (never fails) when creds/stack are absent or T012 has not been applied — keeps
a credential-less checkout green (constitution §Test Type Integrity: real deps, never mocked).

Requires: `frontend/mcm-app/.env.e2e.local` (E2E_ROPC_*, E2E_TEST_*) and
`frontend/mcm-app/.env.local` (KEYCLOAK_SERVICE_CLIENT_ID/SECRET), plus a live stack with
the T012 script applied (agent-gateway + its audience mappers).
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[4]


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip()
    return values


_FRONTEND = _REPO_ROOT / "frontend" / "mcm-app"
_ENV = {**_load_env_file(_FRONTEND / ".env.e2e.local"), **_load_env_file(_FRONTEND / ".env.local")}


def _cfg(key: str, default: str = "") -> str:
    return os.environ.get(key) or _ENV.get(key) or default


KEYCLOAK_URL = _cfg("KEYCLOAK_URL", "http://localhost:8099")
KEYCLOAK_REALM = _cfg("KEYCLOAK_REALM", "jumbleknot")
_TOKEN_EP = f"{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token"
_ADMIN_BASE = f"{KEYCLOAK_URL}/admin/realms/{KEYCLOAK_REALM}"

ROPC_CLIENT_ID = _cfg("E2E_ROPC_CLIENT_ID")
ROPC_CLIENT_SECRET = _cfg("E2E_ROPC_CLIENT_SECRET")
TEST_USER = _cfg("E2E_TEST_USER", "testuser")
TEST_PASSWORD = _cfg("E2E_TEST_PASSWORD", "TestPass1!ok")
SERVICE_CLIENT_ID = _cfg("KEYCLOAK_SERVICE_CLIENT_ID", "mcm-bff-service")
SERVICE_CLIENT_SECRET = _cfg("KEYCLOAK_SERVICE_CLIENT_SECRET")
GATEWAY_CLIENT_ID = _cfg("AGENT_GATEWAY_CLIENT_ID", "agent-gateway")


def _admin_token() -> str:
    resp = httpx.post(
        _TOKEN_EP,
        data={
            "grant_type": "client_credentials",
            "client_id": SERVICE_CLIENT_ID,
            "client_secret": SERVICE_CLIENT_SECRET,
        },
        timeout=15.0,
    )
    if resp.status_code != 200:
        pytest.skip(f"service-account admin token failed ({resp.status_code})")
    return str(resp.json()["access_token"])


def _find_client(admin: str, client_id: str) -> dict[str, str] | None:
    resp = httpx.get(
        f"{_ADMIN_BASE}/clients",
        params={"clientId": client_id},
        headers={"Authorization": f"Bearer {admin}"},
        timeout=15.0,
    )
    resp.raise_for_status()
    items = resp.json()
    return items[0] if items else None


def _ensure_ropc_audience(admin: str, ropc_internal_id: str, audience_client: str) -> None:
    auth = {"Authorization": f"Bearer {admin}"}
    url = f"{_ADMIN_BASE}/clients/{ropc_internal_id}/protocol-mappers/models"
    existing = httpx.get(url, headers=auth, timeout=15.0).json()
    if any(
        m.get("config", {}).get("included.client.audience") == audience_client for m in existing
    ):
        return
    httpx.post(
        url,
        headers={**auth, "Content-Type": "application/json"},
        json={
            "name": f"aud-{audience_client}",
            "protocol": "openid-connect",
            "protocolMapper": "oidc-audience-mapper",
            "config": {
                "included.client.audience": audience_client,
                "id.token.claim": "false",
                "access.token.claim": "true",
            },
        },
        timeout=15.0,
    )


@pytest.fixture(scope="session")
def reexchange_env() -> dict[str, str]:
    """Env for `reexchange_for_mc_service`: agent-gateway creds (secret fetched via admin)."""
    if not SERVICE_CLIENT_SECRET:
        pytest.skip("KEYCLOAK_SERVICE_CLIENT_SECRET not set (frontend/mcm-app/.env.local)")
    try:
        admin = _admin_token()
        gateway = _find_client(admin, GATEWAY_CLIENT_ID)
    except httpx.HTTPError as exc:
        pytest.skip(f"Keycloak admin unreachable: {exc}")
    if not gateway:
        pytest.skip(f"client {GATEWAY_CLIENT_ID} not found — run the T012 token-exchange script")
    secret = httpx.get(
        f"{_ADMIN_BASE}/clients/{gateway['id']}/client-secret",
        headers={"Authorization": f"Bearer {admin}"},
        timeout=15.0,
    ).json()["value"]
    return {
        "KEYCLOAK_URL": KEYCLOAK_URL,
        "KEYCLOAK_REALM": KEYCLOAK_REALM,
        "AGENT_GATEWAY_CLIENT_ID": GATEWAY_CLIENT_ID,
        "AGENT_GATEWAY_CLIENT_SECRET": secret,
    }


@pytest.fixture(scope="session")
def subject_token() -> str:
    """A real user token carrying `agent-gateway` in `aud` — the re-exchange subject."""
    if not ROPC_CLIENT_ID or not ROPC_CLIENT_SECRET or not SERVICE_CLIENT_SECRET:
        pytest.skip("ROPC / service-account creds not set — needs the live stack")
    try:
        admin = _admin_token()
        ropc = _find_client(admin, ROPC_CLIENT_ID)
        if not ropc:
            pytest.skip(f"ROPC client {ROPC_CLIENT_ID} not found")
        _ensure_ropc_audience(admin, ropc["id"], GATEWAY_CLIENT_ID)
        resp = httpx.post(
            _TOKEN_EP,
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
    except httpx.HTTPError as exc:
        pytest.skip(f"Keycloak unreachable at {KEYCLOAK_URL}: {exc}")
    if resp.status_code != 200:
        pytest.skip(f"ROPC token request failed ({resp.status_code}): {resp.text[:200]}")
    return str(resp.json()["access_token"])
