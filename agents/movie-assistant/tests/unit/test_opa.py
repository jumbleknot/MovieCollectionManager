"""Unit tests for OPA authorization of the token exchange (T024).

OPA answers "may this agent act for this user against this audience?" before the gateway
re-exchanges (research R3). It is CONFIG-GATED: when `OPA_URL` is unset (OPA not deployed
yet) the check is skipped (allow) with a warning, so local dev/the MVP is not blocked.
When `OPA_URL` IS set, the decision is enforced and the check FAILS CLOSED — any deny,
non-2xx, malformed response, or unreachable OPA denies the exchange (a down policy engine
must not silently permit agent calls). OPA receives only non-sensitive identity
(user_id/audience/agent_origin) — never a token.
"""

from __future__ import annotations

import httpx

from src.tools.opa import authorize_exchange, is_opa_configured

_USER = "kc-user-uuid-123"
_AUD = "mc-service"


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_is_opa_configured_reflects_opa_url() -> None:
    assert is_opa_configured({"OPA_URL": "http://opa:8181"}) is True
    assert is_opa_configured({}) is False
    assert is_opa_configured({"OPA_URL": ""}) is False


async def test_unconfigured_skips_and_allows_without_calling_opa() -> None:
    called = False

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"result": False})

    async with _client(handler) as client:
        allowed = await authorize_exchange(_USER, _AUD, env={}, client=client)

    assert allowed is True
    assert called is False  # gated — no OPA call when OPA_URL unset


async def test_sends_nonsensitive_identity_and_allows_on_permit() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.update(json.loads(request.content.decode())["input"])
        return httpx.Response(200, json={"result": True})

    async with _client(handler) as client:
        allowed = await authorize_exchange(
            _USER, _AUD, env={"OPA_URL": "http://opa:8181"}, client=client
        )

    assert allowed is True
    assert seen["user_id"] == _USER
    assert seen["audience"] == _AUD
    assert seen["agent_origin"] is True


async def test_denies_on_explicit_deny() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"result": False})

    async with _client(handler) as client:
        allowed = await authorize_exchange(
            _USER, _AUD, env={"OPA_URL": "http://opa:8181"}, client=client
        )

    assert allowed is False


async def test_fails_closed_on_opa_error_status() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    async with _client(handler) as client:
        allowed = await authorize_exchange(
            _USER, _AUD, env={"OPA_URL": "http://opa:8181"}, client=client
        )

    assert allowed is False  # configured + erroring → deny


async def test_fails_closed_when_opa_unreachable() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to opa")

    async with _client(handler) as client:
        allowed = await authorize_exchange(
            _USER, _AUD, env={"OPA_URL": "http://opa:8181"}, client=client
        )

    assert allowed is False
