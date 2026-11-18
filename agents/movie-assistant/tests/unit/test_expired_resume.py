"""A resume of a thread with no checkpoint ends as `conversation_expired` (spec 102 US2-AC3).

A thread's checkpoint is gone once the bounded saver evicts it (item #974) or the gateway restarts.
Before this, a HITL resume of such a thread ran a `Command(resume=…)` against an empty thread, a
silent fresh run. Now `IdentityAwareAGUIAgent.prepare_stream` answers it with `RUN_STARTED` and a
sanitised terminal `RUN_ERROR` whose code the client can act on.

Driven through the REAL agent (`run()` → the runtime's `_handle_stream_events` → our
`prepare_stream`) over a real compiled graph and checkpointer. The two controls (a live interrupted
thread resumes, and a plain first turn on a new thread runs) guard against the branch over-reaching.
"""

from __future__ import annotations

import json
from typing import Any, TypedDict

from ag_ui.core import EventType, ResumeEntry, RunAgentInput, UserMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from src.agui_identity import CONVERSATION_EXPIRED, IdentityAwareAGUIAgent
from src.checkpoint_retention import BoundedInMemorySaver


class _S(TypedDict, total=False):
    messages: list[Any]
    decision: str


def _agent() -> tuple[IdentityAwareAGUIAgent, list[str]]:
    ran: list[str] = []

    def gate(_state: _S) -> dict[str, str]:
        ran.append("gate")
        answer = interrupt({"type": "approval_request", "proposalId": "p1"})
        ran.append(f"resumed:{answer}")
        return {"decision": str(answer)}

    g = StateGraph(_S)
    g.add_node("gate", gate)
    g.add_edge(START, "gate")
    g.add_edge("gate", END)
    graph = g.compile(checkpointer=BoundedInMemorySaver())
    return IdentityAwareAGUIAgent(name="movie_assistant", graph=graph), ran


def _input(thread: str, *, legacy_resume: Any = None, resume: Any = None) -> RunAgentInput:
    forwarded: dict[str, Any] = {}
    if legacy_resume is not None:
        forwarded = {"command": {"resume": legacy_resume}}
    return RunAgentInput(
        thread_id=thread,
        run_id=f"run-{thread}-{len(json.dumps(forwarded))}",
        state={},
        messages=[UserMessage(id="m1", role="user", content="add The Matrix")],
        tools=[],
        context=[],
        forwarded_props=forwarded,
        resume=resume,
    )


async def _events(agent: IdentityAwareAGUIAgent, run_input: RunAgentInput) -> list[Any]:
    return [e async for e in agent.clone().run(run_input)]


def _expired(events: list[Any]) -> bool:
    errors = [e for e in events if getattr(e, "type", None) == EventType.RUN_ERROR]
    return len(errors) == 1 and errors[0].code == CONVERSATION_EXPIRED


async def test_a_legacy_resume_of_an_unknown_thread_is_conversation_expired() -> None:
    agent, ran = _agent()
    events = await _events(agent, _input("gone", legacy_resume=json.dumps({"decision": "ok"})))

    assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert _expired(events)
    assert ran == []  # the graph never ran: no silent fresh thread


async def test_a_standard_resume_of_an_unknown_thread_is_conversation_expired() -> None:
    agent, ran = _agent()
    entry = ResumeEntry(interrupt_id="i1", status="resolved", payload={"decision": "ok"})
    events = await _events(agent, _input("gone-std", resume=[entry]))

    assert _expired(events)
    assert ran == []


async def test_control_a_live_interrupted_thread_still_resumes() -> None:
    agent, ran = _agent()
    await _events(agent, _input("live"))
    assert ran == ["gate"]  # paused at the interrupt

    events = await _events(agent, _input("live", legacy_resume=json.dumps("approved")))
    assert not _expired(events)
    assert ran[-1] == "resumed:approved"


async def test_control_a_first_turn_on_a_new_thread_still_runs() -> None:
    agent, ran = _agent()
    events = await _events(agent, _input("fresh"))
    assert not _expired(events)
    assert ran == ["gate"]
