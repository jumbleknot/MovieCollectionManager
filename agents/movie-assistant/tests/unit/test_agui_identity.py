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


# ── 079 / item #641: the seam moved INWARD, and a guard on the way OUT ─────────────────────────
#
# ag-ui-langgraph 0.0.46 added its own `except Exception` inside `LangGraphAgent.run()` that yields
# `RUN_ERROR(message=str(exc))`. It sits inside the `run()` this module overrides, so the override
# above never saw the exception again. The conversion now happens one level in, in
# `_handle_stream_events` (which the runtime still lets raise), and `run()` rewrites any RUN_ERROR
# it did not build.

LEAKED = "rejected: add Nosferatu to my Horror collection"


def _provider_400() -> Exception:
    import anthropic
    import httpx

    body = {"type": "error", "error": {"type": "invalid_request_error", "message": LEAKED}}
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.BadRequestError(
        LEAKED, response=httpx.Response(400, request=request, json=body), body=body
    )


def _bare_agent():
    import src.agui_identity as agui_identity

    return agui_identity.IdentityAwareAGUIAgent.__new__(agui_identity.IdentityAwareAGUIAgent)


def _patch_stream(monkeypatch: pytest.MonkeyPatch, stream_body) -> None:
    """Replace the BASE `_handle_stream_events`, so the override is what runs over it."""
    import src.agui_identity as agui_identity

    monkeypatch.setattr(agui_identity.LangGraphAGUIAgent, "_handle_stream_events", stream_body)


def _input():
    from types import SimpleNamespace

    return SimpleNamespace(thread_id="t-1", run_id="r-1")


async def _drain_stream(agent) -> list:
    return [event async for event in agent._handle_stream_events(_input())]


async def test_a_foreign_run_error_is_rewritten_on_the_way_out() -> None:
    """079 FR-003 — a RUN_ERROR this repository did not build (0.0.46's `str(exc)` one, or an
    upstream `error` event's) leaves with a fixed message and no raw event."""
    from ag_ui.core import EventType, RunErrorEvent

    async def foreign(self, input):  # noqa: A002, ARG001
        yield RunErrorEvent(
            type=EventType.RUN_ERROR, message=LEAKED, raw_event={"data": {"message": LEAKED}}
        )

    agent, base, original = _agent_over(foreign)
    try:
        events = await _drain(agent)
    finally:
        base.run = original

    assert len(events) == 1
    assert events[0].type == EventType.RUN_ERROR
    assert events[0].message == "agent run failed: upstream error"
    assert events[0].raw_event is None
    assert "Nosferatu" not in events[0].model_dump_json()


async def test_a_stream_failure_before_the_run_started_yields_started_then_the_facts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """079 FR-001/FR-002/FR-005 — converted INSIDE the runtime's handler, so the facts survive, and
    the protocol's started-before-terminal order is kept."""
    from ag_ui.core import EventType

    async def failing(self, input):  # noqa: A002, ARG001
        raise _provider_400()
        yield  # pragma: no cover - makes this an async generator

    _patch_stream(monkeypatch, failing)
    events = await _drain_stream(_bare_agent())

    assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert (events[0].thread_id, events[0].run_id) == ("t-1", "r-1")
    assert "status=400" in events[1].message
    assert "type=invalid_request_error" in events[1].message
    assert "exc=BadRequestError" in events[1].message
    assert "Nosferatu" not in events[1].message
    assert events[1].code == "provider_http"


async def test_a_stream_failure_after_the_run_started_emits_no_second_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ag_ui.core import EventType, RunStartedEvent

    async def failing(self, input):  # noqa: A002, ARG001
        yield RunStartedEvent(type=EventType.RUN_STARTED, thread_id="t-1", run_id="r-1")
        raise ValueError("a bug of ours")

    _patch_stream(monkeypatch, failing)
    events = await _drain_stream(_bare_agent())

    assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert events[1].code == "unexpected"
    assert events[1].message == "agent run failed: ValueError"


async def test_a_stream_failure_after_a_terminal_is_not_given_a_second_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """079 FR-005 — clients reject every event after a terminal; the runtime's rule is to raise."""
    from ag_ui.core import EventType, RunFinishedEvent, RunStartedEvent

    async def failing(self, input):  # noqa: A002, ARG001
        yield RunStartedEvent(type=EventType.RUN_STARTED, thread_id="t-1", run_id="r-1")
        yield RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="t-1", run_id="r-1")
        raise ValueError("after the end")

    _patch_stream(monkeypatch, failing)
    seen: list = []
    with pytest.raises(ValueError):
        async for event in _bare_agent()._handle_stream_events(_input()):
            seen.append(event)
    assert [e.type for e in seen] == [EventType.RUN_STARTED, EventType.RUN_FINISHED]


async def test_a_cancelled_stream_is_not_converted(monkeypatch: pytest.MonkeyPatch) -> None:
    """079 FR-006 — the same rule as the `run()` override, at the new seam."""
    import asyncio

    async def cancelled(self, input):  # noqa: A002, ARG001
        raise asyncio.CancelledError()
        yield  # pragma: no cover - makes this an async generator

    _patch_stream(monkeypatch, cancelled)
    with pytest.raises(asyncio.CancelledError):
        await _drain_stream(_bare_agent())


async def test_run_adds_no_second_terminal_after_one_was_sent() -> None:
    """079 FR-005 at the OUTER seam — `_handle_stream_events` re-raises after a terminal, and the
    runtime lets that escape `run()`; this `except` must not answer it with a second terminal."""
    from ag_ui.core import EventType, RunFinishedEvent

    async def late_failure(self, input):  # noqa: A002, ARG001
        yield RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="t-1", run_id="r-1")
        raise ValueError("after the end")

    agent, base, original = _agent_over(late_failure)
    seen: list = []
    try:
        with pytest.raises(ValueError):
            async for event in agent.run(None):
                seen.append(event)
    finally:
        base.run = original
    assert [e.type for e in seen] == [EventType.RUN_FINISHED]
