"""Downscoped-token acquisition seam (T024 piece 4).

`acquire_downscoped_token` is the single entry point the (US1) MCP-client tool path calls
to obtain the mc-service token for a tool call. It composes the T024 identity machinery:

    OPA authorize  →  RFC 8693 re-exchange  →  cache per (user, audience, subject token)

The cache is bounded by the exchanged token's ≤60 s TTL (research R3) so a burst of tool
calls within one run segment reuses one downscoped token; a denied authorization raises
`PermissionError` before any exchange. Tokens are never logged or checkpointed (SC-004).

`authorize` and `exchange` are injected (US1 wires `opa.authorize_exchange` and
`token_exchange.reexchange_for_mc_service`); the cache instance is owned by the caller so
its lifetime matches the gateway process. This keeps the seam pure and unit-testable.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Awaitable, Callable

from src.tools.token_exchange import ExchangedToken

# The audience the downscoped token is bound to (research R3 binding signal) and the cache
# key. The token also carries `movie-collection-manager` (so the unchanged mc-service accepts
# it) via the agent-gateway audience mappers — see configure-token-exchange.mjs.
MC_SERVICE_AUDIENCE = "mc-service"

# Refresh a downscoped token this many seconds BEFORE its reported expiry. The reported
# `expires_in` is measured at mint time, but the cache stores it relative to receipt time, and
# mc-service validates against the JWT's real `exp` — exchange latency + container clock skew mean
# a token can be rejected (401) while the cache still believes it valid. Without this margin a long
# bulk apply (a large import) hit a cluster of 401s at each TTL boundary — some rows reported "could
# not be imported". Re-exchanging ahead of expiry closes that window (feature 014 follow-up).
_EXPIRY_SKEW_SECONDS = 15.0

AuthorizeFn = Callable[[str, str], Awaitable[bool]]
ExchangeFn = Callable[[str], Awaitable[ExchangedToken]]


class DownscopedTokenCache:
    """In-memory `(user, audience, sha256(subject token)) -> token` cache, bounded by TTL.

    Keyed by a digest of the presented subject token, not by `user_id` alone (spec 094): `user_id`
    is the token's `sub` decoded WITHOUT a signature check, and a hit returns before OPA and the
    Keycloak re-exchange, so keying on it would serve a victim's cached token to any JWT carrying
    the victim's `sub`. The digest means only the token that minted an entry can read it, and the
    subject token itself is never held.

    Nothing is persisted to disk; entries expire at `now + expires_in - skew`, are dropped on read
    once stale, and every `put` prunes the expired ones (per-token keys outnumber per-user keys).
    `clock` is injectable for deterministic tests.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._store: dict[tuple[str, str, str], tuple[str, float]] = {}

    @staticmethod
    def _key(subject_token: str, user_id: str, audience: str) -> tuple[str, str, str]:
        digest = hashlib.sha256(subject_token.encode("utf-8")).hexdigest()
        return (user_id, audience, digest)

    def get(self, subject_token: str, user_id: str, audience: str) -> str | None:
        key = self._key(subject_token, user_id, audience)
        entry = self._store.get(key)
        if entry is None:
            return None
        token, expires_at = entry
        if self._clock() >= expires_at:
            del self._store[key]
            return None
        return token

    def put(
        self, subject_token: str, user_id: str, audience: str, token: str, expires_in: int
    ) -> None:
        now = self._clock()
        for stale in [k for k, (_, expires_at) in self._store.items() if now >= expires_at]:
            del self._store[stale]
        # Expire ahead of the reported lifetime so we re-exchange before mc-service rejects the
        # token (latency + clock skew). Clamp at 0 so a very short-lived token is simply not cached.
        ttl = max(0.0, expires_in - _EXPIRY_SKEW_SECONDS)
        self._store[self._key(subject_token, user_id, audience)] = (token, now + ttl)


async def acquire_downscoped_token(
    subject_token: str,
    *,
    user_id: str,
    authorize: AuthorizeFn,
    exchange: ExchangeFn,
    cache: DownscopedTokenCache,
    audience: str = MC_SERVICE_AUDIENCE,
) -> str:
    """Return a downscoped mc-service token for `user_id`, minting one if not cached.

    :raises PermissionError: if OPA denies the exchange (short-circuits before exchanging).
    :raises TokenExchangeError: if the Keycloak re-exchange fails (propagated).
    """
    cached = cache.get(subject_token, user_id, audience)
    if cached is not None:
        return cached

    if not await authorize(user_id, audience):
        raise PermissionError(
            f"token exchange denied for user {user_id} against audience {audience}"
        )

    exchanged = await exchange(subject_token)
    cache.put(subject_token, user_id, audience, exchanged.token, exchanged.expires_in)
    return exchanged.token
