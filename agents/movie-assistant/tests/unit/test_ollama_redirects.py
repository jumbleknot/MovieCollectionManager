"""The gateway's Ollama client never follows a redirect (spec 097, item #964 part 1).

The Ollama base URL is user-supplied, and `assert_ollama_url_allowed` vets only the address it
names. `ollama-python` builds its httpx clients with `follow_redirects=True` (its documented
override of httpx's default), so before this a vetted server could answer `307 Location:
http://<any internal host>/...` and the gateway would make the second request to an address no
guard ever saw: a blind SSRF bounce.

These tests use two real loopback servers instead of a mocked transport, because the property is
about where a request actually LANDS. The vetted server redirects; the redirect target records
every hit and answers with a valid chat reply, so a client that followed would succeed quietly.
The assertion is the observable outcome: the target saw nothing.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from src.models import ModelSpec, _build_real_chat_model

_CHAT_REPLY = (
    json.dumps(
        {
            "model": "qwen2.5",
            "created_at": "2026-11-08T00:00:00Z",
            "message": {"role": "assistant", "content": "followed the redirect"},
            "done": True,
            "done_reason": "stop",
        }
    )
    + "\n"
).encode()


@dataclass
class _Stub:
    server: ThreadingHTTPServer
    hits: list[str] = field(default_factory=list)

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])


def _serve(make_handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture
def internal_target() -> Iterator[_Stub]:
    """The address a redirect would bounce the gateway to. Records every request it receives."""
    hits: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def _reply(self) -> None:
            hits.append(f"{self.command} {self.path}")
            length = int(self.headers.get("content-length") or 0)
            if length:
                self.rfile.read(length)
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson")
            self.send_header("content-length", str(len(_CHAT_REPLY)))
            self.end_headers()
            self.wfile.write(_CHAT_REPLY)

        do_GET = _reply
        do_POST = _reply

        def log_message(self, *_args: object) -> None:
            pass

    server = _serve(Handler)
    try:
        yield _Stub(server, hits)
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def redirecting_ollama(internal_target: _Stub) -> Iterator[_Stub]:
    """The VETTED server. Answers every request with a 307 to the internal target."""
    location = f"http://127.0.0.1:{internal_target.port}/api/chat"

    class Handler(BaseHTTPRequestHandler):
        def _redirect(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            if length:
                self.rfile.read(length)
            self.send_response(307)
            self.send_header("location", location)
            self.send_header("content-length", "0")
            self.end_headers()

        do_GET = _redirect
        do_POST = _redirect

        def log_message(self, *_args: object) -> None:
            pass

    server = _serve(Handler)
    try:
        yield _Stub(server)
    finally:
        server.shutdown()
        server.server_close()


def _model(ollama: _Stub):  # type: ignore[no-untyped-def]
    env = {
        "OLLAMA_BASE_URL": f"http://127.0.0.1:{ollama.port}",
        # Loopback is admitted only on listed ports; only the vetted server's port is listed,
        # which is the real shape of the gap: the redirect target was never checked at all.
        "AGENT_OLLAMA_LOOPBACK_PORTS": str(ollama.port),
    }
    return _build_real_chat_model(ModelSpec("ollama", "qwen2.5", 0.0), env)


def _attempt(call: Callable[[], object]) -> BaseException | None:
    """Run `call`; return what it raised, or None. Any failure is acceptable: the assertion that
    matters is where the request did NOT go, and it must run whether or not this raised."""
    try:
        call()
    except Exception as exc:  # noqa: BLE001
        return exc
    return None


def test_sync_client_does_not_follow_a_redirect(
    redirecting_ollama: _Stub, internal_target: _Stub
) -> None:
    model = _model(redirecting_ollama)
    outcome = _attempt(lambda: model.invoke("hello"))
    assert internal_target.hits == [], "the gateway followed a redirect to an unvetted address"
    assert outcome is not None, "a 307 must surface as a failure, not as a reply"


def test_async_client_does_not_follow_a_redirect(
    redirecting_ollama: _Stub, internal_target: _Stub
) -> None:
    model = _model(redirecting_ollama)

    async def run() -> None:
        await model.ainvoke("hello")

    outcome = _attempt(lambda: asyncio.run(run()))
    assert internal_target.hits == [], "the gateway followed a redirect to an unvetted address"
    assert outcome is not None, "a 307 must surface as a failure, not as a reply"
