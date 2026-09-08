"""Feature 068 / US3 — the gateway's per-call credential custody across the mcp 1.x -> 2.x move.

Contract: specs/068-mcp-2x-migration/contracts/mcp-tool-result.md §3 (INV-6..INV-9).

This is the only code in feature 068 that carries a credential, and 2.x rewrites it rather than
renaming it: `streamable_http_client` dropped `auth=`, so the caller now builds and OWNS the HTTP
client the auth object attaches to. Two consequences are asserted here.

INV-6 (independence) was previously covered only indirectly, by integration tests that assert the
positive case. A transport that started defaulting a stale credential onto every request would pass
those — so both the "present" and the "absent" direction are asserted explicitly.

INV-8 (release on both paths) has NO 1.x counterpart: the transport owned the client, so there was
nothing for the caller to leak. On 2.x a leaked client keeps a credential-bearing auth object alive.
"""

from __future__ import annotations

import httpx2
import pytest

from src.tools import mcp_tools


def _headers_for(token: str | None, tmdb_key: str | None) -> dict[str, str]:
    """Drive the auth object exactly as the transport does: one request through auth_flow()."""
    tok = mcp_tools._call_token.set(token)
    key = mcp_tools._call_tmdb_key.set(tmdb_key)
    try:
        request = httpx2.Request("POST", "http://movie-mcp:8000/mcp")
        flow = mcp_tools.DownscopedTokenAuth().auth_flow(request)
        return dict(next(flow).headers)
    finally:
        mcp_tools._call_token.reset(tok)
        mcp_tools._call_tmdb_key.reset(key)


def test_auth_object_is_an_httpx2_auth_so_the_2x_transport_accepts_it() -> None:
    """2.x takes an `httpx2.AsyncClient`; an httpx(1) Auth would not be usable by it."""
    assert isinstance(mcp_tools.DownscopedTokenAuth(), httpx2.Auth)


def test_a_movie_server_call_carries_the_bearer_and_NO_tmdb_key() -> None:
    headers = _headers_for(token="downscoped-abc", tmdb_key=None)
    assert headers["authorization"] == "Bearer downscoped-abc"
    assert "x-tmdb-key" not in headers  # INV-6: not defaulted, not inherited


def test_an_external_api_call_carries_the_key_and_NO_bearer() -> None:
    headers = _headers_for(token=None, tmdb_key="tmdb-xyz")
    assert headers["x-tmdb-key"] == "tmdb-xyz"
    assert "authorization" not in headers  # INV-6: the direction a positive-only test misses


def test_neither_credential_set_means_neither_header() -> None:
    headers = _headers_for(token=None, tmdb_key=None)
    assert "authorization" not in headers
    assert "x-tmdb-key" not in headers


def test_both_credentials_ride_together_when_both_are_set() -> None:
    headers = _headers_for(token="t", tmdb_key="k")
    assert headers["authorization"] == "Bearer t"
    assert headers["x-tmdb-key"] == "k"


class _SpyAsyncClient:
    """Records whether the client the gateway created was released."""

    instances: list[_SpyAsyncClient] = []

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs
        self.closed = False
        _SpyAsyncClient.instances.append(self)

    async def __aenter__(self) -> _SpyAsyncClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.closed = True

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture
def spy_client(monkeypatch: pytest.MonkeyPatch) -> type[_SpyAsyncClient]:
    _SpyAsyncClient.instances = []
    monkeypatch.setattr(mcp_tools.httpx2, "AsyncClient", _SpyAsyncClient)
    return _SpyAsyncClient


@pytest.mark.asyncio
async def test_the_client_is_released_when_the_call_FAILS(
    spy_client: type[_SpyAsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """INV-8 — the path that leaks if forgotten, and the one a happy-path test never reaches."""

    def _boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("transport exploded")

    import mcp.client.streamable_http as transport

    monkeypatch.setattr(transport, "streamable_http_client", _boom)
    with pytest.raises(RuntimeError):
        await mcp_tools.call_mcp_tool("http://movie-mcp:8000/mcp", "list_collections", {}, "tok")

    assert spy_client.instances, "the gateway must construct the client it now owns"
    leaked = [c for c in spy_client.instances if not c.closed]
    assert not leaked, "a failed call must still release the client"


@pytest.mark.asyncio
async def test_the_auth_object_is_attached_to_the_client_not_to_shared_defaults(
    spy_client: type[_SpyAsyncClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """INV-9 — a credential baked into default headers would outlive its call."""

    def _boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("stop after construction")

    import mcp.client.streamable_http as transport

    monkeypatch.setattr(transport, "streamable_http_client", _boom)
    with pytest.raises(RuntimeError):
        await mcp_tools.call_mcp_tool("http://movie-mcp:8000/mcp", "list_collections", {}, "tok")

    client = spy_client.instances[0]
    assert isinstance(client.kwargs.get("auth"), mcp_tools.DownscopedTokenAuth)
    headers = client.kwargs.get("headers") or {}
    assert not any(h.lower() in {"authorization", "x-tmdb-key"} for h in headers)


# ── Transport-exception namespace (regression, found by the integration tier) ──────────────────
# mcp 2.x moved the MCP client onto httpx2, and httpx2's exceptions are a SEPARATE class hierarchy:
# httpx2.ConnectError is NOT an httpx.ConnectError. _is_transient_exc() tested only the httpx(1)
# base, so after the migration a connect failure stopped being classified transient — the retry and
# dead-letter paths were skipped and the raw error propagated out of the graph.
#
# Nothing in the unit tier caught this: it needs a real unreachable server. It surfaced as
# test_write_resilience_dead_letters_when_movie_mcp_unreachable, which is exactly why that tier runs.


def test_an_httpx2_connect_failure_is_still_classified_transient() -> None:
    assert mcp_tools._is_transient_exc(httpx2.ConnectError("All connection attempts failed"))


def test_an_httpx2_timeout_is_still_classified_transient() -> None:
    assert mcp_tools._is_transient_exc(httpx2.ReadTimeout("timed out"))


def test_a_transient_httpx2_error_wrapped_in_a_task_group_is_unwrapped() -> None:
    """The streamable-HTTP client runs in an anyio task group, so the real error arrives grouped."""
    grouped = BaseExceptionGroup("tg", [httpx2.ConnectError("nope")])
    assert mcp_tools._is_transient_exc(grouped)


def test_a_non_transport_error_is_still_NOT_transient() -> None:
    """A bug must keep propagating rather than being retried into silence."""
    assert not mcp_tools._is_transient_exc(ValueError("a real bug"))
