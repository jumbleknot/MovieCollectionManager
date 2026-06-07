"""Shared Keycloak/mc-service helpers for the live integration tests.

Extracted here (rather than left private in conftest.py) so test modules can import the
admin/ROPC helpers directly — `from conftest import …` is ambiguous when both
`tests/conftest.py` and `tests/integration/conftest.py` exist. Config comes from the same env
files the BFF harness uses; everything skips cleanly when creds/stack are absent.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

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


def cfg(key: str, default: str = "") -> str:
    return os.environ.get(key) or _ENV.get(key) or default


KEYCLOAK_URL = cfg("KEYCLOAK_URL", "http://localhost:8099")
KEYCLOAK_REALM = cfg("KEYCLOAK_REALM", "jumbleknot")
TOKEN_EP = f"{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token"
ADMIN_BASE = f"{KEYCLOAK_URL}/admin/realms/{KEYCLOAK_REALM}"

ROPC_CLIENT_ID = cfg("E2E_ROPC_CLIENT_ID")
ROPC_CLIENT_SECRET = cfg("E2E_ROPC_CLIENT_SECRET")
TEST_USER = cfg("E2E_TEST_USER", "testuser")
TEST_PASSWORD = cfg("E2E_TEST_PASSWORD", "TestPass1!ok")
SERVICE_CLIENT_ID = cfg("KEYCLOAK_SERVICE_CLIENT_ID", "mcm-bff-service")
SERVICE_CLIENT_SECRET = cfg("KEYCLOAK_SERVICE_CLIENT_SECRET")
GATEWAY_CLIENT_ID = cfg("AGENT_GATEWAY_CLIENT_ID", "agent-gateway")
MC_SERVICE_URL = cfg("MC_SERVICE_URL", "http://localhost:3001")
APP_CLIENT_ID = "movie-collection-manager"


def admin_token() -> str:
    resp = httpx.post(
        TOKEN_EP,
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


def _auth(admin: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {admin}", "Content-Type": "application/json"}


def find_client(admin: str, client_id: str) -> dict[str, Any] | None:
    resp = httpx.get(
        f"{ADMIN_BASE}/clients", params={"clientId": client_id},
        headers={"Authorization": f"Bearer {admin}"}, timeout=15.0,
    )
    resp.raise_for_status()
    items = resp.json()
    return items[0] if items else None


def ensure_ropc_audience(admin: str, ropc_internal_id: str, audience_client: str) -> None:
    auth = {"Authorization": f"Bearer {admin}"}
    url = f"{ADMIN_BASE}/clients/{ropc_internal_id}/protocol-mappers/models"
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


def gateway_secret(admin: str) -> str | None:
    gateway = find_client(admin, GATEWAY_CLIENT_ID)
    if not gateway:
        return None
    return str(
        httpx.get(
            f"{ADMIN_BASE}/clients/{gateway['id']}/client-secret",
            headers={"Authorization": f"Bearer {admin}"}, timeout=15.0,
        ).json()["value"]
    )


def ropc_token(username: str, password: str) -> httpx.Response:
    return httpx.post(
        TOKEN_EP,
        data={
            "grant_type": "password", "client_id": ROPC_CLIENT_ID,
            "client_secret": ROPC_CLIENT_SECRET, "username": username,
            "password": password, "scope": "openid",
        },
        timeout=15.0,
    )


# ── user provisioning (T045 cross-user tests) ────────────────────────────────────────────────


def create_user(admin: str, username: str, password: str) -> str:
    """Create an enabled realm user with a permanent password; return its id (idempotent-ish)."""
    httpx.post(
        f"{ADMIN_BASE}/users", headers=_auth(admin), timeout=15.0,
        json={"username": username, "enabled": True, "emailVerified": True,
              "email": f"{username}@test.local", "firstName": "T045", "lastName": "Other",
              "requiredActions": []},
    )
    resp = httpx.get(
        f"{ADMIN_BASE}/users", params={"username": username, "exact": "true"},
        headers=_auth(admin), timeout=15.0,
    )
    resp.raise_for_status()
    uid = str(resp.json()[0]["id"])
    # Clear any realm-default required actions (e.g. VERIFY_EMAIL) that would 400 the ROPC grant
    # with "Account is not fully set up".
    httpx.put(
        f"{ADMIN_BASE}/users/{uid}", headers=_auth(admin), timeout=15.0,
        json={"enabled": True, "emailVerified": True, "requiredActions": []},
    ).raise_for_status()
    httpx.put(
        f"{ADMIN_BASE}/users/{uid}/reset-password", headers=_auth(admin), timeout=15.0,
        json={"type": "password", "value": password, "temporary": False},
    ).raise_for_status()
    return uid


def assign_app_role(admin: str, uid: str, role_name: str) -> None:
    """Assign a `movie-collection-manager` client role (e.g. mc-user) to a user."""
    mcm = find_client(admin, APP_CLIENT_ID)
    assert mcm is not None, f"{APP_CLIENT_ID} client not found"
    role = httpx.get(
        f"{ADMIN_BASE}/clients/{mcm['id']}/roles/{role_name}", headers=_auth(admin), timeout=15.0
    )
    role.raise_for_status()
    httpx.post(
        f"{ADMIN_BASE}/users/{uid}/role-mappings/clients/{mcm['id']}",
        headers=_auth(admin), json=[role.json()], timeout=15.0,
    ).raise_for_status()


def delete_user(admin: str, uid: str) -> None:
    httpx.delete(f"{ADMIN_BASE}/users/{uid}", headers=_auth(admin), timeout=15.0)
