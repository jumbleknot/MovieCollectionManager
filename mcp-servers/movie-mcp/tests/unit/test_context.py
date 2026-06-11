"""Unit tests for movie-mcp's per-request token capture (T043/MCP transport).

The gateway sends the downscoped `aud=mc-service` JWT as the request `Authorization`
header (out-of-band; never an LLM-visible tool arg — SC-004). A pure-ASGI middleware
captures it into a ContextVar that tool handlers read via `get_request_token()`. Pure ASGI
(not Starlette BaseHTTPMiddleware) so the ContextVar set survives into the handler — the
same constraint proven for the gateway's SubjectTokenMiddleware.
"""

from __future__ import annotations

import pytest

from src.context import (
    TokenCaptureMiddleware,
    current_request_token,
    get_request_token,
    set_request_token,
)


@pytest.mark.asyncio
async def test_middleware_captures_bearer_token_into_context() -> None:
    seen: dict[str, str | None] = {}

    async def app(scope: dict, receive: object, send: object) -> None:
        seen["token"] = current_request_token()

    mw = TokenCaptureMiddleware(app)
    scope = {"type": "http", "headers": [(b"authorization", b"Bearer abc.def.ghi")]}

    async def receive() -> dict:
        return {}

    async def send(_m: dict) -> None:
        return None

    await mw(scope, receive, send)

    assert seen["token"] == "abc.def.ghi"
    # Reset after the request — no token leaks across requests.
    assert current_request_token() is None


@pytest.mark.asyncio
async def test_middleware_without_auth_header_leaves_token_unset() -> None:
    seen: dict[str, str | None] = {}

    async def app(scope: dict, receive: object, send: object) -> None:
        seen["token"] = current_request_token()

    mw = TokenCaptureMiddleware(app)

    async def receive() -> dict:
        return {}

    async def send(_m: dict) -> None:
        return None

    await mw({"type": "http", "headers": []}, receive, send)
    assert seen["token"] is None


def test_get_request_token_raises_when_absent() -> None:
    set_request_token(None)
    with pytest.raises(PermissionError):
        get_request_token()


def test_set_then_get_request_token_round_trips() -> None:
    set_request_token("tok-123")
    assert get_request_token() == "tok-123"
    set_request_token(None)
