"""Subject-token bridge helpers (gateway cut-over, US1 Slice G).

`inject_subject_identity` is the ContextVar→`config["configurable"]` bridge the gateway applies
per request (in the request task, where the captured token is reliably in-context) so the graph
nodes receive the run-scoped subject token + user_id task-safely — never checkpointed (SC-004).
These pure helpers are unit-tested here; the live ASGI bridge is exercised by the gateway
integration test.
"""

from __future__ import annotations

import base64
import json

import pytest

from src.agui_identity import (
    inject_import_file,
    inject_subject_identity,
    inject_ui_snapshot,
    subject_user_id,
)


def _jwt(claims: dict[str, object]) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"header.{payload}.signature"


def test_subject_user_id_decodes_the_sub_claim() -> None:
    assert subject_user_id(_jwt({"sub": "user-42", "aud": "mc-service"})) == "user-42"


def test_subject_user_id_is_empty_on_a_non_jwt() -> None:
    assert subject_user_id("not-a-jwt") == ""
    assert subject_user_id("") == ""


def test_inject_sets_subject_token_and_user_id() -> None:
    token = _jwt({"sub": "user-7"})
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_subject_identity(config, token)
    configurable = config["configurable"]
    assert isinstance(configurable, dict)
    assert configurable["subject_token"] == token
    assert configurable["user_id"] == "user-7"
    assert configurable["thread_id"] == "t1"  # preserves existing keys


def test_inject_creates_configurable_when_absent() -> None:
    token = _jwt({"sub": "u"})
    config: dict[str, object] = {}
    inject_subject_identity(config, token)
    assert config["configurable"]["subject_token"] == token  # type: ignore[index]


def test_inject_is_a_noop_without_a_token() -> None:
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_subject_identity(config, None)
    assert "subject_token" not in config["configurable"]  # type: ignore[operator]
    inject_subject_identity(config, "")
    assert "subject_token" not in config["configurable"]  # type: ignore[operator]


# ── US3 (R15): UI-snapshot bridge into config["configurable"] ────────────────────────────────


def test_inject_ui_snapshot_sets_snapshot() -> None:
    snapshot = {"current_screen": "collection", "collection_id": "abc"}
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_ui_snapshot(config, snapshot)
    configurable = config["configurable"]
    assert isinstance(configurable, dict)
    assert configurable["ui_snapshot"] == snapshot
    assert configurable["thread_id"] == "t1"  # preserves existing keys


def test_inject_ui_snapshot_creates_configurable_when_absent() -> None:
    config: dict[str, object] = {}
    inject_ui_snapshot(config, {"current_screen": "home"})
    assert config["configurable"]["ui_snapshot"] == {"current_screen": "home"}  # type: ignore[index]


def test_inject_ui_snapshot_is_a_noop_without_a_snapshot() -> None:
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_ui_snapshot(config, None)
    assert "ui_snapshot" not in config["configurable"]  # type: ignore[operator]


# ── 014 US2: import-file bridge into config["configurable"] ───────────────────────────────────


def test_inject_import_file_sets_handle_and_filename() -> None:
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_import_file(config, {"handle": "h-abc", "filename": "movies.xlsx"})
    configurable = config["configurable"]
    assert isinstance(configurable, dict)
    assert configurable["file_handle"] == "h-abc"
    assert configurable["filename"] == "movies.xlsx"
    assert configurable["thread_id"] == "t1"  # preserves existing keys


def test_inject_import_file_noop_without_reference() -> None:
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_import_file(config, None)
    assert "file_handle" not in config["configurable"]  # type: ignore[operator]


def test_inject_import_file_noop_when_handle_blank() -> None:
    config: dict[str, object] = {"configurable": {}}
    inject_import_file(config, {"handle": "  ", "filename": "x.csv"})
    assert "file_handle" not in config["configurable"]  # type: ignore[operator]


# ── 065 / item #325: the terminal-error override, at the unit level ────────────────────────────
#
# The end-to-end guarantee (a caller gets RUN_ERROR and the stream closes) is pinned over real HTTP
# in tests/integration/test_gateway_provider_error.py. What is pinned HERE is the one property that
# test cannot show: that a CANCELLED run is not converted, because yielding into a cancelled
# generator raises `RuntimeError: async generator ignored GeneratorExit` — a new failure mode
# introduced by the fix for the old one.


async def _drain(agent, input_obj=None) -> list:
    return [event async for event in agent.run(input_obj)]


def _agent_over(stream_body):
    """An IdentityAwareAGUIAgent whose `super().run()` is replaced by `stream_body`.

    Patching the BASE class's `run` is what puts the override under test rather than around it.
    """
    import src.agui_identity as agui_identity

    class _Stub(agui_identity.IdentityAwareAGUIAgent):
        pass

    agent = _Stub.__new__(_Stub)  # no LangGraphAGUIAgent construction — the override is the SUT
    base = agui_identity.LangGraphAGUIAgent
    original = base.run
    base.run = stream_body
    return agent, base, original


async def test_a_cancelled_run_is_not_converted_into_a_run_error() -> None:
    """FR-008. `except Exception` deliberately excludes `CancelledError`/`GeneratorExit`."""
    import asyncio

    async def cancelled(self, input):  # noqa: A002, ARG001
        raise asyncio.CancelledError()
        yield  # pragma: no cover - makes this an async generator

    agent, base, original = _agent_over(cancelled)
    try:
        with pytest.raises(asyncio.CancelledError):
            await _drain(agent)
    finally:
        base.run = original


async def test_a_provider_failure_is_converted_into_exactly_one_terminal_run_error() -> None:
    """FR-006/FR-010 — one terminal event, carrying the provider facts and no member text."""
    import anthropic
    import httpx
    from ag_ui.core import EventType

    leaked = "rejected: add Nosferatu to my Horror collection"

    async def failing(self, input):  # noqa: A002, ARG001
        body = {"type": "error", "error": {"type": "invalid_request_error", "message": leaked}}
        request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
        raise anthropic.BadRequestError(
            leaked, response=httpx.Response(400, request=request, json=body), body=body
        )
        yield  # pragma: no cover - makes this an async generator

    agent, base, original = _agent_over(failing)
    try:
        events = await _drain(agent)
    finally:
        base.run = original

    assert len(events) == 1
    assert events[0].type == EventType.RUN_ERROR
    assert "400" in events[0].message
    assert "invalid_request_error" in events[0].message
    assert "Nosferatu" not in events[0].message
    assert "Horror" not in events[0].message


async def test_events_already_streamed_before_the_failure_are_preserved() -> None:
    """The terminal event is APPENDED — a partial reply the member already saw is not discarded."""
    from ag_ui.core import EventType

    async def partial(self, input):  # noqa: A002, ARG001
        yield "first"
        yield "second"
        raise ValueError("boom")

    agent, base, original = _agent_over(partial)
    try:
        events = await _drain(agent)
    finally:
        base.run = original

    assert events[:2] == ["first", "second"]
    assert events[2].type == EventType.RUN_ERROR
    # FR-003 — a bug of ours is not dressed up as a provider status.
    assert events[2].code == "unexpected"
