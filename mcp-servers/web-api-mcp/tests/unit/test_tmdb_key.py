"""Per-request TMDB key (018 US2 / T031).

The user's own TMDB key rides as the `X-TMDB-Key` request header so web-api-mcp uses per-user
credentials instead of a shared env/Vault key (FR-021). `_tmdb_key()` prefers the per-request key
captured by a pure-ASGI middleware into a request-local ContextVar; the static env/Vault key is
only a fallback (dev / tests / non-user paths). The key is never logged (SC-004 leak scan).
"""

from __future__ import annotations

import pytest

from src import server


def test_tmdb_key_prefers_the_per_request_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TMDB_API_KEY", "shared-env-key")
    server._tmdb_key_cache = None
    token = server._request_tmdb_key.set("user-key-018")
    try:
        assert server._tmdb_key() == "user-key-018"
    finally:
        server._request_tmdb_key.reset(token)


def test_tmdb_key_falls_back_to_env_without_a_per_request_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TMDB_API_KEY", "shared-env-key")
    server._tmdb_key_cache = None
    assert server._request_tmdb_key.get() is None
    assert server._tmdb_key() == "shared-env-key"


def test_tmdb_key_raises_when_no_per_request_and_no_static_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 018 review #6: in a per-user-only deployment with no shared key, a call lacking the
    # X-TMDB-Key header must RAISE a clear config error — never make an unauthenticated TMDB
    # request that 401s and looks like an empty search result.
    monkeypatch.delenv("TMDB_API_KEY", raising=False)
    server._tmdb_key_cache = None
    assert server._request_tmdb_key.get() is None
    with pytest.raises(RuntimeError, match="No TMDB key available"):
        server._tmdb_key()


def test_static_tmdb_key_primes_tolerantly_to_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    # build_app() primes via _static_tmdb_key(), which tolerates an absent shared key (caches "")
    # so startup never crashes in a per-user-only deployment.
    monkeypatch.delenv("TMDB_API_KEY", raising=False)
    server._tmdb_key_cache = None
    assert server._static_tmdb_key() == ""
    assert server._tmdb_key_cache == ""  # primed, won't re-resolve


async def test_middleware_captures_x_tmdb_key_header_into_the_contextvar() -> None:
    captured: dict[str, str | None] = {}

    async def app(scope: dict, receive: object, send: object) -> None:
        captured["key"] = server._request_tmdb_key.get()

    mw = server.TmdbKeyMiddleware(app)
    scope = {"type": "http", "headers": [(b"x-tmdb-key", b"hdr-key-xyz")]}
    await mw(scope, None, None)
    assert captured["key"] == "hdr-key-xyz"
    assert server._request_tmdb_key.get() is None  # reset after the request — no leak


async def test_middleware_passes_through_non_http_scopes() -> None:
    seen: dict[str, str] = {}

    async def app(scope: dict, receive: object, send: object) -> None:
        seen["type"] = scope["type"]

    mw = server.TmdbKeyMiddleware(app)
    await mw({"type": "lifespan"}, None, None)
    assert seen["type"] == "lifespan"
