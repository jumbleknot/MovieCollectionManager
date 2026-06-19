"""Per-request TMDB key (FR-021).

The requesting user's own TMDB key rides as the `X-TMDB-Key` request header; a pure-ASGI
middleware captures it into a request-local ContextVar, and `_tmdb_key()` reads ONLY that — there
is NO shared env/Vault fallback (per-user credentials only; no-fallbacks decision 2026-06-19). A
call with no per-request key raises a clear config error. The key is never logged (SC-004 scan).
"""

from __future__ import annotations

import pytest

from src import server


def test_tmdb_key_returns_the_per_request_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # Even with a stray TMDB_API_KEY in the environment, the per-request key is the sole source —
    # the env value is never consulted (no shared fallback).
    monkeypatch.setenv("TMDB_API_KEY", "stray-env-key")
    token = server._request_tmdb_key.set("user-key-018")
    try:
        assert server._tmdb_key() == "user-key-018"
    finally:
        server._request_tmdb_key.reset(token)


def test_tmdb_key_raises_when_no_per_request_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # No per-request key AND a stray env key present → still RAISE: there is no env fallback, by
    # design. A missing per-request key is a config error, never a silent unauthenticated call.
    monkeypatch.setenv("TMDB_API_KEY", "stray-env-key")
    assert server._request_tmdb_key.get() is None
    with pytest.raises(RuntimeError, match="No TMDB key"):
        server._tmdb_key()


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
