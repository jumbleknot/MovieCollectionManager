"""013 US7 — unified search workflow state machine (pure code; fixes Bug 1 + Bug 2).

Collection resolution (Bug 1), multi-result disambiguation (Bug 2), web fallback + preview card,
control buttons, and "exit search" — all verified with stubbed reads (no LLM, no golden surface).
"""

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from src.nodes.search import (
    CTRL_EXIT,
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
    call = _tool_call(result)
    # one match in the default collection → navigate straight to it (no summing across collections)
    assert call["name"] == NAVIGATE_TO_MOVIE
    assert call["args"] == {"collectionId": "c1", "movieId": "m1"}


@pytest.mark.asyncio
async def test_named_collection_is_searched():
    colls = [
        {"collectionId": "c1", "name": "Sci-Fi", "isDefault": True},
        {"collectionId": "c2", "name": "Horror"},
    ]
    by_cid = {"c2": [{"movieId": "m9", "title": "Hereditary", "year": 2018}]}
    node = _node(colls, by_cid)
    result = await node(_state("find Hereditary in my Horror collection"))
    call = _tool_call(result)
    assert call["name"] == NAVIGATE_TO_MOVIE
    assert call["args"]["collectionId"] == "c2"


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
    call = _tool_call(result)
    assert call["name"] == NAVIGATE_TO_MOVIE
    assert call["args"]["movieId"] == "m1"


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
    call = _tool_call(out)
    assert call["name"] == NAVIGATE_TO_MOVIE
    assert call["args"]["collectionId"] == "c2"
