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


def test_navigate_pick_reply_stays_in_navigator_not_escape_to_search():
    # 040 US1 / Item 4a: while a navigate disambiguation is awaiting a collection pick, a tap posts
    # the BARE collection name — which the classifier reads as a movie `search`. The navigate_stage
    # guard must keep it in the NAVIGATOR (which opens the collection), never mis-search it inside
    # the on-screen collection (the reported bug).
    reached: dict[str, bool] = {}

    def navigator_node(state):
        reached["navigator"] = True
        return {"messages": [AIMessage(content="navigator handled")]}

    graph = build_graph(classifier=lambda _m: "search", navigator=navigator_node)
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="Test Import")],
            "navigate_stage": "awaiting_collection",
            "navigate_options": [
                {"label": "Test Import", "value": "Test Import", "title": "Test Import",
                 "collectionId": "c-imp", "kind": "collection"},
                {"label": "Wish List", "value": "Wish List", "title": "Wish List",
                 "collectionId": "c-wish", "kind": "collection"},
            ],
        },
        {"configurable": {"thread_id": "nav-pick-1"}},
    )
    assert reached.get("navigator") is True
    assert "navigator handled" in _last_ai_text(result)


def test_navigate_genuine_new_command_escapes_navigate():
    # Guard the fix: a reply that does NOT match an offered collection and is a genuinely new
    # command escapes the navigate workflow (and clears its state) rather than sticking.
    graph = build_graph(
        classifier=lambda _m: "add",
        navigator=lambda s: {"messages": [AIMessage(content="navigator handled")]},
    )
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="add Dune to my Sci-Fi collection")],
            "navigate_stage": "awaiting_collection",
            "navigate_options": [
                {"label": "Wish List", "value": "Wish List", "title": "Wish List",
                 "collectionId": "c-wish", "kind": "collection"},
            ],
        },
        {"configurable": {"thread_id": "nav-pick-2"}},
    )
    assert "curator" in _last_ai_text(result).lower()  # escaped to the (default) curator responder


def test_import_unparsed_answer_stays_in_import_not_abandoned():
    # 040 US2 / FR-013: a reply to a comma/article question that doesn't resolve an offered option
    # (and reads like a movie title → classifies as `search`) must NOT silently abandon the import.
    # The supervisor keeps it in the import node, which re-asks the pending question.
    reached: dict[str, bool] = {}

    def import_node(state):
        reached["import"] = True
        return {"messages": [AIMessage(content="import re-asked")]}

    graph = build_graph(classifier=lambda _m: "search", import_collection=import_node)
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="Girl, Interrupted")],
            "import_stage": "awaiting_import_choice",
            "import_prompt": {
                "kind": "article", "key": "k",
                "options": [{"label": "Reorder", "value": "reorder", "title": "Reorder"},
                            {"label": "Keep as-is", "value": "keep", "title": "Keep as-is"}],
            },
            "import_context": {"tabs": [], "collections": []},
        },
        {"configurable": {"thread_id": "import-reask-1"}},
    )
    assert reached.get("import") is True
    assert "import re-asked" in _last_ai_text(result)


def test_import_genuine_new_command_escapes_import():
    # Guard: a clearly-new WRITE/NAV command (add) does escape the in-progress import.
    graph = build_graph(
        classifier=lambda _m: "add",
        import_collection=lambda s: {"messages": [AIMessage(content="import handled")]},
    )
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="add Dune to my Sci-Fi collection")],
            "import_stage": "awaiting_import_choice",
            "import_prompt": {"kind": "article", "key": "k", "options": []},
            "import_context": {"tabs": [], "collections": []},
        },
        {"configurable": {"thread_id": "import-escape-1"}},
    )
    assert "curator" in _last_ai_text(result).lower()  # escaped to the (default) curator responder


def test_supervisor_binds_per_run_agent_config_for_the_classifier():
    # 018 review #2: intent classification must source the user's OWN provider/key. The
    # supervisor node re-sets the per-run agent_config (from config["configurable"]) onto the
    # ContextVar the classifier's model build reads — otherwise classify_intent silently runs on
    # the shared process env, breaking BYO-credentials (and Anthropic-only users entirely).
    from src.runtime_context import get_agent_config

    seen: dict[str, object] = {}

    def classifier(messages):
        seen["cfg"] = get_agent_config()
        return "out_of_domain"

    graph = build_graph(classifier=classifier)
    agent_config = {"provider": "anthropic", "anthropicKey": "sk-user", "tmdbKey": "k"}
    graph.invoke(
        {"messages": [("user", "hello")]},
        {"configurable": {"thread_id": "cfg-bind-1", "agent_config": agent_config}},
    )
    assert seen["cfg"] == agent_config
    # No cross-run leak: the ContextVar is reset once the node returns.
    assert get_agent_config() is None


# ── 050 / item #149: the search-cancel control is routed WITHOUT the classifier ───────────────
#
# FR-010. The card's Cancel is a control the member CHOSE, not prose to be interpreted, and an
# escape hatch that can be classified away is not an escape hatch. Two failure modes are pinned
# here because both are real in this codebase:
#
#   1. The classifier reads "exit search" as something other than `search`. It happens to get this
#      right today, but 047's ownership guard exists precisely because prose-like replies
#      classified differently on Ollama and on Anthropic — a provider-dependent route.
#   2. The classifier RAISES. `_classify` returns `degraded` on any provider failure BEFORE any
#      routing runs, so a provider outage would answer a cancel with "I couldn't complete that"
#      instead of exiting. A cancel must not need a healthy LLM.


def _cancel_graph(classifier, **kwargs):
    reached: dict[str, bool] = {}

    def search_node(state):
        reached["search"] = True
        return {"messages": [AIMessage(content="search handled")], "search_stage": ""}

    return build_graph(classifier=classifier, search=search_node, **kwargs), reached


def test_cancel_control_routes_without_consulting_the_classifier():
    calls: list[object] = []

    def classifier(messages):
        calls.append(messages)
        return "out_of_domain"

    graph, reached = _cancel_graph(classifier)
    result = graph.invoke(
        {"messages": [HumanMessage(content="exit search")]},
        {"configurable": {"thread_id": "cancel-route-1"}},
    )
    assert calls == [], "the cancel control must not depend on an intent classification"
    assert reached.get("search") is True
    assert "search handled" in _last_ai_text(result)


def test_cancel_control_still_exits_when_the_classifier_is_down():
    def classifier(messages):
        raise RuntimeError("provider unreachable")

    graph, reached = _cancel_graph(classifier)
    result = graph.invoke(
        {"messages": [HumanMessage(content="exit search")]},
        {"configurable": {"thread_id": "cancel-route-2"}},
    )
    assert result.get("intent") != "degraded", "a provider outage must not swallow a cancel"
    assert reached.get("search") is True


def test_a_title_containing_the_cancel_words_is_not_routed_as_a_cancel():
    # The exact-match rule, from the router's side: this is an ordinary request and must be
    # classified normally, not hijacked by the control.
    calls: list[object] = []

    def classifier(messages):
        calls.append(messages)
        return "search"

    graph, reached = _cancel_graph(classifier)
    graph.invoke(
        {"messages": [HumanMessage(content="find How to Exit Search a Building")]},
        {"configurable": {"thread_id": "cancel-route-3"}},
    )
    assert len(calls) == 1, "an ordinary request must still be classified"


# ── 050 US2 (T012): what a stage-free cancel clears, and what it must NOT ─────────────────────
#
# `_exit()` returns _SEARCH_RESET + _LIFECYCLE_RESET. research.md R5 claims that is exactly the
# right blast radius — search state goes, an in-flight import/organize/navigate survives, and an
# in-flight ADD is protected by a guard on the route because _LIFECYCLE_RESET would discard it.
# Those are claims about behaviour, so they are asserted here rather than assumed.


def _graph_with_real_search(classifier):
    """A graph wired to the REAL search node (stubbed reads only).

    `build_graph`'s default `search` is a fixed-text responder that never touches state, so a test
    asserting the search context is cleared must inject the real node or it proves nothing. This is
    the closest unit-level analogue of what the member experiences: message → router → search node.
    """
    from src.nodes.search import build_search_node

    reads: list[tuple[str, str]] = []

    async def list_collections():
        return [{"collectionId": "c1", "name": "Wish List", "isDefault": True}]

    async def list_movies(cid, term):
        reads.append((cid, term))
        return []

    async def web_search(query, _year):
        reads.append(("web", query))
        return {"results": []}

    node = build_search_node(
        list_collections=list_collections, list_movies=list_movies, web_search=web_search
    )
    return build_graph(classifier=classifier, search=node), reads


async def test_residue_cancel_from_the_terminal_card_clears_everything_end_to_end():
    """FR-006 + the whole of item #149, through the real router AND the real search node.

    No search stage — the state the terminal movie card leaves behind. This is the single test
    that most closely reproduces the member's report.
    """
    graph, reads = _graph_with_real_search(lambda _m: "search")
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="exit search")]},
        {"configurable": {"thread_id": "residue-1"}},
    )
    assert reads == [], f"the cancel searched a collection: {reads}"
    assert result.get("search_stage") == ""
    assert result.get("search_results") == []
    text = _last_ai_text(result).casefold()
    assert "couldn't find" not in text
    assert "wish list" not in text


async def test_residue_cancel_mid_search_clears_the_whole_search_context():
    """FR-006 for the in-stage control, so widening the guard cannot narrow this."""
    graph, _reads = _graph_with_real_search(lambda _m: "out_of_domain")
    result = await graph.ainvoke(
        {
            "messages": [HumanMessage(content="exit search")],
            "search_stage": "awaiting_pick",
            "search_scope": "c1",
            "search_query": "The Matrix",
            "search_results": [{"title": "The Matrix", "year": 1999, "kind": "web"}],
        },
        {"configurable": {"thread_id": "residue-1b"}},
    )
    assert result.get("search_stage") == ""
    assert result.get("search_query") == ""
    assert result.get("search_results") == []


def test_residue_cancel_does_not_abandon_a_pending_import():
    """Spec edge case "stale card": a late cancel must not disturb what the member is doing now.

    Neither reset dict touches `import_stage`, so the import survives — but that is a property of
    two dicts a future edit could change silently, which is why it is pinned.
    """
    graph = build_graph(classifier=lambda _m: "out_of_domain")
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="exit search")],
            "import_stage": "awaiting_answer",
        },
        {"configurable": {"thread_id": "residue-2"}},
    )
    assert result.get("import_stage") == "awaiting_answer", (
        "a search cancel silently abandoned an in-progress import"
    )


def test_residue_cancel_does_not_discard_a_pending_add():
    """FR-009 + research R5: `_exit()` clears the add lifecycle, so the route must not fire here.

    An add mid-flight is the member's half-finished work. 047's ownership guard exists because a
    misroute at this exact point silently threw a member's movie away; the stage-free cancel route
    must not reintroduce that.
    """
    graph = build_graph(classifier=lambda _m: "add")
    result = graph.invoke(
        {
            "messages": [HumanMessage(content="exit search")],
            "add_stage": "awaiting_pick",
            "options": [{"sourceId": "x", "title": "A", "year": 2000}],
        },
        {"configurable": {"thread_id": "residue-3"}},
    )
    assert result.get("add_stage") == "awaiting_pick", (
        "a search cancel discarded an in-progress add"
    )


def test_graph_compiles_with_expected_nodes():
    graph = build_graph(classifier=lambda messages: "add")
    node_names = set(graph.get_graph().nodes)
    for expected in ("supervisor", "curator", "organizer", "decline", "clarify"):
        assert expected in node_names, node_names
