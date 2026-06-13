"""Spec-derived state-machine transition tables (013 Inc5 test hardening).

These tables encode the EXPECTED transition for each `(stage, input-class)` of the deterministic
workflows — derived from the SPEC (specs/013-post-agent-enhancements: New Scope 1 + the
search/organize disambiguation notes), NOT from the implementation. That distinction is the point:
the single-result-auto-navigate bug (new bug 2) shipped because the unit test encoded the
implementation's intent (the old AC8) rather than the spec ("1 or more results → buttons"). A
table written from the spec turns "the code drifted from the spec" into a failing test.

Each row drives a node (with stubbed reads) from a starting state and asserts the OUTCOME class
(emitted tool + next stage), classified by `_classify`. Adding a workflow transition = adding a
row here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from src.nodes.organizer import build_organizer
from src.nodes.search import (
    CTRL_ANOTHER,
    CTRL_EXIT,
    SCOPE_A_COLLECTION,
    SCOPE_THE_WEB,
    build_search_node,
)
from src.tools.generative_ui_tools import RENDER_COLLECTION_SUMMARY, RENDER_SELECTION
from src.tools.ui_action_tools import NAVIGATE_TO_MOVIE


# ── outcome classifier (the observable result of a transition) ──────────────────────────────
def _classify(out: dict[str, Any]) -> str:
    """Map a node result to a coarse outcome class for transition assertions."""
    msg = out["messages"][-1]
    calls = getattr(msg, "tool_calls", []) or []
    if not calls:
        content = str(getattr(msg, "content", "")).lower()
        if "what movie" in content:
            return "ask_title"
        if "exited search" in content or "cancelled" in content:
            return "exit"
        if "which collection" in content:
            return "clarify_collection"
        return "message"
    call = calls[0]
    name = call["name"]
    if name == NAVIGATE_TO_MOVIE:
        return "navigate"
    if name == "render_movie_card":
        return "web_card"
    if name == RENDER_COLLECTION_SUMMARY:
        return "organize_preview"
    if name == RENDER_SELECTION:
        kinds = {o.get("kind") for o in call["args"]["options"]}
        if "scope" in kinds:
            return "scope_buttons"
        if "collection" in kinds:
            return "collection_buttons"
        if "movie" in kinds:
            # owned vs web result buttons are distinguished by search_scope where it matters.
            return "web_pick_buttons" if str(out.get("search_scope")) == "web" else "result_buttons"
        return "control_buttons"  # only control options (a no-results prompt)
    return f"tool:{name}"


# ── SEARCH workflow ─────────────────────────────────────────────────────────────────────────

_SCIFI = "c-scifi"
_HORROR = "c-horror"
_COLLS_DEFAULT = [
    {"collectionId": _SCIFI, "name": "Sci-Fi", "isDefault": True},
    {"collectionId": _HORROR, "name": "Horror"},
]
_COLLS_NO_DEFAULT = [
    {"collectionId": _SCIFI, "name": "Sci-Fi"},
    {"collectionId": _HORROR, "name": "Horror"},
]
_AVATAR = {"movieId": "m-av", "title": "Avatar", "year": 2009}
_AVATAR2 = {"movieId": "m-av2", "title": "Avatar: The Way of Water", "year": 2022}
_WEB_ONE = [{"title": "Coherence", "year": 2013, "sourceId": "tmdb:1"}]
_WEB_MANY = [
    {"title": "The Matrix", "year": 1999, "sourceId": "tmdb:603"},
    {"title": "The Matrix Reloaded", "year": 2003, "sourceId": "tmdb:604"},
]


def _search_node(colls, by_cid=None, web=None):
    async def list_collections():
        return colls

    async def list_movies(cid, term):
        items = (by_cid or {}).get(cid, [])
        low = (term or "").casefold()
        return [m for m in items if not low or low in str(m.get("title", "")).casefold()]

    async def web_search(_q, _y):
        return {"results": web or []}

    return build_search_node(
        list_collections=list_collections, list_movies=list_movies, web_search=web_search
    )


@dataclass
class S:
    id: str
    state: dict[str, Any]
    text: str
    expect: str
    spec: str
    colls: list[dict[str, Any]] = field(default_factory=lambda: _COLLS_DEFAULT)
    by_cid: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    web: list[dict[str, Any]] = field(default_factory=list)


_SEARCH_TRANSITIONS: list[S] = [
    # ── fresh (stage="") ────────────────────────────────────────────────────────────────────
    S("fresh-owned-single→buttons", {}, "find Avatar in my Sci-Fi collection", "result_buttons",
      "New Scope 1: 1+ owned results → BUTTONS, never auto-navigate (new bug 2)",
      by_cid={_SCIFI: [_AVATAR]}),
    S("fresh-owned-multi→buttons", {}, "find Avatar in my Sci-Fi collection", "result_buttons",
      "New Scope 1: several matches → disambiguation buttons",
      by_cid={_SCIFI: [_AVATAR, _AVATAR2]}),
    S("fresh-owned-miss→controls", {}, "find Inception in my Sci-Fi collection", "control_buttons",
      "New Scope 1: no match → control buttons (search another / web / exit)",
      by_cid={_SCIFI: []}),
    S("fresh-no-title→ask", {}, "search for ", "ask_title",
      "a search verb with no title asks what movie", by_cid={_SCIFI: [_AVATAR]}),
    S("fresh-zero-collections→web", {}, "find Coherence", "web_card",
      "New Scope 1: no collections → search the web", colls=[], web=_WEB_ONE),
    S("fresh->1-coll-none-resolvable→scope", {}, "find Coherence", "scope_buttons",
      "New Scope 1: >1 collection, none resolvable → scope buttons",
      colls=_COLLS_NO_DEFAULT),
    # ── awaiting_scope ──────────────────────────────────────────────────────────────────────
    S("scope-web→web", {"search_stage": "awaiting_scope", "search_query": "Coherence"},
      SCOPE_THE_WEB, "web_card", "scope → 'search the web' runs a web search",
      colls=_COLLS_NO_DEFAULT, web=_WEB_ONE),
    S("scope-collection→collection-buttons",
      {"search_stage": "awaiting_scope", "search_query": "Coherence"},
      SCOPE_A_COLLECTION, "collection_buttons", "scope → 'search a collection' lists collections",
      colls=_COLLS_NO_DEFAULT),
    # ── awaiting_collection ─────────────────────────────────────────────────────────────────
    S("collection-pick→buttons",
      {"search_stage": "awaiting_collection", "search_query": "Avatar"},
      "Sci-Fi", "result_buttons", "collection pick → owned search there (1+ → buttons)",
      by_cid={_SCIFI: [_AVATAR]}),
    S("collection-no-match→reoffer",
      {"search_stage": "awaiting_collection", "search_query": "Avatar"},
      "Nonexistent", "collection_buttons", "an unknown collection name → re-offer the list"),
    # ── awaiting_pick ───────────────────────────────────────────────────────────────────────
    S("pick-owned-result→navigate",
      {"search_stage": "awaiting_pick", "search_scope": _SCIFI, "search_query": "Avatar",
       "search_results": [{"title": "Avatar", "year": 2009, "collectionId": _SCIFI,
                           "movieId": "m-av", "kind": "owned"}]},
      "Avatar (2009)", "navigate", "tapping an owned result navigates to it"),
    S("pick-web-result→web-card",
      {"search_stage": "awaiting_pick", "search_scope": "web", "search_query": "The Matrix",
       "search_results": [{"title": "The Matrix", "year": 1999, "sourceId": "tmdb:603",
                           "kind": "web"}]},
      "The Matrix (1999)", "web_card", "tapping a web result renders its preview card"),
    S("pick-another-collection→collection-buttons",
      {"search_stage": "awaiting_pick", "search_scope": _SCIFI, "search_query": "X",
       "search_results": []},
      CTRL_ANOTHER, "collection_buttons", "'search another collection' lists collections"),
    S("pick-the-web→web",
      {"search_stage": "awaiting_pick", "search_scope": _SCIFI, "search_query": "Coherence",
       "search_results": []},
      SCOPE_THE_WEB, "web_card", "'search the web' from a pick runs a web search",
      by_cid={_SCIFI: [_AVATAR]}, web=_WEB_ONE),
    S("pick-exit→exit",
      {"search_stage": "awaiting_pick", "search_scope": _SCIFI, "search_query": "X",
       "search_results": []},
      CTRL_EXIT, "exit", "'exit search' clears the workflow"),
    S("pick-unresolvable→reoffer",
      {"search_stage": "awaiting_pick", "search_scope": _SCIFI, "search_query": "Avatar",
       "search_results": [{"title": "Avatar", "year": 2009, "collectionId": _SCIFI,
                           "movieId": "m-av", "kind": "owned"}]},
      "the purple one", "result_buttons", "an unresolvable reply re-offers the same buttons"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("t", _SEARCH_TRANSITIONS, ids=lambda t: t.id)
async def test_search_transition(t: S) -> None:
    node = _search_node(t.colls, t.by_cid, t.web)
    out = await node({"messages": [HumanMessage(content=t.text)], **t.state})
    assert _classify(out) == t.expect, f"{t.id}: {t.spec}"


# ── ORGANIZE disambiguation workflow (013 Inc5 new bug 1 + Cancel) ──────────────────────────

_WISH = "wish-list"
_MC = "movie-coll"
_ORG_COLLS = [
    {"collectionId": _MC, "name": "Movie Collection", "isDefault": True},
    {"collectionId": _WISH, "name": "Wish List"},
]
_TWO_HP = {
    _MC: [],
    _WISH: [
        {"movieId": "hp1", "collectionId": _WISH, "year": 2007, "owned": False, "tags": [],
         "title": "Harry Potter and the Order of the Phoenix"},
        {"movieId": "hp2", "collectionId": _WISH, "title": "Harry Potter and the Goblet of Fire",
         "year": 2005, "owned": False, "tags": []},
    ],
}
_ONE_HP = {_MC: [], _WISH: [_TWO_HP[_WISH][0]]}


def _organizer(plan, by_cid):
    async def list_collections():
        return _ORG_COLLS

    async def list_movies(cid):
        return by_cid.get(cid, [])

    return build_organizer(
        list_collections=list_collections, list_movies=list_movies,
        plan=lambda _m: plan, gen_id=lambda: "p1",
    )


def _org_state(text: str, **extra: Any) -> dict[str, Any]:
    return {
        "intent": "organize",
        "messages": [HumanMessage(content=text)],
        "ui_snapshot": {"current_screen": "collection", "collection_id": _WISH},
        "thread_id": "t1",
        **extra,
    }


_MOVE_HP = {"collection": None,
            "operations": [{"op": "move", "title": "harry potter", "to": "Movie Collection"}]}


@pytest.mark.asyncio
async def test_organize_partial_unique_goes_to_preview() -> None:
    # New bug 1: one partial match → straight to the approval preview (user decision).
    node = _organizer(_MOVE_HP, _ONE_HP)
    out = await node(_org_state("move harry potter to Movie Collection"))
    assert _classify(out) == "organize_preview"
    assert out.get("organize_stage", "") == ""


@pytest.mark.asyncio
async def test_organize_partial_multiple_disambiguates() -> None:
    node = _organizer(_MOVE_HP, _TWO_HP)
    out = await node(_org_state("move harry potter to Movie Collection"))
    call = out["messages"][-1].tool_calls[0]
    assert call["name"] == RENDER_SELECTION
    assert out["organize_stage"] == "awaiting_pick"
    labels = [o["label"] for o in call["args"]["options"]]
    assert "Cancel Move" in labels  # the Cancel control button is offered


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply,expect_stage,expect_preview",
    [
        ("Harry Potter and the Order of the Phoenix (2007)", "", True),  # a pick → preview
        ("cancel", "", False),                                            # cancel → clean exit
        ("never mind", "", False),                                        # typed cancel
    ],
)
async def test_organize_disambiguation_pick_or_cancel(
    reply: str, expect_stage: str, expect_preview: bool
) -> None:
    node = _organizer(_MOVE_HP, _TWO_HP)
    options = [
        {"movieId": "hp1", "collectionId": _WISH,
         "title": "Harry Potter and the Order of the Phoenix", "year": 2007,
         "owned": False, "tags": []},
        {"movieId": "hp2", "collectionId": _WISH,
         "title": "Harry Potter and the Goblet of Fire", "year": 2005, "owned": False, "tags": []},
    ]
    out = await node(_org_state(
        reply,
        organize_stage="awaiting_pick",
        organize_pending={"op": "move", "to": "Movie Collection", "changes": {},
                          "collection_id": _WISH},
        organize_options=options,
    ))
    assert out.get("organize_stage", "") == expect_stage
    has_preview = isinstance(out["messages"][-1], AIMessage) and bool(
        out["messages"][-1].tool_calls
    )
    assert has_preview is expect_preview
