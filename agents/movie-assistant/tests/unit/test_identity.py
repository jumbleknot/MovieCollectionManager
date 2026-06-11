"""Unit tests for the downscoped-token acquisition seam (T024 piece 4).

`acquire_downscoped_token` is the single entry point the (US1) MCP-client tool path calls
to obtain the mc-service token for a tool call: it OPA-authorizes the exchange, then
re-exchanges the run-scoped subject token, caching the result per (user, audience) bounded
by the exchanged token's ≤60 s TTL so a burst of tool calls in one run segment reuses it.
A denied authorization raises before any exchange. Tokens are never logged or checkpointed.

OPA and the Keycloak re-exchange are injected here (their own real-dependency tests cover
them); this exercises the composition: authorize → exchange → cache → expiry.
"""

from __future__ import annotations

import pytest

from src.tools.identity import DownscopedTokenCache, acquire_downscoped_token
from src.tools.token_exchange import ExchangedToken, TokenExchangeError

_USER = "kc-user-1"
_SUBJECT = "subject.jwt.value"


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_authorizes_then_exchanges_and_returns_token() -> None:
    calls: dict[str, int] = {"authz": 0, "exchange": 0}

    async def authz(user_id: str, audience: str) -> bool:
        calls["authz"] += 1
        return True

    async def exchange(subject_token: str) -> ExchangedToken:
        calls["exchange"] += 1
        return ExchangedToken(token="downscoped-tok", expires_in=60)

    token = await acquire_downscoped_token(
        _SUBJECT, user_id=_USER, authorize=authz, exchange=exchange,
        cache=DownscopedTokenCache(clock=_Clock()),
    )

    assert token == "downscoped-tok"
    assert calls == {"authz": 1, "exchange": 1}


async def test_raises_permission_error_when_opa_denies_without_exchanging() -> None:
    exchanged = False

    async def authz(user_id: str, audience: str) -> bool:
        return False

    async def exchange(subject_token: str) -> ExchangedToken:
        nonlocal exchanged
        exchanged = True
        return ExchangedToken(token="x", expires_in=60)

    with pytest.raises(PermissionError):
        await acquire_downscoped_token(
            _SUBJECT, user_id=_USER, authorize=authz, exchange=exchange,
            cache=DownscopedTokenCache(clock=_Clock()),
        )
    assert exchanged is False  # denial short-circuits before any exchange


async def test_caches_within_ttl_then_re_exchanges_after_expiry() -> None:
    clock = _Clock()
    cache = DownscopedTokenCache(clock=clock)
    exchanges = 0

    async def authz(user_id: str, audience: str) -> bool:
        return True

    async def exchange(subject_token: str) -> ExchangedToken:
        nonlocal exchanges
        exchanges += 1
        return ExchangedToken(token=f"tok-{exchanges}", expires_in=60)

    async def acquire() -> str:
        return await acquire_downscoped_token(
            _SUBJECT, user_id=_USER, authorize=authz, exchange=exchange, cache=cache
        )

    first = await acquire()
    second = await acquire()  # within TTL → cached, no new exchange
    assert first == second == "tok-1"
    assert exchanges == 1

    clock.now += 61  # past the ≤60 s TTL
    third = await acquire()
    assert third == "tok-2"
    assert exchanges == 2


async def test_propagates_exchange_failure() -> None:
    async def authz(user_id: str, audience: str) -> bool:
        return True

    async def exchange(subject_token: str) -> ExchangedToken:
        raise TokenExchangeError("rejected")

    with pytest.raises(TokenExchangeError):
        await acquire_downscoped_token(
            _SUBJECT, user_id=_USER, authorize=authz, exchange=exchange,
            cache=DownscopedTokenCache(clock=_Clock()),
        )
