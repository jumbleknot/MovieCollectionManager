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
    # ── 050 / item #149: the terminal card, where there is no stage left ─────────────────────
    #
    # `_web_card` returns _SEARCH_RESET, so by the time the member can SEE the Cancel button the
    # stage is already "". A control gated on a live stage is therefore unreachable from the one
    # card that offers it, and the value falls through to the fresh-search branch as a title —
    # answering the member with `I couldn't find "exit search" in your "…" collection`.
    S("card-cancel-no-stage→exit", {}, CTRL_EXIT, "exit",
      "#149: the terminal card has ALREADY cleared the stage — cancel must still exit",
      by_cid={_SCIFI: []}),
    S("typed-exit-no-stage→exit", {}, "Exit Search", "exit",
      "the same control typed, and cased as the button labels it",
      by_cid={_SCIFI: []}),
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


# ============================================================================
# 047 US2 — import sorting-question transitions, written from spec.md
#
# Each row encodes ONE acceptance scenario from spec.md "User Story 2", by its AC number,
# and asserts the OUTCOME CLASS of the pure import-disambiguation pipeline. Written from
# the spec text quoted in `spec`, not from the implementation — the point of the 013 Inc5
# discipline is that "the code drifted from the spec" shows up as a failing row.
# ============================================================================

_IMPORT_COLLS = [{"collectionId": "ci-fav", "name": "Favourites"}]


def _import_tab(*titles: str) -> dict[str, Any]:
    return {
        "name": "Favourites",  # exact match → the collection question never fires
        "eligible": True,
        "columns": [{"header": "Title"}, {"header": "Year"}, {"header": "Video Type"}],
        "rows": [
            {"Title": t, "Year": str(1990 + i), "Video Type": "Movie"}
            for i, t in enumerate(titles)
        ],
    }


def _classify_import(reply: str, titles: list[str], resolutions: dict[str, Any]) -> str:
    """Drive one import-question turn and classify the outcome.

    Returns one of: "asked" (a question is pending), "resolved" (the reply was recorded and
    a further question follows), "done" (nothing left to decide), "reask_with_escape"
    (the reply matched nothing, so the question is re-offered WITH a way out).
    """
    from src.nodes.import_disambiguation import (
        CANCEL_IMPORT_LABEL,
        apply_import_pick,
        collect_import_disambiguations,
        is_cancel_import,
        resolve_import_pick,
        to_selection_options,
    )

    tabs = [_import_tab(*titles)]
    if is_cancel_import(reply):
        return "cancelled"
    prompts = collect_import_disambiguations(tabs, _IMPORT_COLLS, resolutions)
    if not prompts:
        return "done"
    prompt = prompts[0]
    if not reply:
        return "asked"
    chosen = resolve_import_pick(reply, prompt)
    if chosen is None:
        labels = {
            o["label"] for o in to_selection_options(prompt, unresolved_replies=1)
        }
        return "reask_with_escape" if CANCEL_IMPORT_LABEL in labels else "reask_no_escape"
    updated = apply_import_pick(resolutions, prompt, chosen)
    remaining = collect_import_disambiguations(tabs, _IMPORT_COLLS, updated)
    return "resolved" if remaining else "done"


_TRAILING = "Three Billboards Outside Ebbing, Missouri "


@dataclass
class IT:
    id: str
    reply: str
    titles: list[str]
    resolutions: dict[str, Any]
    expect: str
    spec: str


_IMPORT_TRANSITIONS: list[IT] = [
    IT("ac1-tap-trailing-space→done", _TRAILING.strip(), [_TRAILING], {}, "done",
       "US2-AC1: a tapped option for a trailing-whitespace title is ACCEPTED and the import "
       "proceeds to the next question or the preview"),
    IT("ac2-typed-without-whitespace→done", _TRAILING.strip().lower(), [_TRAILING], {}, "done",
       "US2-AC2: typing the title back without the trailing whitespace is accepted — "
       "leading/trailing whitespace never affects whether an answer matches"),
    IT("ac3-already-answered→never-reasked", "", [_TRAILING],
       {"article": {_TRAILING.strip(): _TRAILING.strip()}}, "done",
       "US2-AC3: a title the member already answered for is never asked about again"),
    IT("ac4-unmatched-reply→reask-with-escape", "purple monkey dishwasher", [_TRAILING], {},
       "reask_with_escape",
       "US2-AC4: a reply matching none of the options is re-asked WITH a way to abandon "
       "the import — it does not repeat the identical question indefinitely"),
    IT("ac4-cancel→cancelled", "Cancel import", [_TRAILING], {}, "cancelled",
       "US2-AC4: the offered way out actually ends the import"),
    IT("ac6-several-titles→one-at-a-time", _TRAILING.strip(),
       [_TRAILING, "Goodbye, Lenin!"], {}, "resolved",
       "US2-AC6: with several distinct ambiguous titles, answering one leaves the others "
       "still to be asked — each exactly once"),
    IT("ac6-multi-word-comma→never-asked", "", ["Crouching Tiger, Hidden Dragon"], {}, "done",
       "US2-AC6/FR-012: a genuine multi-word title comma is not an ambiguous title, so it "
       "is never one of the decisions"),
]


@pytest.mark.parametrize("t", _IMPORT_TRANSITIONS, ids=lambda t: t.id)
def test_import_sorting_transition(t: IT) -> None:
    got = _classify_import(t.reply, t.titles, dict(t.resolutions))
    assert got == t.expect, f"{t.id}: expected {t.expect}, got {got}\nSPEC: {t.spec}"


def test_import_ac5_stored_title_is_trimmed() -> None:
    """US2-AC5: an imported title with surrounding whitespace is STORED trimmed."""
    from src.nodes.import_collection import build_import_preview
    from src.nodes.import_disambiguation import (
        apply_import_pick,
        collect_import_disambiguations,
        resolve_import_pick,
    )

    tabs = [_import_tab(_TRAILING)]
    prompts = collect_import_disambiguations(tabs, _IMPORT_COLLS, {})
    chosen = resolve_import_pick(str(prompts[0].options[0]["title"]).strip(), prompts[0])
    assert chosen is not None
    resolutions = apply_import_pick({}, prompts[0], chosen)

    preview = build_import_preview(
        tabs=tabs, collections=_IMPORT_COLLS, existing_by_collection={},
        thread_id="t", resolutions=resolutions,
    )
    titles = [item.payload["title"] for item in preview.tabs[0].to_create]
    assert titles == [_TRAILING.strip()]
    for title in titles:
        assert title == title.strip()


# ============================================================================
# 047 US4 — ownership follow-up chain, written from spec.md
#
# awaiting_ownership → awaiting_media → awaiting_ripped → awaiting_rip_quality → proposal,
# with the no/abandon branches. Each row cites the acceptance scenario it encodes; the table
# is written from spec.md's US4 scenarios, not from the organizer.
# ============================================================================

_OWNERSHIP_FORMATS = ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"]
_OWN_COLL = [{"collectionId": "c-fav", "name": "Favourites", "isDefault": True}]


def _ownership_candidate() -> dict[str, Any]:
    return {
        "sourceId": "tmdb:603",
        "title": "The Matrix",
        "year": 1999,
        "overview": "",
        "genres": [],
        "posterUrl": None,
    }


def _ownership_node(metadata_fails: bool = False):
    from src.nodes.organizer import build_organizer

    async def list_collections() -> list[dict[str, Any]]:
        return _OWN_COLL

    async def list_movies(_cid: str) -> list[dict[str, Any]]:
        return []

    async def get_movie_metadata() -> dict[str, Any] | None:
        if metadata_fails:
            return None
        return {"mediaFormats": list(_OWNERSHIP_FORMATS)}

    return build_organizer(
        list_collections=list_collections,
        list_movies=list_movies,
        gen_id=lambda: "p-own",
        get_movie_metadata=get_movie_metadata,
    )


def _ownership_state(text: str, **extra: Any) -> dict[str, Any]:
    state: dict[str, Any] = {
        "intent": "add",
        "candidate": _ownership_candidate(),
        "target_collection_name": "Favourites",
        "thread_id": "t-own",
        "messages": [HumanMessage(content=text)],
    }
    state.update(extra)
    return state


def _classify_ownership(out: dict[str, Any]) -> str:
    """Classify an organizer turn by the stage it left behind / the proposal it built."""
    if out.get("pending_proposal") is not None:
        return "proposal"
    stage = str(out.get("add_stage") or "")
    return stage or "ended"


@dataclass
class OT:
    id: str
    text: str
    state: dict[str, Any]
    expect: str
    spec: str


_OWNERSHIP_TRANSITIONS: list[OT] = [
    OT("ac1-not-owned→proposal", "no", {"add_stage": "awaiting_ownership"}, "proposal",
       "US4-AC1: answering no adds the movie as not owned, with no formats and no rip "
       "quality — exactly as today"),
    OT("ac2-owned→awaiting_media", "yes", {"add_stage": "awaiting_ownership"}, "awaiting_media",
       "US4-AC2: answering yes offers the supported media formats as a toggle list"),
    OT("ac3-media-confirm→awaiting_ripped", "Selected: DVD, Blu-Ray",
       {"add_stage": "awaiting_media", "add_multi_pending": _OWNERSHIP_FORMATS},
       "awaiting_ripped",
       "US4-AC3: confirming the selection carries the still-selected formats forward and "
       "asks whether the movie is ripped"),
    OT("ac4-not-ripped→proposal", "no",
       {"add_stage": "awaiting_ripped", "add_owned_media": ["DVD"]}, "proposal",
       "US4-AC4: answering no to ripped adds it owned with the formats, not ripped, no quality"),
    OT("ac5-ripped→awaiting_rip_quality", "yes",
       {"add_stage": "awaiting_ripped", "add_owned_media": ["DVD"]}, "awaiting_rip_quality",
       "US4-AC5: answering yes to ripped offers the supported rip qualities as a toggle list"),
    OT("ac6-quality-confirm→proposal", "Selected: UHD Blu-Ray",
       {"add_stage": "awaiting_rip_quality", "add_owned_media": ["DVD"], "add_ripped": True,
        "add_multi_pending": _OWNERSHIP_FORMATS},
       "proposal",
       "US4-AC6: with every answer collected the add proposal is built for approval"),
    OT("ac8-zero-formats→awaiting_ripped", "Selected: none",
       {"add_stage": "awaiting_media", "add_multi_pending": _OWNERSHIP_FORMATS},
       "awaiting_ripped",
       "US4-AC8: selecting no formats is allowed — the flow continues, owned with none recorded"),
    # An unresolvable reply must RE-ASK the same question rather than guess or drop through.
    OT("unclear-media-reply→re-ask", "what are my options",
       {"add_stage": "awaiting_media", "add_multi_pending": _OWNERSHIP_FORMATS},
       "awaiting_media",
       "never guess: a reply naming nothing on offer re-asks (mirrors FR-014's discipline)"),
    OT("unclear-ripped-reply→re-ask", "hmm",
       {"add_stage": "awaiting_ripped", "add_owned_media": ["DVD"]}, "awaiting_ripped",
       "never guess: an unclear ripped answer re-asks"),
]


@pytest.mark.parametrize("t", _OWNERSHIP_TRANSITIONS, ids=lambda t: t.id)
async def test_ownership_transition(t: OT) -> None:
    node = _ownership_node()
    out = await node(_ownership_state(t.text, **t.state))
    got = _classify_ownership(out)
    assert got == t.expect, f"{t.id}: expected {t.expect}, got {got}\nSPEC: {t.spec}"


async def test_ownership_ac3_only_confirmed_formats_are_carried_forward() -> None:
    """US4-AC3: two toggled on, one back off → only the two still-selected are carried."""
    node = _ownership_node()
    out = await node(
        _ownership_state(
            "Selected: DVD, Blu-Ray",
            add_stage="awaiting_media",
            add_multi_pending=_OWNERSHIP_FORMATS,
        )
    )
    assert out["add_owned_media"] == ["DVD", "Blu-Ray"]
    assert "Blu-Ray 3D" not in out["add_owned_media"]


async def test_ownership_ac6_proposal_carries_exactly_the_chosen_values() -> None:
    """US4-AC6: the built proposal carries exactly the owned flag, formats, ripped, qualities."""
    node = _ownership_node()
    out = await node(
        _ownership_state(
            "Selected: UHD Blu-Ray",
            add_stage="awaiting_rip_quality",
            add_owned_media=["DVD", "Blu-Ray"],
            add_ripped=True,
            add_multi_pending=_OWNERSHIP_FORMATS,
        )
    )
    proposal = out["pending_proposal"]
    item = next(i for i in proposal.items if i.operation.value == "add")
    assert item.owned is True
    assert item.owned_media == ["DVD", "Blu-Ray"]
    assert item.ripped is True
    assert item.rip_quality == ["UHD Blu-Ray"]


async def test_ownership_ac1_no_ownership_records_nothing_else() -> None:
    """US4-AC1: a not-owned add carries no formats, is not ripped, and has no qualities."""
    node = _ownership_node()
    out = await node(_ownership_state("no", add_stage="awaiting_ownership"))
    item = next(i for i in out["pending_proposal"].items if i.operation.value == "add")
    assert item.owned is False
    assert item.owned_media == []
    assert not item.ripped
    assert item.rip_quality == []


async def test_ownership_ac2_offers_the_domain_published_formats_not_a_literal() -> None:
    """US4-AC2 + RQ-4: the toggle list is built from the fetched values, never an inlined list."""
    node = _ownership_node()
    out = await node(_ownership_state("yes", add_stage="awaiting_ownership"))
    calls = [c for c in out["messages"][-1].tool_calls if c["name"] == "render_multi_select"]
    assert len(calls) == 1
    offered = [o["value"] for o in calls[0]["args"]["options"]]
    assert offered == _OWNERSHIP_FORMATS
    # The options the member was shown are recorded, so a typed reply resolves against the
    # same set the buttons displayed (FR-036).
    assert out["add_multi_pending"] == _OWNERSHIP_FORMATS


# ── NAVIGATE (047 US1) ──────────────────────────────────────────────────────────────────────
#
# Written from spec.md's US1 acceptance scenarios, NOT from navigator.py. Each row cites the
# scenario it encodes, so a future change that drifts from the spec fails here with the citation
# rather than being quietly re-blessed by editing the test to match the code.

_NAV_SCIFI = "nav-scifi"
_NAV_FAVS = "nav-favs"
_NAV_COLLS = [
    {"collectionId": _NAV_SCIFI, "name": "Sci-Fi", "isDefault": True},
    {"collectionId": _NAV_FAVS, "name": "Favorites"},
]
_NAV_DUNE = {"movieId": "dune-1", "title": "Dune", "year": 2021}


@dataclass
class NT:
    id: str
    text: str
    expect: str
    spec: str
    by_cid: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    reads_movies: bool = True  # whether a movie read is EXPECTED for this request


def _classify_nav(out: dict[str, Any]) -> str:
    msg = (out.get("messages") or [None])[-1]
    calls = [c["name"] for c in (getattr(msg, "tool_calls", None) or [])]
    from src.tools.generative_ui_tools import RENDER_SELECTION
    from src.tools.ui_action_tools import NAVIGATE_TO_COLLECTION, NAVIGATE_TO_MOVIE

    if NAVIGATE_TO_MOVIE in calls:
        return "open_movie"
    if NAVIGATE_TO_COLLECTION in calls:
        return "open_collection"
    if RENDER_SELECTION in calls:
        return "ask_which_collection"
    return "plain_reply"


_NAV_TRANSITIONS: list[NT] = [
    NT("named-collection→opens", "navigate to my Sci-Fi collection", "open_collection",
       "US1-AC1: asking for a named collection opens that collection's screen",
       reads_movies=False),
    NT("large-collection-name-only→no-movie-read", "open my Sci-Fi collection", "open_collection",
       "US1-AC1 + FR-002: resolving a NAME must not read the collection's contents, so the "
       "answer cannot get slower as the collection grows",
       by_cid={_NAV_SCIFI: [_NAV_DUNE]}, reads_movies=False),
    NT("unknown-collection→asks-with-choices", "navigate to my Documentaries collection",
       "ask_which_collection",
       "US1-AC2: a name matching none of theirs asks which they meant and offers their "
       "collections as choices — never a generic failure"),
    NT("named-movie→opens-movie", "take me to Dune", "open_movie",
       "US1-AC3: naming a movie that exists in exactly one collection opens its detail screen",
       by_cid={_NAV_SCIFI: [_NAV_DUNE], _NAV_FAVS: []}),
    NT("movie-in-two-collections→asks", "take me to Dune", "plain_reply",
       "US1-AC3 (converse): the same title in more than one collection is ambiguous — ask, "
       "never guess which one",
       by_cid={_NAV_SCIFI: [_NAV_DUNE], _NAV_FAVS: [_NAV_DUNE]}),
]


@pytest.mark.parametrize("t", _NAV_TRANSITIONS, ids=lambda t: t.id)
async def test_navigate_transition(t: NT) -> None:
    from src.nodes.navigator import build_navigator

    reads: list[str] = []

    async def list_collections() -> list[dict[str, Any]]:
        return _NAV_COLLS

    async def list_movies(collection_id: str, _term: str = "") -> list[dict[str, Any]]:
        reads.append(collection_id)
        return t.by_cid.get(collection_id, [])

    node = build_navigator(list_collections=list_collections, list_movies=list_movies)
    out = await node({"intent": "navigate", "messages": [HumanMessage(content=t.text)]})

    assert _classify_nav(out) == t.expect, f"{t.id}: {t.spec}"
    if not t.reads_movies:
        assert reads == [], (
            f"{t.id}: {t.spec} — but the turn read movies from {reads}"
        )


async def test_navigate_unresolvable_names_what_it_could_not_find() -> None:
    """US1-AC5 + FR-004: the reply says WHAT it could not find, not just that it failed."""
    from src.nodes.navigator import build_navigator

    async def list_collections() -> list[dict[str, Any]]:
        return _NAV_COLLS

    node = build_navigator(list_collections=list_collections)
    out = await node({
        "intent": "navigate",
        "messages": [HumanMessage(content="open my Documentaries collection")],
    })
    reply = str(out["messages"][-1].content)
    assert "Documentaries" in reply, f"US1-AC5: must name the unresolved target — got {reply!r}"
    assert "couldn't complete" not in reply.lower(), "US1-AC4/FR-005: not the generic reply"


# ── IMPORT RUN (047 US3) ────────────────────────────────────────────────────────────────────
#
# Written from spec.md's US3 acceptance scenarios, NOT from the implementation. Each row cites
# the scenario it encodes so a drift fails here with the citation attached.

_IMPORT_RUN_STATES = [
    ("in-flight", {"import_applied": 1200, "import_total": 2300}, "progress_visible",
     "US3-AC2: a single progress line advances in place while the import runs"),
    ("concluded", {"import_applied": 0, "import_total": 0}, "no_progress_surface",
     "US3-AC2: when the import completes the line is REPLACED by the final report"),
    ("never-started", {}, "no_progress_surface",
     "US3-AC2 (converse): no run, no surface — the line is not a permanent fixture"),
    ("interrupted", {"import_applied": 900, "import_total": 2000}, "progress_visible",
     "US3-AC5: a run that stopped part-way is still an outcome the member must be told about"),
]


@pytest.mark.parametrize(
    "case", _IMPORT_RUN_STATES, ids=lambda c: f"import_run-{c[0]}"
)
def test_import_run_progress_surface_transition(case: tuple[str, dict, str, str]) -> None:
    """The progress surface is a pure function of the counters — nothing else may switch it on."""
    _id, state, expect, spec = case
    total = int(state.get("import_total") or 0)
    actual = "progress_visible" if total > 0 else "no_progress_surface"
    assert actual == expect, f"{_id}: {spec}"


@pytest.mark.parametrize(
    "rows,expect,spec",
    [
        (2000, "preview", "US3-AC1: 2,000+ rows previews rather than stalling"),
        (5000, "preview", "US3-AC3: up to 5,000 rows in one file completes"),
        (5001, "refused_up_front", "US3-AC4: over the limit is refused UP FRONT, with the size"),
    ],
    ids=["ac1-2000-previews", "ac3-5000-previews", "ac4-5001-refused"],
)
def test_import_run_size_transition(rows: int, expect: str, spec: str) -> None:
    from src.nodes.import_collection import MAX_IMPORT_ROWS, count_import_rows, oversize_refusal

    tabs = [{"name": "Sci-Fi", "eligible": True, "rows": [{"Title": f"F{i}"} for i in range(rows)]}]
    counted = count_import_rows(tabs)
    actual = "refused_up_front" if counted > MAX_IMPORT_ROWS else "preview"
    assert actual == expect, spec
    if actual == "refused_up_front":
        message = oversize_refusal(counted)
        assert f"{counted:,}" in message, f"{spec} — the refusal must state the file's size"
        assert f"{MAX_IMPORT_ROWS:,}" in message, f"{spec} — and the limit"


def test_import_run_ineligible_tabs_do_not_count_towards_the_limit() -> None:
    """US3-AC4 boundary: a file is refused for what the import would ACTUALLY touch."""
    from src.nodes.import_collection import count_import_rows

    tabs = [
        {"name": "Movies", "eligible": True, "rows": [{"Title": f"F{i}"} for i in range(10)]},
        {"name": "Notes", "eligible": False, "rows": [{"Title": f"N{i}"} for i in range(9000)]},
    ]
    assert count_import_rows(tabs) == 10
