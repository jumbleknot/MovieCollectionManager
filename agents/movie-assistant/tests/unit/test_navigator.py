"""Unit tests for the navigator node (T059, US3).

The navigator turns a "navigate" intent into an allowlisted UI-action tool call, resolving the
target in PURE CODE (no LLM, so no golden re-record) against the user's OWN collections/movies
(downscoped reads) — it can never drive the UI to a resource the user couldn't reach. An
unresolvable/ambiguous target asks the user to clarify rather than guessing (FR-014).
"""

from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage

from src.nodes.navigator import build_navigator
from src.tools.ui_action_tools import (
    NAVIGATE_TO_COLLECTION,
    NAVIGATE_TO_MOVIE,
    PREFILL_ADD_MOVIE,
)

COLLECTIONS = [
    {"collectionId": "507f1f77bcf86cd799439011", "name": "Sci-Fi", "isDefault": True},
    {"collectionId": "507f1f77bcf86cd799439012", "name": "Favorites"},
]
SCIFI_ID = "507f1f77bcf86cd799439011"
FAV_ID = "507f1f77bcf86cd799439012"

SCIFI_MOVIES = [
    {"movieId": "607f191e810c19729de860ea", "title": "Coherence"},
    {"movieId": "607f191e810c19729de860eb", "title": "Primer"},
]


def _nav(list_movies=None):
    async def list_collections():
        return COLLECTIONS

    async def _movies(collection_id: str):
        return SCIFI_MOVIES if collection_id == SCIFI_ID else []

    return build_navigator(list_collections=list_collections, list_movies=list_movies or _movies)


def _state(text: str, ui_snapshot=None):
    return {
        "intent": "navigate",
        "messages": [HumanMessage(content=text)],
        "ui_snapshot": ui_snapshot,
    }


def _tool_call(result):
    msg = result["messages"][-1]
    calls = msg.tool_calls
    assert len(calls) == 1, f"expected exactly one UI-action tool call, got {calls}"
    return calls[0]


@pytest.mark.asyncio
class TestNavigateToCollection:
    async def test_named_collection_emits_navigate_to_collection(self) -> None:
        result = await _nav()(_state("take me to my Favorites collection"))
        call = _tool_call(result)
        assert call["name"] == NAVIGATE_TO_COLLECTION
        assert call["args"] == {"collectionId": FAV_ID}
        assert result["pending_proposal"] is None

    async def test_current_screen_reference_uses_ui_snapshot(self) -> None:
        snap = {"current_screen": "collection", "collection_id": SCIFI_ID}
        result = await _nav()(_state("go back to this collection", ui_snapshot=snap))
        call = _tool_call(result)
        assert call["name"] == NAVIGATE_TO_COLLECTION
        assert call["args"] == {"collectionId": SCIFI_ID}

    async def test_unknown_collection_asks_to_clarify(self) -> None:
        result = await _nav()(_state("open my Horror collection"))
        assert "messages" in result
        assert not getattr(result["messages"][-1], "tool_calls", [])
        # Lists the user's real collections so they can pick — never guesses (FR-014).
        body = result["messages"][-1].content.lower()
        assert "sci-fi" in body and "favorites" in body

    async def test_no_target_asks_to_clarify(self) -> None:
        result = await _nav()(_state("take me somewhere"))
        assert not getattr(result["messages"][-1], "tool_calls", [])


@pytest.mark.asyncio
class TestNavigateToMovie:
    async def test_movie_named_in_resolved_collection_emits_navigate_to_movie(self) -> None:
        result = await _nav()(_state("open Coherence in my Sci-Fi collection"))
        call = _tool_call(result)
        assert call["name"] == NAVIGATE_TO_MOVIE
        assert call["args"] == {"collectionId": SCIFI_ID, "movieId": "607f191e810c19729de860ea"}

    async def test_movie_on_current_screen_collection(self) -> None:
        snap = {"current_screen": "collection", "collection_id": SCIFI_ID}
        result = await _nav()(_state("show me Primer here", ui_snapshot=snap))
        call = _tool_call(result)
        assert call["name"] == NAVIGATE_TO_MOVIE
        assert call["args"]["movieId"] == "607f191e810c19729de860eb"


@pytest.mark.asyncio
class TestPrefill:
    async def test_add_a_movie_to_named_collection_emits_prefill(self) -> None:
        # No specific film named ("a movie") → open + prefill the add form (HITL), not an add.
        result = await _nav()(_state("let me add a movie to my Favorites"))
        call = _tool_call(result)
        assert call["name"] == PREFILL_ADD_MOVIE
        assert call["args"]["collectionId"] == FAV_ID
        assert call["args"]["movie"] == {}

    async def test_prefill_on_current_screen(self) -> None:
        snap = {"current_screen": "collection", "collection_id": SCIFI_ID}
        result = await _nav()(_state("add a movie here", ui_snapshot=snap))
        call = _tool_call(result)
        assert call["name"] == PREFILL_ADD_MOVIE
        assert call["args"]["collectionId"] == SCIFI_ID

    async def test_prefill_without_resolvable_collection_clarifies(self) -> None:
        result = await _nav()(_state("add a movie"))
        assert not getattr(result["messages"][-1], "tool_calls", [])


@pytest.mark.asyncio
async def test_navigator_only_emits_allowlisted_tools() -> None:
    # Whatever the phrasing, the emitted tool name is always one of the three allowlisted ones.
    from src.tools.ui_action_tools import UI_ACTION_TOOLS

    for text in [
        "take me to my Sci-Fi collection",
        "open Coherence in Sci-Fi",
        "let me add a movie to Favorites",
    ]:
        result = await _nav()(_state(text))
        call = result["messages"][-1].tool_calls[0]
        assert call["name"] in UI_ACTION_TOOLS
