"""Unit tests for the query node (T071, US4).

The query node answers COUNT and LIST questions about what is ALREADY in the user's collections.
It does ONE LLM extraction (stubbed here) and resolves the mode + collection in PURE CODE against
the user's OWN collections/movies (downscoped reads). It is read-only: never writes, never reaches
the approval gate. An unresolvable target clarifies (FR-014). Locating a specific film ("do I have
X") is the search node's job (013 Inc5 concern) — covered in test_search.py, not here.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage

from src.nodes.query import build_query_node
from src.tools.generative_ui_tools import RENDER_COLLECTION_SUMMARY

SCIFI_ID = "507f1f77bcf86cd799439011"
FAV_ID = "507f1f77bcf86cd799439012"
COLLECTIONS = [
    {"collectionId": SCIFI_ID, "name": "Sci-Fi", "isDefault": True, "movieCount": 3},
    {"collectionId": FAV_ID, "name": "Favorites", "movieCount": 2},
]
SCIFI_MOVIES = [
    {"movieId": "607f191e810c19729de860ea", "title": "Coherence", "year": 2013},
    {"movieId": "607f191e810c19729de860eb", "title": "Primer", "year": 2004},
    {"movieId": "607f191e810c19729de860ec", "title": "Arrival", "year": 2016},
]


def _build(extraction, *, counts=None, pages=None):
    """Build a query node over stub reads. `counts`/`pages` keyed by (collection_id) → value."""

    async def list_collections():
        return COLLECTIONS

    async def list_movies(collection_id, filters=None):
        if pages is not None:
            return pages(collection_id, filters)
        # Default: Sci-Fi holds SCIFI_MOVIES; a `search` filters by title substring.
        items = SCIFI_MOVIES if collection_id == SCIFI_ID else []
        search = (filters or {}).get("search")
        if search:
            low = str(search).casefold()
            items = [m for m in items if low in m["title"].casefold()]
        return {"items": items, "nextCursor": None}

    async def count_movies(collection_id, filters=None):
        if counts is not None:
            return counts(collection_id, filters)
        return {SCIFI_ID: 3, FAV_ID: 2}.get(collection_id, 0)

    def extract(_messages):
        return extraction

    return build_query_node(
        list_collections=list_collections,
        list_movies=list_movies,
        count_movies=count_movies,
        extract=extract,
    )


def _state(text, ui_snapshot=None):
    return {"intent": "query", "messages": [HumanMessage(content=text)], "ui_snapshot": ui_snapshot}


def _last(result):
    return result["messages"][-1]


def _tool_call(result):
    calls = getattr(_last(result), "tool_calls", []) or []
    return calls[0] if calls else None


@pytest.mark.asyncio
class TestCount:
    async def test_count_named_collection(self) -> None:
        node = _build({"collection_ref": "Sci-Fi", "movie_title": None, "filter": {}})
        result = await node(_state("how many movies are in my Sci-Fi collection"))
        assert "3 movie" in _last(result).content
        assert "Sci-Fi" in _last(result).content
        assert result["pending_proposal"] is None

    async def test_count_default_collection_when_unnamed(self) -> None:
        # No collection named → the user's default (Sci-Fi here) per FR-005b.
        node = _build({"collection_ref": None, "movie_title": None, "filter": {}})
        result = await node(_state("how many movies do I have"))
        assert "3 movie" in _last(result).content

    async def test_count_across_all_collections_sums(self) -> None:
        node = _build({"collection_ref": "all", "movie_title": None, "filter": {}})
        result = await node(_state("how many movies do I have across all my collections"))
        # 3 (Sci-Fi) + 2 (Favorites) = 5, across 2 collections.
        assert "5 movie" in _last(result).content
        assert "2 collection" in _last(result).content

    async def test_count_with_filter_is_forwarded(self) -> None:
        seen = {}

        def counts(collection_id, filters):
            seen["filters"] = filters
            return 1

        node = _build(
            {"collection_ref": "Sci-Fi", "movie_title": None, "filter": {"genre": "Sci-Fi"}},
            counts=counts,
        )
        result = await node(_state("how many sci-fi movies do I have in my Sci-Fi collection"))
        assert seen["filters"] == {"genre": "Sci-Fi"}
        assert "1 movie" in _last(result).content


@pytest.mark.asyncio
class TestList:
    async def test_list_renders_summary_and_titles(self) -> None:
        node = _build({"collection_ref": "Sci-Fi", "movie_title": None, "filter": {}})
        result = await node(_state("what's in my Sci-Fi collection"))
        call = _tool_call(result)
        assert call is not None and call["name"] == RENDER_COLLECTION_SUMMARY
        assert call["args"]["movieCount"] == 3
        body = _last(result).content
        assert "Coherence" in body and "Primer" in body

    async def test_list_shows_n_of_count_when_truncated(self) -> None:
        # 25 movies, first page returns 10 → "showing 10 of 25".
        big = [{"movieId": f"id{i}", "title": f"Movie {i}"} for i in range(10)]

        node = _build(
            {"collection_ref": "Sci-Fi", "movie_title": None, "filter": {}},
            counts=lambda cid, f: 25,
            pages=lambda cid, f: {"items": big, "nextCursor": "more"},
        )
        result = await node(_state("list my Sci-Fi movies"))
        assert "showing 10 of 25" in _last(result).content


@pytest.mark.asyncio
class TestResolution:
    async def test_this_resolves_current_screen(self) -> None:
        snap = {"current_screen": "collection", "collection_id": FAV_ID}
        node = _build({"collection_ref": "this", "movie_title": None, "filter": {}})
        result = await node(_state("how many movies are in this collection", ui_snapshot=snap))
        # Favorites has 2.
        assert "2 movie" in _last(result).content
        assert "Favorites" in _last(result).content

    async def test_unresolvable_target_clarifies(self) -> None:
        # No default collection + an unknown name → ask which (never guess, FR-014).
        async def list_collections():
            return [{"collectionId": FAV_ID, "name": "Favorites"}]

        node = build_query_node(
            list_collections=list_collections,
            list_movies=lambda cid, f=None: {"items": [], "nextCursor": None},
            count_movies=lambda cid, f=None: 0,
            extract=lambda m: {"collection_ref": "Horror", "movie_title": None, "filter": {}},
        )
        result = await node(_state("how many horror movies do I have"))
        body = _last(result).content.lower()
        assert "which collection" in body and "favorites" in body

    async def test_extraction_failure_degrades_gracefully(self) -> None:
        def boom(_messages):
            raise RuntimeError("provider down")

        node = build_query_node(
            list_collections=lambda: _coro(COLLECTIONS),
            list_movies=lambda cid, f=None: _coro({"items": [], "nextCursor": None}),
            count_movies=lambda cid, f=None: _coro(0),
            extract=boom,
        )
        result = await node(_state("how many movies do I have"))
        assert "couldn't complete" in _last(result).content.lower()


async def _coro(value):
    return value
