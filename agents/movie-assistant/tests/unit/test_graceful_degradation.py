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


# ── 047 US4 (T078, FR-028): a metadata failure SKIPS the question, never guesses ─────────────
#
# The whole point of RQ-4 is that the agent does not own the accepted media formats. So when
# the read fails, the only acceptable degradation is to skip the format question and complete
# the add with none recorded — a fallback list would put domain values back in the agent while
# looking like resilience, and would silently offer a member values mc-service might reject.


_DEGRADE_COLL = [{"collectionId": "c-fav", "name": "Favourites", "isDefault": True}]


def _degrade_candidate() -> dict[str, Any]:
    return {
        "sourceId": "tmdb:603",
        "title": "The Matrix",
        "year": 1999,
        "overview": "",
        "genres": [],
        "posterUrl": None,
    }


def _degrade_organizer(metadata):
    from src.nodes.organizer import build_organizer

    async def list_collections() -> list[dict[str, Any]]:
        return _DEGRADE_COLL

    return build_organizer(
        list_collections=list_collections,
        gen_id=lambda: "p-degrade",
        get_movie_metadata=metadata,
    )


def _degrade_state(text: str, **extra: Any) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage

    state: dict[str, Any] = {
        "intent": "add",
        "candidate": _degrade_candidate(),
        "target_collection_name": "Favourites",
        "thread_id": "t-degrade",
        "add_stage": "awaiting_ownership",
        "add_target": {"collection_id": "c-fav", "name": "Favourites", "create_if_missing": False},
        "messages": [HumanMessage(content=text)],
    }
    state.update(extra)
    return state


async def _metadata_raises() -> dict[str, Any] | None:
    raise RuntimeError("movie-mcp unreachable")


async def _metadata_returns_none() -> dict[str, Any] | None:
    return None


async def _metadata_returns_empty() -> dict[str, Any] | None:
    return {"mediaFormats": []}


@pytest.mark.parametrize(
    "metadata",
    [_metadata_raises, _metadata_returns_none, _metadata_returns_empty, None],
    ids=["raises", "returns-none", "returns-empty", "not-wired"],
)
async def test_metadata_unavailable_skips_the_format_question(metadata) -> None:
    """Every failure shape skips straight to the ripped question — no format multi-select."""
    node = _degrade_organizer(metadata)
    out = await node(_degrade_state("yes"))

    assert out["add_stage"] == "awaiting_ripped", "the format question was not skipped"
    tool_names = {
        c["name"] for m in out["messages"] for c in (getattr(m, "tool_calls", None) or [])
    }
    assert "render_multi_select" not in tool_names, "a format list was offered despite the failure"
    assert out["add_owned_media"] == []


async def test_metadata_unavailable_never_offers_a_guessed_list() -> None:
    """The specific failure this guards: a hardcoded fallback set of formats.

    If a fallback list is ever added, the multi-select reappears here — which is precisely the
    regression RQ-4 exists to prevent.
    """
    node = _degrade_organizer(_metadata_raises)
    out = await node(_degrade_state("yes"))

    rendered = " ".join(str(m.content) for m in out["messages"])
    for guessed in ("DVD", "Blu-Ray", "UHD"):
        assert guessed not in rendered, f"a guessed domain value {guessed!r} was offered"


async def test_metadata_unavailable_still_completes_the_add_as_owned() -> None:
    """FR-028: the add completes as owned with no formats — it is not abandoned."""
    node = _degrade_organizer(_metadata_raises)
    asked_ripped = await node(_degrade_state("yes"))
    out = await node(
        _degrade_state("no", add_stage="awaiting_ripped",
                       add_owned_media=asked_ripped["add_owned_media"])
    )

    proposal = out["pending_proposal"]
    assert proposal is not None, "the add must still complete"
    item = next(i for i in proposal.items if i.operation.value == "add")
    assert item.owned is True
    assert item.owned_media == []
    assert item.rip_quality == []


GENERIC_REPLY = "Sorry — I couldn't complete that just now. Please try again."


# ── FR-039 / 047 T001: what the degrade path is, and what it is NOT ──────────────────────────────
#
# RQ-1 established that the generic reply on a `navigate` turn can only come from `_degrade_node`,
# reachable only through the SUPERVISOR's model call. These two pin the boundary that makes that
# true, because both were assumed rather than asserted — and the assumption sent the RQ-1
# hypothesis list toward pagination and the circuit breaker, neither of which can cause it.


async def test_a_tool_call_limiter_breach_never_produces_the_generic_degrade_reply() -> None:
    """A read that ran out of tool-call budget is a READ failure, not a model failure.

    Collapsing the two is what made the member's report unattributable: the same sentence meant
    "the provider is down" and "your library is too big to page through".
    """
    from src.nodes.navigator import build_navigator
    from src.tools.agent_rate_limit import AgentRateLimitExceeded, AgentToolRateLimiter
    from src.tools.mcp_tools import ToolOutcome, ToolReadError, read_or_raise

    limiter = AgentToolRateLimiter(max_calls=1, window_seconds=60)
    limiter.check("navigator", "u")  # spend the only call

    async def list_collections() -> list[dict[str, Any]]:
        try:
            limiter.check("navigator", "u")
        except AgentRateLimitExceeded:
            return list(read_or_raise(ToolOutcome(ok=False, error="busy"), list))
        return []

    graph = build_graph(
        classifier=lambda _m: "navigate",
        navigator=build_navigator(list_collections=list_collections),
        checkpointer=MemorySaver(),
    )

    with pytest.raises(ToolReadError) as caught:
        await graph.ainvoke({"messages": [("user", "open my Sci-Fi collection")]}, _cfg("lim"))

    # The two failures are now DISTINGUISHABLE — which is the whole point. Before FR-039 a
    # budget-exhausted read was swallowed into `[]` and the member was asked which collection
    # they meant, offering none.
    assert caught.value.user_message != GENERIC_REPLY
    assert caught.value.user_message == "busy"


async def test_a_node_level_failure_never_opens_the_error_rate_breaker() -> None:
    """`circuit.record` is called in ONE place — the supervisor, on the classifier's outcome.

    So an open breaker always means the supervisor's model call is failing, never "the stack is
    under strain". RQ-1's H1 rationale ("if large-library turns are failing often enough") is
    mechanically impossible, and this is the assertion that keeps it so.
    """
    from langchain_core.messages import AIMessage

    from src.circuit_breaker import ErrorRateBreaker

    circuit = ErrorRateBreaker(threshold=0.5, window=20, cooldown_s=30, min_samples=5)

    def failing_specialist(_state: dict[str, Any]) -> dict[str, Any]:
        return {"messages": [AIMessage(content=GENERIC_REPLY)]}

    graph = build_graph(
        classifier=lambda _m: "query",
        query=failing_specialist,
        circuit=circuit,
        checkpointer=MemorySaver(),
    )
    for i in range(20):
        await graph.ainvoke({"messages": [("user", "how many movies")]}, _cfg(f"brk-{i}"))

    assert circuit.state == "closed"
