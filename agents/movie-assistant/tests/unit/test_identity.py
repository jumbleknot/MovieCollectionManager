"""Unit tests for the downscoped-token acquisition seam (T024 piece 4).

`acquire_downscoped_token` is the single entry point the (US1) MCP-client tool path calls
to obtain the mc-service token for a tool call: it OPA-authorizes the exchange, then
re-exchanges the run-scoped subject token, caching the result per (user, audience, subject-token
digest) bounded by the exchanged token's ≤60 s TTL, so a burst of tool calls in one run segment
reuses it.
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


async def test_re_exchanges_ahead_of_real_expiry_to_avoid_a_stale_token_window() -> None:
    """A token must be refreshed BEFORE its real expiry (skew margin), so a long bulk apply never
    hands mc-service an already-expired token mid-run — the import "N could not be imported" 401
    cluster (the cache previously trusted put_time+expires_in with no margin for latency/skew)."""
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

    first = await acquire()  # minted with a 60 s nominal life
    clock.now += 50  # 10 s of nominal life left — but inside the skew margin → treat as expired
    second = await acquire()
    assert first == "tok-1"
    assert second == "tok-2", "must re-exchange ahead of real expiry, not serve a near-dead token"
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


# ── Spec 094: the cache is keyed by the presented subject token, not the unverified `sub` ────────


async def test_forged_token_with_same_sub_misses_the_cache() -> None:
    """FR-001/SC-001: `user_id` is decoded without a signature check, so a hit on it alone would
    hand a victim's cached token to anyone presenting a JWT with the victim's `sub`."""
    cache = DownscopedTokenCache(clock=_Clock())
    seen: list[str] = []

    async def authz(user_id: str, audience: str) -> bool:
        return True

    async def exchange(subject_token: str) -> ExchangedToken:
        seen.append(subject_token)
        return ExchangedToken(token=f"tok-for-{subject_token}", expires_in=60)

    victim = await acquire_downscoped_token(
        "victim.jwt.sig", user_id=_USER, authorize=authz, exchange=exchange, cache=cache
    )
    forged = await acquire_downscoped_token(
        "forged.jwt.sig", user_id=_USER, authorize=authz, exchange=exchange, cache=cache
    )

    assert victim == "tok-for-victim.jwt.sig"
    assert forged != victim, "a different subject token must not be served the cached token"
    assert seen == ["victim.jwt.sig", "forged.jwt.sig"], "the forged token must reach the exchange"


def test_cache_does_not_hold_the_raw_subject_token() -> None:
    """FR-002: the key is a digest; the subject token itself is never stored."""
    cache = DownscopedTokenCache(clock=_Clock())
    cache.put(_SUBJECT, _USER, "mc-service", "downscoped", 60)

    assert cache.get(_SUBJECT, _USER, "mc-service") == "downscoped"
    assert _SUBJECT not in repr(cache._store)


def test_put_prunes_expired_entries() -> None:
    """FR-004: per-token keys outnumber per-user keys, so expired entries go on write too."""
    clock = _Clock()
    cache = DownscopedTokenCache(clock=clock)
    cache.put("old.jwt.sig", _USER, "mc-service", "old", 60)
    clock.now += 61
    cache.put("new.jwt.sig", _USER, "mc-service", "new", 60)

    assert len(cache._store) == 1
