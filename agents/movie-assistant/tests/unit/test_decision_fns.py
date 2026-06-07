"""Pure model-decision functions targeted by the golden gate (T032)."""

from langchain_core.messages import AIMessage, HumanMessage

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
