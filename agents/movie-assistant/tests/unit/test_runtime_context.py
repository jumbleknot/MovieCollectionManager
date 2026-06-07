"""Unit tests for the per-request subject-token capture (T024 piece 3).

The BFF sends the run-scoped subject token as `Authorization: Bearer <token>` on each AG-UI
request. The gateway captures it into a ContextVar for the request's duration so the (US1)
MCP-client tool path can read it at tool-call time via `get_subject_token()`. It is NEVER
written to GraphState / the checkpoint (SC-004) — a ContextVar is process-/request-local,
not graph state.

Capture uses a PURE ASGI middleware (not Starlette BaseHTTPMiddleware, whose separate task
breaks ContextVar propagation to the endpoint). These tests cover bearer extraction, the
default-empty context, and that the middleware sets the token for the handler and resets it
after the response so it never leaks across requests.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.runtime_context import (
    SubjectTokenMiddleware,
    extract_bearer,
    get_subject_token,
)


def test_extract_bearer_parses_bearer_scheme() -> None:
    assert extract_bearer("Bearer abc.def.ghi") == "abc.def.ghi"


def test_extract_bearer_returns_none_for_missing_or_wrong_scheme() -> None:
    assert extract_bearer(None) is None
    assert extract_bearer("") is None
    assert extract_bearer("Basic Zm9v") is None
    assert extract_bearer("bearer-no-space") is None


def test_get_subject_token_defaults_to_none_outside_a_request() -> None:
    assert get_subject_token() is None


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(SubjectTokenMiddleware)

    @app.get("/seen")
    def seen() -> dict[str, str | None]:
        # Runs inside the request — the captured token must be visible here.
        return {"token": get_subject_token()}

    return app


def test_middleware_captures_bearer_for_the_handler() -> None:
    client = TestClient(_app())
    resp = client.get("/seen", headers={"Authorization": "Bearer subject-xyz"})
    assert resp.json() == {"token": "subject-xyz"}


def test_middleware_resets_token_after_request_no_cross_request_leak() -> None:
    client = TestClient(_app())
    # First request carries a token; second carries none — must not see the first's token.
    client.get("/seen", headers={"Authorization": "Bearer first-tok"})
    resp = client.get("/seen")
    assert resp.json() == {"token": None}
    # And outside any request, the context is clean.
    assert get_subject_token() is None
