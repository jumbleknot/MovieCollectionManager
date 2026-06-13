"""Cross-node current-screen ("this") contract — regression for the 2026-06-10 organize bug.

A node that resolves WHICH of the user's collections to ACT ON must honor the current screen (the
sanitized `ui_snapshot`) via `organizer._resolve_current_collection`. A node that *receives* the
snapshot but doesn't resolve it silently falls back to the DEFAULT collection — the live bug: on the
Wish List screen, "move X to Movie Collection" left the source unnamed, so the organizer searched
the default ("Movie Collection") and reported "couldn't find X".

This file is the ENFORCED CONTRACT the per-node tests didn't have. Two layers:
  1. **Behavioral** — each current-screen-aware node is driven with the current screen set to a
     NON-DEFAULT collection; it must resolve THERE, not the default. (The organize case fails on the
     pre-fix code — a real guard, not a green-on-broken structural grep.)
  2. **Structural tripwire** — `runtime_nodes` is the authority on which nodes are screen-aware (it
     threads the snapshot into their state). If a NEW node is made screen-aware there, the
     set-equality test fails until it is added to the contract below — so it can't silently skip
     the behavioral check above.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage

from src.nodes.navigator import build_navigator
from src.nodes.organizer import build_organizer
from src.nodes.query import build_query_node
from src.nodes.search import build_search_node

_AGENT_ROOT = Path(__file__).resolve().parents[2]  # agents/movie-assistant
_SRC = _AGENT_ROOT / "src"

# Nodes the runtime threads the ui_snapshot into → they resolve a collection to act on, so they
# MUST honor the current screen. (The curator only NORMALIZES a "this" marker for the organizer to
# resolve later — it does not resolve a collection id, so it is not in this set.)
CURRENT_SCREEN_RESOLVING_NODES: tuple[str, ...] = ("organizer", "navigator", "query", "search")

_DEFAULT_ID = "507f1f77bcf86cd799439011"  # Sci-Fi — the user's DEFAULT collection
_CURRENT_ID = "507f1f77bcf86cd799439012"  # Favorites — the collection the user is VIEWING
_COLLECTIONS: list[dict[str, Any]] = [
    {"collectionId": _DEFAULT_ID, "name": "Sci-Fi", "isDefault": True, "movieCount": 0},
    {"collectionId": _CURRENT_ID, "name": "Favorites", "isDefault": False, "movieCount": 1},
]
# Viewing Favorites (NON-default), so "current screen beats default" is observable in each test.
_CURRENT_SNAPSHOT = {"current_screen": "collection", "collection_id": _CURRENT_ID}


async def _collections() -> list[dict[str, Any]]:
    return _COLLECTIONS


# ── Behavioral: each resolving node honors the current screen over the default ────────────────


async def test_organize_resolves_source_from_current_screen_not_default() -> None:
    # "move Coherence to Sci-Fi" leaves the SOURCE unnamed; Coherence lives in Favorites (current
    # screen). The source must resolve to Favorites — pre-fix it fell to the default (Sci-Fi) and
    # found nothing. A built proposal proves it found Coherence in the on-screen collection.
    async def list_movies(collection_id: str) -> list[dict[str, Any]]:
        if collection_id == _CURRENT_ID:
            return [{"movieId": "m1", "collectionId": _CURRENT_ID, "title": "Coherence",
                     "owned": False, "tags": []}]
        return []

    def plan(_messages: Any) -> dict[str, Any]:
        return {"collection": None,
                "operations": [{"op": "move", "title": "Coherence", "to": "Sci-Fi"}]}

    node = build_organizer(
        list_collections=_collections, list_movies=list_movies, plan=plan, gen_id=lambda: "p1"
    )
    out = await node({
        "intent": "organize",
        "messages": [HumanMessage(content="move Coherence to Sci-Fi")],
        "ui_snapshot": _CURRENT_SNAPSHOT,
    })
    assert out.get("pending_proposal") is not None  # resolved Coherence in the on-screen collection


async def test_navigate_resolves_current_screen_not_default() -> None:
    async def list_movies(_collection_id: str) -> list[dict[str, Any]]:
        return []

    node = build_navigator(list_collections=_collections, list_movies=list_movies)
    out = await node({
        "intent": "navigate",
        "messages": [HumanMessage(content="go back to this collection")],
        "ui_snapshot": _CURRENT_SNAPSHOT,
    })
    call = out["messages"][-1].tool_calls[0]
    assert call["args"]["collectionId"] == _CURRENT_ID  # the viewed collection, not the default


async def test_query_resolves_current_screen_not_default() -> None:
    async def list_movies(_cid: str, _filters: Any = None) -> dict[str, Any]:
        return {"items": [], "nextCursor": None}

    async def count_movies(collection_id: str, _filters: Any = None) -> int:
        return 2 if collection_id == _CURRENT_ID else 99  # 99 = the default → wrong if misresolved

    node = build_query_node(
        list_collections=_collections, list_movies=list_movies, count_movies=count_movies,
        extract=lambda _m: {"collection_ref": "this", "movie_title": None, "filter": {}},
    )
    out = await node({
        "intent": "query",
        "messages": [HumanMessage(content="how many movies are in this collection")],
        "ui_snapshot": _CURRENT_SNAPSHOT,
    })
    text = str(out["messages"][-1].content)
    assert "Favorites" in text and "2 movie" in text  # answered for the viewed collection


async def test_search_resolves_current_screen_not_default() -> None:
    # 013 US7/Bug 1: "show me Coherence in this collection" must search the VIEWED collection
    # (Favorites), not the default (Sci-Fi). A navigate_to_movie into _CURRENT_ID proves it.
    async def list_movies(collection_id: str, _term: str) -> list[dict[str, Any]]:
        if collection_id == _CURRENT_ID:
            return [{"movieId": "m1", "title": "Coherence", "year": 2013}]
        return []  # the default has nothing → a misresolve would find nothing

    async def web_search(_q: str, _y: int | None) -> dict[str, Any]:
        return {"results": []}

    node = build_search_node(
        list_collections=_collections, list_movies=list_movies, web_search=web_search
    )
    out = await node({
        "intent": "search",
        "messages": [HumanMessage(content="show me Coherence in this collection")],
        "ui_snapshot": _CURRENT_SNAPSHOT,
    })
    # New Scope 1: the single match is offered as a button; the SEARCHED collection (search_scope)
    # proves it used the VIEWED collection (Favorites), not the default (Sci-Fi).
    assert out["search_scope"] == _CURRENT_ID


# ── Structural tripwire: a future screen-aware node can't escape the contract above ───────────


def _runtime_threaded_nodes() -> set[str]:
    """Node-wrapper functions whose body threads the ui_snapshot into state (parsed from source)."""
    text = (_SRC / "runtime_nodes.py").read_text(encoding="utf-8")
    nodes: set[str] = set()
    for match in re.finditer(r'"ui_snapshot":\s*_ui_snapshot\(config\)', text):
        enclosing = re.findall(r"async def (\w+)\(state", text[: match.start()])
        if enclosing:
            nodes.add(enclosing[-1])
    return nodes


def test_runtime_threads_ui_snapshot_into_exactly_the_contract_nodes() -> None:
    # If a new node is made current-screen-aware in the runtime, it must be added to
    # CURRENT_SCREEN_RESOLVING_NODES (which then requires a behavioral test above) — never silently.
    threaded = _runtime_threaded_nodes()
    assert threaded == set(CURRENT_SCREEN_RESOLVING_NODES), (
        f"runtime_nodes threads ui_snapshot into {sorted(threaded)}, but the current-screen "
        f"contract covers {sorted(CURRENT_SCREEN_RESOLVING_NODES)}. A node made screen-aware in"
        "runtime MUST be added here AND given a behavioral current-screen test above."
    )
