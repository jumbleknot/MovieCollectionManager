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
    result = graph.invoke({"messages": [("user", "sort my wishlist by decade")]}, _CONFIG)
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


def test_disambiguation_reply_continues_pending_add():
    # A bare-title reply (classifies as enrich) while awaiting a pick is the user picking one of
    # the offered options — continue the add, don't drop to a preview-only enrich (T069/R14).
    graph = build_graph(classifier=lambda _m: "enrich")
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="The Curse of the Black Pearl (2003)")],
            "intent": "add",
            "add_stage": "awaiting_pick",
        },
        {"configurable": {"thread_id": "disambig-1"}},
    )
    assert result["intent"] == "add"


def test_off_topic_during_pending_add_is_respected():
    # An off-topic reply mid-pick must NOT be hijacked into the add — it declines and escapes the
    # pending pick (out_of_domain is trusted as abandonment here; T069/R14).
    graph = build_graph(classifier=lambda _m: "out_of_domain")
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="what's the weather")],
            "intent": "add",
            "add_stage": "awaiting_pick",
            "options": [{"sourceId": "x", "title": "A", "year": 2000}],
        },
        {"configurable": {"thread_id": "disambig-2"}},
    )
    assert result["intent"] == "out_of_domain"
    assert "only help with your movie" in _last_ai_text(result).lower()


def test_search_pick_reply_stays_in_search_not_escape_to_add():
    # Bug 2: a bare "Title (Year)" pick of an offered result can classify as `add`, but while a
    # search is awaiting a pick it must be resolved by the SEARCH node — never escape to the
    # curator (which renders an enrich preview with no clickable TMDB link).
    reached: dict[str, bool] = {}

    def search_node(state):
        reached["search"] = True
        return {"messages": [AIMessage(content="search handled")]}

    graph = build_graph(classifier=lambda _m: "add", search=search_node)
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="The Matrix (1999)")],
            "search_stage": "awaiting_pick",
            "search_results": [
                {"title": "The Matrix", "year": 1999, "sourceId": "tmdb:603", "kind": "web"}
            ],
        },
        {"configurable": {"thread_id": "search-pick-1"}},
    )
    assert reached.get("search") is True
    assert "search handled" in _last_ai_text(result)


def test_search_genuine_new_add_command_escapes_search():
    # Guard the Bug 2 fix: a reply that does NOT match an offered result and classifies as `add`
    # is a genuinely new command → escape the search workflow (route to the curator).
    graph = build_graph(
        classifier=lambda _m: "add",
        search=lambda s: {"messages": [AIMessage(content="search handled")]},
    )
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="add Dune to my Sci-Fi collection")],
            "search_stage": "awaiting_pick",
            "search_results": [
                {"title": "The Matrix", "year": 1999, "sourceId": "tmdb:603", "kind": "web"}
            ],
        },
        {"configurable": {"thread_id": "search-pick-2"}},
    )
    assert "curator" in _last_ai_text(result).lower()  # escaped to the (default) curator responder


def test_graph_compiles_with_expected_nodes():
    graph = build_graph(classifier=lambda messages: "add")
    node_names = set(graph.get_graph().nodes)
    for expected in ("supervisor", "curator", "organizer", "decline", "clarify"):
        assert expected in node_names, node_names
