"""T074c — OPA agent-token-exchange authorization against REAL OPA (T024/R3/R16).

Proves `opa.authorize_exchange` against the REAL OPA server (observability profile):
  - allows mc-service (the only permitted audience per the Rego policy)
  - denies any other audience (fail-deny)
  - fails closed when OPA is unreachable (config-gated fail-closed)
  - allows (gated skip) when OPA_URL is unset — so local dev without OPA is unaffected

Skips cleanly when OPA is not reachable (never fails in a credential-less checkout).
Real dependency, never mocked — constitution §Test Type Integrity.

Run:
  docker compose --profile observability up -d opa
  pnpm nx test:integration movie-assistant -- -k opa_authz
"""

from __future__ import annotations

import os

import httpx
import pytest

from src.tools import opa

# The host-side OPA address: localhost:8181 (Docker port-bound).
# We use this constant both for the skip guard and as the OPA_URL value we inject via
# monkeypatch in each test — this ensures the guard and the tests agree on which URL to probe.
OPA_URL = "http://localhost:8181"


def _opa_up() -> bool:
    try:
        return httpx.get(f"{OPA_URL}/health", timeout=2.0).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not _opa_up(), reason="OPA not reachable")


@pytest.mark.asyncio
async def test_allows_mc_service(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real OPA policy allows audience=mc-service with agent_origin=true."""
    monkeypatch.setenv("OPA_URL", OPA_URL)
    assert await opa.authorize_exchange("u1", "mc-service") is True


@pytest.mark.asyncio
async def test_denies_wrong_audience(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real OPA policy denies any audience other than mc-service."""
    monkeypatch.setenv("OPA_URL", OPA_URL)
    assert await opa.authorize_exchange("u1", "some-other-service") is False


@pytest.mark.asyncio
async def test_fail_closed_when_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail closed (deny) when OPA_URL is set but nothing is listening."""
    monkeypatch.setenv("OPA_URL", "http://127.0.0.1:1")  # nothing listening
    assert await opa.authorize_exchange("u1", "mc-service") is False


@pytest.mark.asyncio
async def test_gated_allow_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """When OPA_URL is unset the check is skipped (allow) — dev without OPA is unaffected."""
    monkeypatch.delenv("OPA_URL", raising=False)
    assert await opa.authorize_exchange("u1", "mc-service") is True
