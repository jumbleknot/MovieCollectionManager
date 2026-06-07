"""Unit tests for supervisor intent routing (T017).

The supervisor classifies intent (via the model) then maps it to the next graph node.
`route_for_intent` is the PURE mapping (intent label -> node), unit-testable without an LLM.
Discovery/enrichment/add -> curator; organize -> organizer; out-of-domain -> decline
(FR-005); anything unclear -> clarify (FR-014).
"""

import pytest
from langgraph.graph import END

from src.nodes.supervisor import route_after_curator, route_after_organizer, route_for_intent


@pytest.mark.parametrize("intent", ["add", "enrich"])
def test_add_and_enrich_route_to_curator(intent):
    assert route_for_intent(intent) == "curator"


def test_organize_routes_to_organizer():
    assert route_for_intent("organize") == "organizer"


def test_out_of_domain_routes_to_decline():
    assert route_for_intent("out_of_domain") == "decline"


@pytest.mark.parametrize("intent", ["ambiguous", "", "something-weird"])
def test_unclear_intent_routes_to_clarify(intent):
    assert route_for_intent(intent) == "clarify"


# ── add-flow routing (T046): curator → organizer → approval_gate ──────────────


def test_resolved_add_routes_curator_to_organizer():
    state = {"intent": "add", "candidate": object()}
    assert route_after_curator(state) == "organizer"


@pytest.mark.parametrize(
    "state",
    [
        {"intent": "enrich", "candidate": object()},  # enrich-only ends after preview
        {"intent": "add", "candidate": None},  # ambiguous/no-match add ends (clarify shown)
    ],
)
def test_curator_otherwise_ends(state):
    assert route_after_curator(state) == END


def test_built_proposal_routes_organizer_to_approval_gate():
    assert route_after_organizer({"pending_proposal": object()}) == "approval_gate"


def test_organizer_without_proposal_ends():
    assert route_after_organizer({"pending_proposal": None}) == END
