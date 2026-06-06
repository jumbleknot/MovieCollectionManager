"""Unit tests for supervisor intent routing (T017).

The supervisor classifies intent (via the model) then maps it to the next graph node.
`route_for_intent` is the PURE mapping (intent label -> node), unit-testable without an LLM.
Discovery/enrichment/add -> curator; organize -> organizer; out-of-domain -> decline
(FR-005); anything unclear -> clarify (FR-014).
"""

import pytest

from src.nodes.supervisor import route_for_intent


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
