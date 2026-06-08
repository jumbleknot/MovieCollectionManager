"""Unit tests for the supervisor graph wiring (T020).

Tests the COMPILED LangGraph routing deterministically by injecting a stub intent
classifier (dependency injection of a pure function — not mocking an external dependency).
The real LLM classifier is exercised separately as an integration test.
The graph is real (langgraph compile + conditional edges via route_for_intent).
"""

from langchain_core.messages import AIMessage, HumanMessage

from src.graph import build_graph

_CONFIG = {"configurable": {"thread_id": "test-thread"}}


def _last_ai_text(result) -> str:
    return result["messages"][-1].content


def test_organize_intent_reaches_organizer():
    graph = build_graph(classifier=lambda messages: "organize")
    result = graph.invoke({"messages": [("user", "sort my watchlist by decade")]}, _CONFIG)
    assert "organizer" in _last_ai_text(result).lower()


def test_add_intent_reaches_curator():
    graph = build_graph(classifier=lambda messages: "add")
    result = graph.invoke({"messages": [("user", "add Blade Runner")]}, _CONFIG)
    assert "curator" in _last_ai_text(result).lower()


def test_out_of_domain_is_declined():
    graph = build_graph(classifier=lambda messages: "out_of_domain")
    result = graph.invoke({"messages": [("user", "what's the weather?")]}, _CONFIG)
    assert "movie collection" in _last_ai_text(result).lower()


def test_unclear_intent_asks_to_clarify():
    graph = build_graph(classifier=lambda messages: "???")
    result = graph.invoke({"messages": [("user", "do the thing")]}, _CONFIG)
    # The clarify node states capabilities and asks what to do (no off-domain "decline" copy).
    text = _last_ai_text(result).lower()
    assert "what would you like to do" in text
    assert "movie" in text


def test_non_user_turn_ends_without_declining():
    # A run whose latest message is NOT a user request (e.g. a render-tool round-trip
    # continuation) must end quietly — never re-classify into a spurious decline.
    calls: list[object] = []

    def classifier(messages):
        calls.append(messages)
        return "out_of_domain"

    graph = build_graph(classifier=classifier)
    result = graph.invoke(
        {"messages": [HumanMessage(content="add Coherence"), AIMessage(content="preview shown")]},
        _CONFIG,
    )
    assert calls == []  # classifier never invoked on a non-user turn
    assert "only help with your movie" not in _last_ai_text(result).lower()


def test_graph_compiles_with_expected_nodes():
    graph = build_graph(classifier=lambda messages: "add")
    node_names = set(graph.get_graph().nodes)
    for expected in ("supervisor", "curator", "organizer", "decline", "clarify"):
        assert expected in node_names, node_names
