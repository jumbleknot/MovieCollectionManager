"""Graph-level add flow: route → enrich → propose → interrupt → resume → apply (US1).

Exercises the COMPILED graph with the REAL curator/organizer/approval_gate nodes wired
together, using STUB tool closures + an in-process MemorySaver — so the full HITL path
(including LangGraph `interrupt()`/resume) is deterministic without Keycloak/MCP/mc-service.
The live tool path is T036 (integration). The production graph stays tool-free until the
agent layer is deployed (defaults unchanged → SC-005 regression unaffected).
"""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.nodes.approval_gate import ExecOutcome
from src.nodes.curator import build_curator
from src.nodes.organizer import build_organizer

_DETAILS = {
    "source": "tmdb", "sourceId": "tmdb:603", "title": "The Matrix", "year": 1999,
    "overview": "x", "genres": ["Science Fiction"], "posterUrl": "http://x", "language": "English",
}


async def _search_exact(_q: str, _y: int | None) -> dict[str, Any]:
    return {"matchConfidence": "exact", "results": [{"sourceId": "tmdb:603"}]}


async def _details(_sid: str) -> dict[str, Any]:
    return _DETAILS


async def _list_existing() -> list[dict[str, Any]]:
    return [{"collectionId": "0123456789abcdef01234567", "name": "Sci-Fi", "movieCount": 0}]


def _build(execute_calls: list[Any]) -> Any:
    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        execute_calls.append((str(operation), args, key))
        return ExecOutcome(status="applied", data={"movieId": "m1"})

    return build_graph(
        classifier=lambda _m: "add",
        curator=build_curator(
            extract=lambda _m: {"title": "The Matrix", "year": 1999, "collection": "Sci-Fi"},
            search=_search_exact, details=_details,
        ),
        organizer=build_organizer(list_collections=_list_existing, gen_id=lambda: "p1"),
        approval_gate=build_approval_gate_for(execute),
        checkpointer=MemorySaver(),
    )


def build_approval_gate_for(execute: Any) -> Any:
    from src.nodes.approval_gate import build_approval_gate

    return build_approval_gate(execute=execute)


def _config(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread}}



# 047 US4 extended the single ownership question into a chain (ownership → media formats →
# ripped → rip qualities), so a test that just wants to reach the approval gate must walk
# whatever stages the flow asks for rather than assuming a fixed number of turns.
_CHAIN_ANSWERS = {
    # 059 US2 put this question at the FRONT of the chain. Answered neutrally here so a test
    # about the approval gate or idempotency is not also asserting a children's answer — the
    # question itself is covered by tests/unit/test_organizer_add_chain.py.
    "awaiting_childrens": "no",
    "awaiting_media": "Selected: none",
    "awaiting_ripped": "no",
    "awaiting_rip_quality": "Selected: none",
}


async def _add_and_answer_ownership(graph: Any, cfg: dict[str, Any], answer: str = "yes") -> Any:
    """Drive the add flow through the whole ownership chain to the approval interrupt.

    040 US4 introduced "Do you own this?" before the gate; 047 US4 extended it into a chain;
    059 US2 added a question ahead of all of them. Turn 1 asks; each following turn answers
    whatever stage the flow is on. Returns the final turn.

    `answer` is the OWNERSHIP answer specifically — the callers pass "yes"/"no" meaning owned or
    not. It is matched to its stage by name rather than by turn number, so the extra question
    059 inserted shifts the sequence without silently redirecting every caller's answer to a
    different question.
    """
    result = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    assert "__interrupt__" not in result  # paused for a chain question, not the approval gate
    for _ in range(6):  # bounded: a stage that never advances fails loudly, not by hanging
        stage = str(result.get("add_stage") or "")
        if stage == "awaiting_ownership":
            reply = answer
        elif stage in _CHAIN_ANSWERS:
            reply = _CHAIN_ANSWERS[stage]
        else:
            return result
        result = await graph.ainvoke({"messages": [("user", reply)]}, cfg)
    return result


async def test_add_flow_pauses_at_approval_with_a_proposal() -> None:
    graph = _build([])
    result = await _add_and_answer_ownership(graph, _config("add-1"))
    assert "__interrupt__" in result  # paused at the approval gate after the ownership answer
    payload = result["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    assert payload["proposalId"] == "p1"


async def test_add_flow_applies_once_on_approval() -> None:
    calls: list[Any] = []
    graph = _build(calls)
    cfg = _config("add-approve")
    await _add_and_answer_ownership(graph, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)

    assert final["status"] == "completed"
    add_calls = [c for c in calls if c[0] == "add"]
    assert len(add_calls) == 1  # exactly one add executed (SC-006)
    assert add_calls[0][1]["collectionId"] == "0123456789abcdef01234567"
    # 040 US4: after the add, the gate opens the new movie's detail screen.
    nav = [
        c
        for m in final["messages"]
        for c in (getattr(m, "tool_calls", None) or [])
        if c["name"] == "navigate_to_movie"
    ]
    assert len(nav) == 1
    assert nav[0]["args"] == {"collectionId": "0123456789abcdef01234567", "movieId": "m1"}


async def test_add_flow_writes_nothing_on_rejection() -> None:
    calls: list[Any] = []
    graph = _build(calls)
    cfg = _config("add-reject")
    await _add_and_answer_ownership(graph, cfg)
    final = await graph.ainvoke(Command(resume={"decision": "rejected"}), cfg)

    assert final["status"] == "completed"
    assert calls == []  # zero writes when rejected (FR-007)


# ── 047 US4: an ANSWER to a pending ownership question is never a new command ────────────────
#
# The stage guard escaped the add flow whenever the classifier returned a domain intent. That is
# right for a genuinely new command, but a multi-select CONFIRM is not one — it is the answer to
# the question the assistant just asked.
#
# 040's single question was safe by luck: "yes"/"no" reliably classify as out_of_domain. 047's
# replies are prose-like ("Selected: none", "Selected: DVD, Blu-Ray") and a model can read them as
# `query` or `search` — at which point the member's in-progress add is silently discarded and the
# movie they were adding is never created. Found in CI, where the Anthropic classifier reads them
# differently from the local Ollama one.


_HOSTILE_LABELS = ["query", "search", "organize", "navigate", "enrich", "import", "export"]


def _build_with_classifier(classifier: Any) -> Any:
    """The add-flow graph with an INJECTABLE classifier, so a turn can be misclassified on cue.

    `get_movie_metadata` is wired so the chain reaches the media-format question; the values are
    the ones mc-service publishes.
    """

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        return ExecOutcome(status="applied", data={"movieId": "m1"})

    async def metadata() -> dict[str, Any]:
        return {"mediaFormats": ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"]}

    return build_graph(
        classifier=classifier,
        curator=build_curator(
            extract=lambda _m: {"title": "The Matrix", "year": 1999, "collection": "Sci-Fi"},
            search=_search_exact, details=_details,
        ),
        organizer=build_organizer(
            list_collections=_list_existing, gen_id=lambda: "p1", get_movie_metadata=metadata
        ),
        approval_gate=build_approval_gate_for(execute),
        checkpointer=MemorySaver(),
    )


@pytest.mark.parametrize("hostile", _HOSTILE_LABELS)
async def test_multi_select_answer_survives_a_hostile_classification(hostile: str) -> None:
    """A confirm reply reaches the organizer even when classified as a different intent."""
    label = {"v": "add"}
    graph = _build_with_classifier(lambda _m: label["v"])
    cfg = _config(f"hostile-{hostile}")

    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    # 059 US2 inserted the children's question ahead of ownership, so reaching the multi-select
    # takes one more turn. The extra turn is added rather than the target stage relaxed — this
    # test is specifically about what happens AT the multi-select confirm.
    await graph.ainvoke({"messages": [("user", "no")]}, cfg)           # → awaiting_ownership
    await graph.ainvoke({"messages": [("user", "yes")]}, cfg)          # → awaiting_media

    # Only the multi-select CONFIRM is misclassified — the exact CI failure shape.
    label["v"] = hostile
    result = await graph.ainvoke({"messages": [("user", "Selected: none")]}, cfg)

    assert str(result.get("add_stage") or "") != "", (
        f"a confirm classified as {hostile!r} abandoned the add — the member's movie is lost"
    )


@pytest.mark.parametrize("hostile", _HOSTILE_LABELS)
async def test_ownership_yes_no_survives_a_hostile_classification(hostile: str) -> None:
    """The same guarantee for the Yes/No questions, which 040 left to luck."""
    label = {"v": "add"}
    graph = _build_with_classifier(lambda _m: label["v"])
    cfg = _config(f"hostile-yn-{hostile}")

    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    label["v"] = hostile
    # 059 US2 added a second Yes/No question, at the FRONT of the chain — so it is now the first
    # thing a hostile classifier sees. Both answers are asserted: an add abandoned at the new
    # question is lost just as completely as one abandoned at the ownership question.
    after_childrens = await graph.ainvoke({"messages": [("user", "no")]}, cfg)
    assert str(after_childrens.get("add_stage") or "") != "", (
        f"a children's answer classified as {hostile!r} abandoned the add"
    )
    result = await graph.ainvoke({"messages": [("user", "yes")]}, cfg)

    assert str(result.get("add_stage") or "") != "", (
        f"an ownership answer classified as {hostile!r} abandoned the add"
    )


async def test_a_genuinely_new_command_still_escapes_the_ownership_chain() -> None:
    """The escape must survive: a real new command still abandons the pending add (US4-AC7).

    This is the other half — a fix that kept EVERYTHING in the add flow would trap the member.
    """
    label = {"v": "add"}
    graph = _build_with_classifier(lambda _m: label["v"])
    cfg = _config("hostile-escape")

    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        cfg,
    )
    await graph.ainvoke({"messages": [("user", "no")]}, cfg)   # 059 US2: the children's question
    await graph.ainvoke({"messages": [("user", "yes")]}, cfg)

    label["v"] = "query"
    result = await graph.ainvoke({"messages": [("user", "how many movies do I have")]}, cfg)

    assert str(result.get("add_stage") or "") == "", "a new command must abandon the pending add"
