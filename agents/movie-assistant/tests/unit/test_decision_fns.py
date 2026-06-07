"""Pure model-decision functions targeted by the golden gate (T032)."""

from langchain_core.messages import AIMessage, HumanMessage

from src.nodes.curator import extract_entities
from src.nodes.supervisor import INTENTS, classify_intent


class _Model:
    def __init__(self, reply: str) -> None:
        self._reply = reply

    def invoke(self, _prompt, *_a, **_k) -> AIMessage:
        return AIMessage(content=self._reply)


def test_classify_intent_returns_known_label():
    out = classify_intent(_Model("add"), [HumanMessage(content="add Coherence to Watchlist")])
    assert out == "add"
    assert "add" in INTENTS


def test_classify_intent_unknown_label_falls_back_to_ambiguous():
    out = classify_intent(_Model("banana"), [HumanMessage(content="???")])
    assert out == "ambiguous"


def test_classify_intent_normalizes_case_and_whitespace():
    out = classify_intent(_Model("  ENRICH \n"), [HumanMessage(content="tell me about Dune")])
    assert out == "enrich"


def test_extract_entities_parses_json_object():
    model = _Model('{"title": "Coherence", "year": 2013, "collection": "Watchlist"}')
    out = extract_entities(model, [HumanMessage(content="add Coherence (2013) to Watchlist")])
    assert out == {"title": "Coherence", "year": 2013, "collection": "Watchlist"}


def test_extract_entities_returns_empty_on_garbage():
    out = extract_entities(_Model("not json at all"), [HumanMessage(content="???")])
    assert out == {}
