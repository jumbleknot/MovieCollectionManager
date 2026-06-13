"""013 US7 — unified search workflow state machine (pure code; fixes Bug 1 + Bug 2).

Collection resolution (Bug 1), multi-result disambiguation (Bug 2), web fallback + preview card,
control buttons, and "exit search" — all verified with stubbed reads (no LLM, no golden surface).
"""

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from src.nodes.search import (
    CTRL_ANOTHER,
    CTRL_EXIT,
    SCOPE_A_COLLECTION,
    SCOPE_THE_WEB,
    build_search_node,
)
from src.tools.generative_ui_tools import RENDER_MOVIE_CARD, RENDER_SELECTION
from src.tools.ui_action_tools import NAVIGATE_TO_MOVIE


def _collections(colls: list[dict[str, Any]]):
    async def f() -> list[dict[str, Any]]:
        return colls

    return f


def _movies(by_cid: dict[str, list[dict[str, Any]]]):
    async def f(cid: str, term: str) -> list[dict[str, Any]]:
        items = by_cid.get(cid, [])
        if not term:
            return items
        low = term.casefold()
        return [m for m in items if low in str(m.get("title", "")).casefold()]

    return f


def _web(results: list[dict[str, Any]]):
    async def f(query: str, year: int | None) -> dict[str, Any]:
        return {"results": results}

    return f


def _node(colls, by_cid=None, web=None):
    return build_search_node(
        list_collections=_collections(colls),
        list_movies=_movies(by_cid or {}),
        web_search=_web(web or []),
    )


def _state(text: str, **extra: Any) -> dict[str, Any]:
    return {"messages": [HumanMessage(content=text)], **extra}


def _tool_call(result: dict[str, Any]) -> dict[str, Any]:
    msg = result["messages"][-1]
    assert isinstance(msg, AIMessage)
    return msg.tool_calls[0]


def _selection_values(result: dict[str, Any]) -> list[str]:
    call = _tool_call(result)
    assert call["name"] == RENDER_SELECTION
    return [o["value"] for o in call["args"]["options"]]


def _assert_owned_result(out: dict[str, Any], *, cid: str, title: str) -> None:
    """A fresh owned search now offers result(s) as BUTTONS (013 Inc5 New Scope 1) — even exactly
    one — so assert the result button + the searched collection (`search_scope`), not a direct
    navigate. Navigation happens only when the user taps a result."""
    call = _tool_call(out)
    assert call["name"] == RENDER_SELECTION
    assert out["search_scope"] == cid
    assert out["search_stage"] == "awaiting_pick"
    assert any(title.casefold() in str(o["value"]).casefold() for o in call["args"]["options"])


# ── Bug 1: a generic "my collection" resolves to ONE collection (default/current/only) ──────


@pytest.mark.asyncio
async def test_generic_collection_resolves_to_default_not_all():
    colls = [
        {"collectionId": "c1", "name": "Sci-Fi", "isDefault": True},
        {"collectionId": "c2", "name": "Horror"},
    ]
    by_cid = {"c1": [{"movieId": "m1", "title": "Avatar", "year": 2009}], "c2": []}
    node = _node(colls, by_cid)
    result = await node(_state("show me avatar in my collection"))
    # one match in the default collection → offered as a button, scoped to c1 (no summing across
    # collections; New Scope 1 — even a single result is a button, not an auto-navigate)
    _assert_owned_result(result, cid="c1", title="Avatar")


@pytest.mark.asyncio
async def test_bare_search_uses_current_screen_collection_over_default():
    # Bug 1: while VIEWING a non-default collection, a bare "look up X" (no named collection, no
    # explicit "this") must search the ON-SCREEN collection — not silently fall to the default.
    colls = [
        {"collectionId": "c1", "name": "Movie Collection", "isDefault": True},
        {"collectionId": "c2", "name": "Wish List"},
    ]
    by_cid = {
        "c1": [{"movieId": "m1", "title": "Avatar", "year": 2009}],
        "c2": [{"movieId": "m2", "title": "Avatar", "year": 2009}],
    }
    node = _node(colls, by_cid)
    snap = {"current_screen": "collection", "collection_id": "c2"}
    out = await node(_state("look up Avatar", ui_snapshot=snap))
    _assert_owned_result(out, cid="c2", title="Avatar")  # current screen c2, NOT default c1


@pytest.mark.asyncio
async def test_bare_search_on_home_screen_falls_to_default():
    # Regression guard for the Bug 1 fix: with no on-screen collection (home), a bare search still
    # falls back to the default collection.
    colls = [
        {"collectionId": "c1", "name": "Movie Collection", "isDefault": True},
        {"collectionId": "c2", "name": "Wish List"},
    ]
    by_cid = {"c1": [{"movieId": "m1", "title": "Avatar", "year": 2009}], "c2": []}
    node = _node(colls, by_cid)
    out = await node(_state("look up Avatar", ui_snapshot={"current_screen": "home"}))
    _assert_owned_result(out, cid="c1", title="Avatar")  # home → default


@pytest.mark.asyncio
async def test_single_owned_result_offers_buttons_not_auto_navigate():
    # 013 Inc5 New Scope 1: exactly ONE owned match is offered as a button + the control buttons
    # ("Search another collection", "Search the web", "Exit search"), NOT auto-opened. The user
    # navigates only by tapping the result (the awaiting_pick path is unchanged).
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    by_cid = {"c1": [{"movieId": "m1", "title": "Avatar", "year": 2009}]}
    out = await _node(colls, by_cid)(_state("find Avatar"))
    call = _tool_call(out)
    assert call["name"] == RENDER_SELECTION
    labels = [o["label"] for o in call["args"]["options"]]
    assert "Avatar (2009)" in labels
    assert "Search another collection" in labels
    assert "Search the web" in labels
    assert "Exit search" in labels
    # Tapping the single result navigates (the pick path still opens the movie).
    picked = await _node(colls, by_cid)(
        _state("Avatar (2009)", search_stage="awaiting_pick", search_scope="c1",
               search_query="Avatar", search_results=out["search_results"])
    )
    pick_call = _tool_call(picked)
    assert pick_call["name"] == NAVIGATE_TO_MOVIE
    assert pick_call["args"] == {"collectionId": "c1", "movieId": "m1"}


@pytest.mark.asyncio
async def test_existence_question_extracts_title_and_offers_result():
    # 013 Inc5 concern: "do I have X in my <Name> collection" now routes to SEARCH (was query). The
    # node must strip the existence lead-in so the title isolates ("Avatar") — not search the
    # literal phrase "do I have Avatar" (which matches nothing) — and the hit is offered as a
    # button.
    colls = [
        {"collectionId": "c1", "name": "Sci-Fi", "isDefault": True},
        {"collectionId": "c2", "name": "Horror"},
    ]
    by_cid = {"c1": [{"movieId": "m1", "title": "Avatar", "year": 2009}], "c2": []}
    node = _node(colls, by_cid)
    out = await node(_state("do I have Avatar in my Sci-Fi collection"))
    _assert_owned_result(out, cid="c1", title="Avatar")


@pytest.mark.asyncio
async def test_is_x_in_my_collection_extracts_title():
    # "is X in my collection" is an existence check → search; strip the "is" lead-in to isolate X.
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    by_cid = {"c1": [{"movieId": "m1", "title": "Inception", "year": 2010}]}
    node = _node(colls, by_cid)
    out = await node(_state("is Inception in my collection"))
    _assert_owned_result(out, cid="c1", title="Inception")


@pytest.mark.asyncio
async def test_named_collection_is_searched():
    colls = [
        {"collectionId": "c1", "name": "Sci-Fi", "isDefault": True},
        {"collectionId": "c2", "name": "Horror"},
    ]
    by_cid = {"c2": [{"movieId": "m9", "title": "Hereditary", "year": 2018}]}
    node = _node(colls, by_cid)
    result = await node(_state("find Hereditary in my Horror collection"))
    _assert_owned_result(result, cid="c2", title="Hereditary")


@pytest.mark.asyncio
async def test_more_than_one_collection_none_resolvable_shows_scope_buttons():
    colls = [
        {"collectionId": "c1", "name": "Sci-Fi"},  # no default, >1 → can't resolve generic
        {"collectionId": "c2", "name": "Horror"},
    ]
    node = _node(colls, {"c1": [], "c2": []})
    result = await node(_state("search for Dune"))
    values = _selection_values(result)
    assert "search a collection" in values and SCOPE_THE_WEB in values
    assert result["search_stage"] == "awaiting_scope"
    assert result["search_query"] == "Dune"


@pytest.mark.asyncio
async def test_zero_collections_goes_straight_to_web():
    web = [{"title": "Dune", "year": 2021, "sourceId": "tmdb:438631"}]
    node = _node([], {}, web)
    result = await node(_state("search for Dune"))
    # single web result → preview card
    call = _tool_call(result)
    assert call["name"] == RENDER_MOVIE_CARD
    assert call["args"]["source"] == "tmdb"


# ── Bug 2: multiple matches DISAMBIGUATE (never auto-open the first) ─────────────────────────


@pytest.mark.asyncio
async def test_multiple_matches_show_result_buttons_no_autopick():
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    by_cid = {
        "c1": [
            {"movieId": "m1", "title": "Avatar", "year": 2009},
            {"movieId": "m2", "title": "Avatar: The Way of Water", "year": 2022},
        ]
    }
    node = _node(colls, by_cid)
    result = await node(_state("navigate to Avatar in movie collection"))
    call = _tool_call(result)
    assert call["name"] == RENDER_SELECTION  # buttons, NOT navigate_to_movie
    values = call["args"]["options"]
    labels = [o["value"] for o in values if o["kind"] == "movie"]
    assert "Avatar (2009)" in labels and "Avatar: The Way of Water (2022)" in labels
    assert result["search_stage"] == "awaiting_pick"


@pytest.mark.asyncio
async def test_awaiting_pick_year_disambiguates_to_navigate():
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    results = [
        {"title": "Avatar", "year": 2009, "collectionId": "c1", "movieId": "m1", "kind": "owned"},
        {"title": "Avatar", "year": 2022, "collectionId": "c1", "movieId": "m2", "kind": "owned"},
    ]
    node = _node(colls)
    out = await node(
        _state("the 2022 one", search_stage="awaiting_pick", search_scope="c1",
               search_query="Avatar", search_results=results)
    )
    call = _tool_call(out)
    assert call["name"] == NAVIGATE_TO_MOVIE
    assert call["args"]["movieId"] == "m2"


# ── US8 article-insensitivity inside the search flow ────────────────────────────────────────


@pytest.mark.asyncio
async def test_article_insensitive_owned_match():
    colls = [{"collectionId": "c1", "name": "Animated", "isDefault": True}]
    by_cid = {"c1": [{"movieId": "m1", "title": "The Secret of NIMH", "year": 1982}]}
    node = _node(colls, by_cid)
    result = await node(_state("show me secret of nimh in this collection"))
    _assert_owned_result(result, cid="c1", title="Secret of NIMH")


# ── web fallback + control buttons + exit ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_owned_results_offers_control_buttons():
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    node = _node(colls, {"c1": []})
    result = await node(_state("find Nonexistent Movie"))
    values = _selection_values(result)
    assert SCOPE_THE_WEB in values and CTRL_EXIT in values
    assert result["search_stage"] == "awaiting_pick"


@pytest.mark.asyncio
async def test_search_the_web_from_pick_then_web_card_has_tmdb_url():
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    web = [{"title": "Coherence", "year": 2013, "sourceId": "tmdb:264644"}]
    node = _node(colls, {"c1": []}, web)
    out = await node(
        _state(SCOPE_THE_WEB, search_stage="awaiting_pick", search_scope="c1",
               search_query="Coherence", search_results=[])
    )
    call = _tool_call(out)
    assert call["name"] == RENDER_MOVIE_CARD
    assert call["args"]["url"] == "https://www.themoviedb.org/movie/264644"
    assert call["args"]["addable"] is True
    assert call["args"]["movieId"] is None  # read-only preview, not in a collection


@pytest.mark.asyncio
async def test_web_card_from_pick_carries_searched_collection_as_add_target():
    # 013 Inc5 Bug 1: searching the web AFTER an owned search in a specific collection → the
    # preview card's "add to collection" must target THAT collection (Wish List), not the default
    # (the live bug added Harry Potter to "Movie Collection" instead of the current "Wish List").
    colls = [
        {"collectionId": "c1", "name": "Movie Collection", "isDefault": True},
        {"collectionId": "c2", "name": "Wish List"},
    ]
    web = [{"title": "Harry Potter", "year": 2001, "sourceId": "tmdb:671"}]
    node = _node(colls, {"c2": []}, web)
    out = await node(
        _state(SCOPE_THE_WEB, search_stage="awaiting_pick", search_scope="c2",
               search_query="Harry Potter", search_results=[])
    )
    card = _tool_call(out)
    assert card["name"] == RENDER_MOVIE_CARD
    assert card["args"]["addCollectionId"] == "c2"
    assert card["args"]["addCollectionName"] == "Wish List"


@pytest.mark.asyncio
async def test_web_card_pick_preserves_searched_collection_add_target():
    # The multi-result web pick path must ALSO carry the add target through to the chosen card.
    colls = [
        {"collectionId": "c1", "name": "Movie Collection", "isDefault": True},
        {"collectionId": "c2", "name": "Wish List"},
    ]
    web = [
        {"title": "Harry Potter and the Philosopher's Stone", "year": 2001, "sourceId": "tmdb:671"},
        {"title": "Harry Potter and the Chamber of Secrets", "year": 2002, "sourceId": "tmdb:672"},
    ]
    node = _node(colls, {"c2": []}, web)
    listed = await node(
        _state(SCOPE_THE_WEB, search_stage="awaiting_pick", search_scope="c2",
               search_query="Harry Potter", search_results=[])
    )
    assert _tool_call(listed)["name"] == RENDER_SELECTION
    picked = await node(
        _state("Harry Potter and the Philosopher's Stone (2001)",
               search_stage="awaiting_pick", search_scope="web",
               search_query="Harry Potter", search_results=listed["search_results"])
    )
    card = _tool_call(picked)
    assert card["name"] == RENDER_MOVIE_CARD
    assert card["args"]["addCollectionId"] == "c2"
    assert card["args"]["addCollectionName"] == "Wish List"


@pytest.mark.asyncio
async def test_web_card_with_no_collection_context_has_no_add_target():
    # Zero collections → web card carries no add target (the add falls back to default/create).
    node = _node([], {}, [{"title": "Dune", "year": 2021, "sourceId": "tmdb:438631"}])
    card = _tool_call(await node(_state("find Dune")))
    assert card["name"] == RENDER_MOVIE_CARD
    assert card["args"]["addCollectionId"] is None
    assert card["args"]["addCollectionName"] is None


@pytest.mark.asyncio
async def test_exit_search_clears_workflow():
    node = _node([{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}])
    out = await node(
        _state(CTRL_EXIT, search_stage="awaiting_pick", search_scope="c1",
               search_query="Avatar", search_results=[])
    )
    assert out["search_stage"] == ""
    assert out["search_results"] == []
    # plain assistant message, no tool call
    assert isinstance(out["messages"][-1], AIMessage)
    assert not out["messages"][-1].tool_calls


@pytest.mark.asyncio
async def test_awaiting_collection_pick_runs_owned_search():
    colls = [
        {"collectionId": "c1", "name": "Sci-Fi"},
        {"collectionId": "c2", "name": "Horror"},
    ]
    by_cid = {"c2": [{"movieId": "m9", "title": "Hereditary", "year": 2018}]}
    node = _node(colls, by_cid)
    out = await node(
        _state("Horror", search_stage="awaiting_collection", search_query="Hereditary")
    )
    _assert_owned_result(out, cid="c2", title="Hereditary")


# ── gap coverage: secondary transitions of the state machine ────────────────────────────────


@pytest.mark.asyncio
async def test_fresh_empty_title_asks_what_movie():
    # A search verb with no movie after it reduces to an empty title → ask, don't search.
    node = _node([{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}], {"c1": []})
    out = await node(_state("search for "))
    msg = out["messages"][-1]
    assert not msg.tool_calls
    assert "what movie" in str(msg.content).lower()
    assert out["search_stage"] == ""


@pytest.mark.asyncio
async def test_only_collection_used_when_no_default():
    # AC: with exactly one collection (no default), a generic search uses that one.
    colls = [{"collectionId": "c1", "name": "Sci-Fi"}]  # the only collection, not default
    by_cid = {"c1": [{"movieId": "m1", "title": "Avatar", "year": 2009}]}
    out = await _node(colls, by_cid)(_state("find Avatar"))
    _assert_owned_result(out, cid="c1", title="Avatar")


@pytest.mark.asyncio
async def test_web_no_results_offers_on_web_controls():
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    node = _node(colls, {"c1": []}, web=[])  # nothing owned, nothing on TMDB
    out = await node(
        _state(SCOPE_THE_WEB, search_stage="awaiting_pick", search_scope="c1",
               search_query="Nope", search_results=[])
    )
    values = _selection_values(out)
    assert SCOPE_A_COLLECTION in values and CTRL_EXIT in values  # on-web control set
    assert out["search_scope"] == "web"


@pytest.mark.asyncio
async def test_web_multiple_results_then_pick_renders_card():
    # The kind="web" pick branch: multiple TMDB results → buttons → pick one → preview card (US10).
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    web = [
        {"title": "The Matrix", "year": 1999, "sourceId": "tmdb:603"},
        {"title": "The Matrix Reloaded", "year": 2003, "sourceId": "tmdb:604"},
    ]
    node = _node(colls, {"c1": []}, web)
    out = await node(
        _state(SCOPE_THE_WEB, search_stage="awaiting_pick", search_scope="c1",
               search_query="The Matrix", search_results=[])
    )
    call = _tool_call(out)
    assert call["name"] == RENDER_SELECTION  # >1 web results → buttons, not an auto-card
    assert out["search_scope"] == "web" and out["search_stage"] == "awaiting_pick"
    assert "The Matrix (1999)" in [o["value"] for o in call["args"]["options"]]
    # pick the 1999 one → its TMDB preview card with the US10 link
    picked = await node(
        _state("The Matrix (1999)", search_stage="awaiting_pick", search_scope="web",
               search_query="The Matrix", search_results=out["search_results"])
    )
    card = _tool_call(picked)
    assert card["name"] == RENDER_MOVIE_CARD
    assert card["args"]["source"] == "tmdb"
    assert card["args"]["url"] == "https://www.themoviedb.org/movie/603"


@pytest.mark.asyncio
async def test_awaiting_scope_web_branch_runs_web_search():
    colls = [{"collectionId": "c1", "name": "A"}, {"collectionId": "c2", "name": "B"}]
    web = [{"title": "Dune", "year": 2021, "sourceId": "tmdb:438631"}]
    out = await _node(colls, {}, web)(
        _state(SCOPE_THE_WEB, search_stage="awaiting_scope", search_query="Dune")
    )
    assert _tool_call(out)["name"] == RENDER_MOVIE_CARD  # single web result → card


@pytest.mark.asyncio
async def test_awaiting_scope_collection_branch_shows_collection_buttons():
    colls = [{"collectionId": "c1", "name": "Sci-Fi"}, {"collectionId": "c2", "name": "Horror"}]
    out = await _node(colls, {})(
        _state(SCOPE_A_COLLECTION, search_stage="awaiting_scope", search_query="Dune")
    )
    call = _tool_call(out)
    assert call["name"] == RENDER_SELECTION and out["search_stage"] == "awaiting_collection"
    values = [o["value"] for o in call["args"]["options"]]
    assert "Sci-Fi" in values and "Horror" in values
    assert all(o["kind"] == "collection" for o in call["args"]["options"])


@pytest.mark.asyncio
async def test_awaiting_collection_no_match_reprompts():
    colls = [{"collectionId": "c1", "name": "Sci-Fi"}, {"collectionId": "c2", "name": "Horror"}]
    out = await _node(colls, {})(
        _state("Nonexistent", search_stage="awaiting_collection", search_query="Dune")
    )
    assert _tool_call(out)["name"] == RENDER_SELECTION
    assert out["search_stage"] == "awaiting_collection"  # re-offered, never guessed


@pytest.mark.asyncio
async def test_awaiting_pick_search_another_collection_shows_buttons():
    colls = [
        {"collectionId": "c1", "name": "Sci-Fi", "isDefault": True},
        {"collectionId": "c2", "name": "Horror"},
    ]
    out = await _node(colls, {})(
        _state(CTRL_ANOTHER, search_stage="awaiting_pick", search_scope="c1",
               search_query="Dune", search_results=[])
    )
    assert _tool_call(out)["name"] == RENDER_SELECTION
    assert out["search_stage"] == "awaiting_collection"


@pytest.mark.asyncio
async def test_awaiting_pick_unresolved_reoffers_buttons():
    colls = [{"collectionId": "c1", "name": "Sci-Fi", "isDefault": True}]
    results = [
        {"title": "Avatar", "year": 2009, "collectionId": "c1", "movieId": "m1", "kind": "owned"},
        {"title": "Avatar", "year": 2022, "collectionId": "c1", "movieId": "m2", "kind": "owned"},
    ]
    out = await _node(colls)(
        _state("uhh what", search_stage="awaiting_pick", search_scope="c1",
               search_query="Avatar", search_results=results)
    )
    assert _tool_call(out)["name"] == RENDER_SELECTION  # no guess
    assert out["search_stage"] == "awaiting_pick"  # still waiting on a pick


@pytest.mark.asyncio
async def test_exit_at_awaiting_scope_clears_workflow():
    node = _node([{"collectionId": "c1", "name": "A"}, {"collectionId": "c2", "name": "B"}])
    out = await node(_state(CTRL_EXIT, search_stage="awaiting_scope", search_query="Dune"))
    assert out["search_stage"] == ""
    assert not out["messages"][-1].tool_calls
