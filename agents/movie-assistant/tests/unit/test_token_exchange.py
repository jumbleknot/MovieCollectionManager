"""Unit tests for the gateway-side RFC 8693 re-exchange (T024).

At tool-call time the gateway exchanges the BFF-supplied run-scoped subject token for the
downscoped token mc-service receives. Requester = `agent-gateway` (confidential). No
`audience` param is sent — agent-gateway's audience mappers stamp aud=[movie-collection-manager,
mc-service] (so the UNCHANGED mc-service accepts it while `mc-service` stays as R3's binding
signal), which also sidesteps the "Requested audience not available" precondition. TTL is
capped at <=60 s (research R3). The token is never logged or checkpointed (SC-004).

These tests exercise request construction, TTL capping, error + config handling, and the
no-leak invariant with a mocked Keycloak (httpx.MockTransport). The real-Keycloak assertion
lives in tests/integration/test_token_reexchange.py.
"""

from __future__ import annotations

import logging

import httpx
import pytest

from src.tools.token_exchange import (
    EXCHANGED_TOKEN_MAX_TTL_SECONDS,
    ExchangedToken,
    TokenExchangeError,
    is_reexchange_configured,
    reexchange_for_mc_service,
)

_ENV = {
    "KEYCLOAK_URL": "http://localhost:8099",
    "KEYCLOAK_REALM": "grumpyrobot",
    "AGENT_GATEWAY_CLIENT_ID": "agent-gateway",
    "AGENT_GATEWAY_CLIENT_SECRET": "gw-secret",
}

_SUBJECT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.subjectsig"
_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
_ACCESS = "urn:ietf:params:oauth:token-type:access_token"


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_is_reexchange_configured_true_with_gateway_creds() -> None:
    assert is_reexchange_configured(_ENV) is True


def test_is_reexchange_configured_false_without_secret() -> None:
    assert is_reexchange_configured({**_ENV, "AGENT_GATEWAY_CLIENT_SECRET": ""}) is False


async def test_builds_rfc8693_exchange_request_with_no_audience_param() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        for k, v in httpx.QueryParams(request.content.decode()).items():
            seen[k] = v
        return httpx.Response(200, json={"access_token": "exchanged", "expires_in": 60})

    async with _client(handler) as client:
        await reexchange_for_mc_service(_SUBJECT, env=_ENV, client=client)

    assert "/protocol/openid-connect/token" in seen["url"]
    assert seen["grant_type"] == _GRANT
    assert seen["subject_token"] == _SUBJECT
    assert seen["subject_token_type"] == _ACCESS
    assert seen["client_id"] == "agent-gateway"
    assert seen["client_secret"] == "gw-secret"
    # No audience param — the agent-gateway mappers stamp both audiences (precondition-2 sidestep).
    assert "audience" not in seen


async def test_returns_exchanged_token_and_expiry() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "exchanged-tok", "expires_in": 45})

    async with _client(handler) as client:
        result = await reexchange_for_mc_service(_SUBJECT, env=_ENV, client=client)

    assert isinstance(result, ExchangedToken)
    assert result.token == "exchanged-tok"
    assert result.expires_in == 45


async def test_caps_expiry_at_ceiling() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "exchanged", "expires_in": 3600})

    async with _client(handler) as client:
        result = await reexchange_for_mc_service(_SUBJECT, env=_ENV, client=client)

    assert result.expires_in == EXCHANGED_TOKEN_MAX_TTL_SECONDS
    assert EXCHANGED_TOKEN_MAX_TTL_SECONDS <= 60


async def test_raises_typed_error_on_rejection() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_request"})

    async with _client(handler) as client:
        with pytest.raises(TokenExchangeError):
            await reexchange_for_mc_service(_SUBJECT, env=_ENV, client=client)


async def test_raises_when_not_configured() -> None:
    with pytest.raises(TokenExchangeError):
        await reexchange_for_mc_service(_SUBJECT, env={**_ENV, "AGENT_GATEWAY_CLIENT_SECRET": ""})


async def test_never_logs_the_token(caplog: pytest.LogCaptureFixture) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_request"})

    with caplog.at_level(logging.DEBUG):
        async with _client(handler) as client:
            with pytest.raises(TokenExchangeError):
                await reexchange_for_mc_service(_SUBJECT, env=_ENV, client=client)

    blob = "\n".join(r.getMessage() for r in caplog.records)
    assert _SUBJECT not in blob
