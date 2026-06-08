"""Graceful degradation (T061 / FR-018) + kill switch (T061 / FR-019 / SC-009).

FR-018: on a reasoning / lookup / provider failure the assistant degrades to a clear "couldn't
complete" reply and NEVER performs a silent or unauthorized action. FR-019/SC-009: the assistant
is independently disableable (kill switch) with no impact on existing app functionality.

Covered here:
- the kill-switch predicate + the supervisor short-circuit (zero classify / zero side effects);
- a provider/reasoning failure in the supervisor classifier → the `degrade` node;
- a failure in the specialist model calls (curator extract / organizer plan) → "couldn't
  complete", no candidate / no proposal.

The TOOL-failure half of FR-018 (a write tool exhausting retries → dead-letter → "couldn't
complete") is implemented + tested in T024a (`tests/unit/test_mcp_invoke.py`). The "no impact on
existing app" half of SC-009 is proven by the SC-005 additive-only E2E regression.
"""

from __future__ import annotations

from typing import Any

import pytest
from langgraph.checkpoint.memory import MemorySaver

from src.graph import build_graph
from src.kill_switch import assistant_disabled
from src.nodes.curator import build_curator
from src.nodes.organizer import build_organizer


def _cfg(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread}}


# ── kill-switch predicate ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", ["1", "true", "True", "yes", "on", "disabled", "DISABLED"])
def test_assistant_disabled_truthy_values(value: str) -> None:
    assert assistant_disabled({"AGENT_KILL_SWITCH": value}) is True


@pytest.mark.parametrize(
    "env",
    [{}, {"AGENT_KILL_SWITCH": ""}, {"AGENT_KILL_SWITCH": "false"}, {"AGENT_KILL_SWITCH": "0"}],
)
def test_assistant_enabled_by_default(env: dict[str, str]) -> None:
    assert assistant_disabled(env) is False


# ── kill switch in the graph ──────────────────────────────────────────────────────────────────


async def test_kill_switch_disables_assistant_with_zero_side_effects() -> None:
    called: list[int] = []

    def classifier(_messages: Any) -> str:
        called.append(1)  # must NOT run when the switch is engaged
        return "add"

    graph = build_graph(
        classifier=classifier, kill_switch=lambda: True, checkpointer=MemorySaver()
    )
    result = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")]}, _cfg("ks-disabled")
    )
    assert "unavailable" in str(result["messages"][-1].content).lower()
    assert called == []  # short-circuited before any classify / tool work
    assert result.get("pending_proposal") is None
    assert result.get("candidate") is None


async def test_kill_switch_off_routes_normally() -> None:
    called: list[int] = []

    def classifier(_messages: Any) -> str:
        called.append(1)
        return "out_of_domain"

    graph = build_graph(
        classifier=classifier, kill_switch=lambda: False, checkpointer=MemorySaver()
    )
    result = await graph.ainvoke({"messages": [("user", "what's the weather")]}, _cfg("ks-on"))
    assert called == [1]  # the assistant ran normally (classified the turn)
    assert "movie collections" in str(result["messages"][-1].content).lower()  # normal decline


# ── provider / reasoning failure → graceful "couldn't complete" (never a crash) ────────────────


async def test_classifier_provider_failure_degrades_gracefully() -> None:
    def classifier(_messages: Any) -> str:
        raise RuntimeError("provider unreachable")

    graph = build_graph(classifier=classifier, checkpointer=MemorySaver())
    result = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")]}, _cfg("deg-supervisor")
    )
    assert "couldn't complete" in str(result["messages"][-1].content).lower()
    assert result.get("pending_proposal") is None  # never a silent / partial write
    assert result.get("candidate") is None


async def test_curator_extract_failure_degrades_gracefully() -> None:
    def extract(_messages: Any) -> dict[str, Any]:
        raise RuntimeError("provider unreachable")

    async def search(_q: str, _y: int | None) -> dict[str, Any]:
        return {"matchConfidence": "exact", "results": [{"sourceId": "tmdb:603"}]}

    async def details(_sid: str) -> dict[str, Any]:
        return {}

    curator = build_curator(extract=extract, search=search, details=details)
    out = await curator({"messages": [("user", "add The Matrix")], "intent": "add"})
    assert "couldn't complete" in str(out["messages"][-1].content).lower()
    assert out.get("candidate") is None


async def test_organizer_plan_failure_degrades_gracefully() -> None:
    def plan(_messages: Any) -> dict[str, Any]:
        raise RuntimeError("provider unreachable")

    async def list_collections() -> list[dict[str, Any]]:
        return [{"collectionId": "a" * 24, "name": "Sci-Fi", "movieCount": 1}]

    async def list_movies(_cid: str) -> list[dict[str, Any]]:
        return []

    organizer = build_organizer(
        list_collections=list_collections, list_movies=list_movies, plan=plan
    )
    out = await organizer({"messages": [("user", "remove X from Sci-Fi")], "intent": "organize"})
    assert "couldn't complete" in str(out["messages"][-1].content).lower()
    assert out.get("pending_proposal") is None  # no write proposed on failure
