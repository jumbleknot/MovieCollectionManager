"""059 US2 — "Is this a children's movie?" is the chain's FIRST question about the movie.

Before this feature `to_movie_payload` hardcoded `"childrens": False`, so every movie the
assistant added was recorded as not-a-children's-movie whether it is one or not, and the member
was never asked (backlog item #162). The answer now comes from the member.

The chain, before and after:

    before:  [collection?] → awaiting_ownership → … → proposal
    after:   [collection?] → awaiting_childrens → awaiting_ownership → … → proposal

The collection question keeps its position ahead of everything (FR-008a) — the entry point that
moves is the one reached once `add_target` is resolved.

These are UNIT tests of the stage machine: pure transitions, no LLM, no network. The
conversational surface is covered by the (non-blocking) @model-decision E2E; everything
deterministic is here, where it blocks a merge.

Verify RED:   pnpm nx run movie-assistant:test -- tests/unit/test_organizer_add_chain.py -q
Verify GREEN: same → 0 failures.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import HumanMessage

from src.nodes.organizer import build_organizer
from src.proposals import EnrichedMovieCandidate, Operation, ProposalKind

_CANDIDATE = EnrichedMovieCandidate(source_id="tmdb:603", title="The Matrix", year=1999)
_EXISTING = [{"collectionId": "0123456789abcdef01234567", "name": "Sci-Fi", "movieCount": 3}]

# Answers that advance the 047 stages without recording anything, so a test about the NEW
# question is not also asserting a particular set of formats.
_LATER_STAGE_ANSWERS = {
    "awaiting_media": "Selected: none",
    "awaiting_ripped": "no",
    "awaiting_rip_quality": "Selected: none",
}
_CARRIED_KEYS = (
    "add_target",
    "add_childrens",
    "add_owned_media",
    "add_ripped",
    "add_multi_pending",
)


def _state(target: str = "Sci-Fi") -> dict[str, Any]:
    return {
        "messages": [HumanMessage(content=f"add The Matrix to {target}")],
        "candidate": _CANDIDATE,
        "target_collection_name": target,
        "thread_id": "t1",
    }


def _organizer(collections: list[dict[str, Any]] | None = None) -> Any:
    async def list_collections() -> list[dict[str, Any]]:
        return collections if collections is not None else _EXISTING

    return build_organizer(list_collections=list_collections, gen_id=lambda: "p1")


async def _reply(
    node: Any, state: dict[str, Any], prior: dict[str, Any], text: str
) -> dict[str, Any]:
    """Answer the currently-pending question, carrying state as the checkpointer would."""
    carried = {k: prior[k] for k in _CARRIED_KEYS if k in prior}
    messages = [*state["messages"], HumanMessage(content=text)]
    return await node(
        {**state, **carried, "add_stage": str(prior.get("add_stage") or ""), "messages": messages}
    )


async def _walk_to_proposal(
    node: Any, state: dict[str, Any], *, childrens: str, owned: str
) -> dict[str, Any]:
    """Drive the whole chain to the built proposal, answering the first two questions."""
    out = await node(state)
    answers = {"awaiting_childrens": childrens, "awaiting_ownership": owned}
    # ACCUMULATED, not rebuilt each turn: a node returns a PARTIAL state update and LangGraph
    # merges it into the persisted state, so a value set at one stage is still there several
    # stages later. Rebuilding `carried` from the latest output alone would drop the children's
    # answer the moment a stage stopped re-emitting it — and would fail this test for a reason
    # that exists only in the harness.
    carried: dict[str, Any] = {}
    for _ in range(8):  # bounded: a stage that never advances fails loudly, not by hanging
        stage = str(out.get("add_stage") or "")
        if stage not in {**answers, **_LATER_STAGE_ANSWERS}:
            return out
        text = answers.get(stage) or _LATER_STAGE_ANSWERS[stage]
        state = {**state, "messages": [*state["messages"], HumanMessage(content=text)]}
        for key in _CARRIED_KEYS:
            if key in out:
                carried[key] = out[key]
        out = await node({**state, **carried, "add_stage": stage})
    raise AssertionError(f"chain did not conclude: last stage {out.get('add_stage')!r}")


# ── The new entry point ─────────────────────────────────────────────────────────────────────


async def test_the_chains_first_question_is_the_childrens_question() -> None:
    """US2-AC1: asked once, before "Do you own this?" — not after, and not instead of it."""
    out = await _organizer()(_state())

    assert out["add_stage"] == "awaiting_childrens"
    content = str(out["messages"][-1].content)
    assert "children" in content.lower()
    assert _CANDIDATE.title in content
    # Nothing is written yet, and ownership has not been asked.
    assert out["pending_proposal"] is None
    assert "Do you own" not in content


async def test_yes_advances_to_the_ownership_question() -> None:
    node = _organizer()
    first = await node(_state())
    second = await _reply(node, _state(), first, "yes")

    assert second["add_stage"] == "awaiting_ownership"
    assert "Do you own" in str(second["messages"][-1].content)
    assert second["add_childrens"] is True


async def test_no_advances_to_the_ownership_question_and_records_false() -> None:
    node = _organizer()
    first = await node(_state())
    second = await _reply(node, _state(), first, "no")

    assert second["add_stage"] == "awaiting_ownership"
    assert second["add_childrens"] is False


async def test_an_unparseable_reply_re_asks_without_advancing() -> None:
    """FR-013 / research R8: re-ask its own question rather than guessing or falling through.

    Guessing here writes a value the member never gave; falling through skips the question
    entirely. Both are silent, which is why this is asserted rather than assumed.
    """
    node = _organizer()
    first = await node(_state())
    second = await _reply(node, _state(), first, "what do you mean by that?")

    assert second["add_stage"] == "awaiting_childrens"  # unchanged
    assert "children" in str(second["messages"][-1].content).lower()
    assert second["pending_proposal"] is None


async def test_the_answer_reaches_the_proposal_item_when_owned() -> None:
    out = await _walk_to_proposal(_organizer(), _state(), childrens="yes", owned="yes")

    proposal = out["pending_proposal"]
    assert proposal.kind == ProposalKind.add_movie
    item = next(i for i in proposal.items if i.operation is Operation.add)
    assert item.childrens is True


async def test_a_not_owned_add_still_carries_the_childrens_answer() -> None:
    """US2-AC5: the "No" ownership branch short-circuits to the proposal — the earlier answer
    must survive that shortcut, not be dropped with the questions it skips."""
    out = await _walk_to_proposal(_organizer(), _state(), childrens="yes", owned="no")

    item = next(i for i in out["pending_proposal"].items if i.operation is Operation.add)
    assert item.childrens is True
    assert item.owned is False


async def test_answering_no_records_false_all_the_way_to_the_item() -> None:
    out = await _walk_to_proposal(_organizer(), _state(), childrens="no", owned="no")

    item = next(i for i in out["pending_proposal"].items if i.operation is Operation.add)
    assert item.childrens is False


async def test_abandoning_at_the_childrens_question_adds_nothing() -> None:
    """US2-AC4: walking away mid-chain proposes nothing — there is no write to abandon."""
    node = _organizer()
    first = await node(_state())
    assert first["add_stage"] == "awaiting_childrens"
    assert first["pending_proposal"] is None
    # The turn that asked the question wrote nothing and offered no approval; a member who
    # never replies leaves exactly that state behind.
    assert first.get("status") != "awaiting_approval"


async def test_the_collection_question_still_comes_first() -> None:
    """FR-008a: the new question is the first about the MOVIE, not the first in the flow.

    With no resolvable target the chain must still stop at `awaiting_collection` — asking
    whether an unplaceable film is a children's movie is a question about nothing.
    """
    out = await _organizer([])(
        {
            "messages": [HumanMessage(content="add The Matrix")],
            "candidate": _CANDIDATE,
            "target_collection_name": "",
            "thread_id": "t1",
        }
    )

    assert out["add_stage"] == "awaiting_collection"


# ── T016: the stage must be registered everywhere the chain is described ────────────────────
#
# This is a guard, not a tautology. Each of these sets is consulted by a DIFFERENT part of the
# runtime and each omission fails differently, none of them loudly (research R6):
#
#   graph._OWNERSHIP_STAGES    — routes a bare "yes"/"no" back to the organizer; missing it, the
#                                reply is re-classified as a brand-new request.
#   curator._OWNERSHIP_STAGES  — suppresses re-enrichment on the answer turn; missing it,
#                                extraction runs on "yes", finds no film, clears the candidate
#                                and resets the member to "what would you like me to look up?"
#                                mid-flow.
#   graph._MULTI_SELECT_STAGES — must NOT contain it: the question is single-valued (FR-011).


# Asserted as two separate tests, not one with two assertions: each set is consulted by a
# different part of the runtime, so each omission is its own defect and should name itself in
# the report rather than hiding behind whichever assertion happens to run first.


def test_stages_new_stage_is_registered_in_the_graph_ownership_stages() -> None:
    from src.graph import _OWNERSHIP_STAGES as graph_stages

    assert "awaiting_childrens" in graph_stages


def test_stages_new_stage_is_registered_in_the_curator_ownership_stages() -> None:
    from src.nodes.curator import _OWNERSHIP_STAGES as curator_stages

    assert "awaiting_childrens" in curator_stages


def test_stages_the_two_ownership_sets_stay_in_sync() -> None:
    """The curator's set is a deliberate local mirror — mirrors drift silently."""
    from src.graph import _OWNERSHIP_STAGES as graph_stages
    from src.nodes.curator import _OWNERSHIP_STAGES as curator_stages

    assert graph_stages == curator_stages


def test_stages_new_stage_is_not_a_multi_select_stage() -> None:
    """FR-011: single-valued. Listed as multi-select, a plain "yes" resolves against an empty
    option list and the question can never be answered."""
    from src.graph import _MULTI_SELECT_STAGES

    assert "awaiting_childrens" not in _MULTI_SELECT_STAGES


def test_stages_a_bare_yes_is_recognised_as_an_answer_to_the_new_question() -> None:
    """What `graph._OWNERSHIP_STAGES` membership actually buys: the supervisor keeps the turn
    in the add flow instead of treating "yes" as a new request."""
    from src.graph import _answers_ownership_question

    assert _answers_ownership_question("awaiting_childrens", "yes", {}) is True
    assert _answers_ownership_question("awaiting_childrens", "no", {}) is True
    assert _answers_ownership_question("awaiting_childrens", "add Blade Runner", {}) is False
