"""T069: multi-turn conversational-add hardening — the disambiguation state machine.

Graph-level TDD (research R14): drives the COMPILED graph with stub tool closures +
MemorySaver across multiple turns, exercising ambiguous title → pick → propose → approve.
Covers RC1 ordinal/year picks, RC2 spoken-target preservation, RC3 default-collection +
clarify-when-none, RC4 lifecycle reset. The live path is T069e/f (web/mobile E2E).

Mirrors tests/unit/test_add_flow_graph.py: stub `search`/`details`/`list_collections`/
`execute` closures so the full HITL path (incl. LangGraph interrupt()/resume) is
deterministic without Keycloak/MCP/mc-service.
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src.graph import build_graph
from src.nodes.approval_gate import ExecOutcome, build_approval_gate
from src.nodes.curator import build_curator
from src.nodes.organizer import build_organizer

# An ambiguous franchise title → several equally-likely matches.
_OPTIONS: list[dict[str, Any]] = [
    {"sourceId": "tmdb:22", "title": "Pirates of the Caribbean: The Curse of the Black Pearl",
     "year": 2003},
    {"sourceId": "tmdb:58", "title": "Pirates of the Caribbean: Dead Man's Chest", "year": 2006},
    {"sourceId": "tmdb:285", "title": "Pirates of the Caribbean: At World's End", "year": 2007},
]


def _detail(source_id: str, title: str, year: int) -> dict[str, Any]:
    return {
        "source": "tmdb", "sourceId": source_id, "title": title, "year": year,
        "overview": "x", "genres": ["Adventure"], "posterUrl": "http://x", "language": "English",
    }


_DETAILS: dict[str, dict[str, Any]] = {
    o["sourceId"]: _detail(o["sourceId"], o["title"], o["year"]) for o in _OPTIONS
}
_DETAILS["tmdb:603"] = _detail("tmdb:603", "The Matrix", 1999)
_DETAILS["tmdb:27205"] = _detail("tmdb:27205", "Inception", 2010)


def _classifier(messages: Any) -> str:
    """Stub supervisor classifier. A bare ordinal pick like 'the first one' is deliberately NOT
    'add' so the tests prove pick-resolution does not depend on the classifier (RC1); an
    in-domain title mention IS 'add' (a garbled-but-on-topic reply re-enriches, not declines)."""
    text = str(messages[-1].content if messages else "").lower()
    if text.startswith("tell me") or text.startswith("look up"):
        return "enrich"
    if text.startswith("add") or "pirates" in text or "matrix" in text:
        return "add"
    return "out_of_domain"


async def _search(query: str, year: int | None) -> dict[str, Any]:
    low = query.lower()
    if "pirates" in low:
        if year is not None:
            match = [o for o in _OPTIONS if o["year"] == year]
            if len(match) == 1:
                return {"matchConfidence": "exact", "results": [{"sourceId": match[0]["sourceId"]}]}
        return {"matchConfidence": "ambiguous", "results": _OPTIONS}
    source_id = "tmdb:603" if "matrix" in low else "tmdb:27205"
    return {"matchConfidence": "exact", "results": [{"sourceId": source_id}]}


async def _details(source_id: str) -> dict[str, Any]:
    return _DETAILS[source_id]


def _extract(messages: Any) -> dict[str, Any]:
    """Stub curator extraction: pull {title, collection} from the latest message only."""
    low = str(messages[-1].content if messages else "").lower()
    out: dict[str, Any] = {}
    for key, title in (("pirates", "Pirates of the Caribbean"), ("matrix", "The Matrix"),
                       ("inception", "Inception")):
        if key in low:
            out["title"] = title
            break
    if "favorites" in low:
        out["collection"] = "Favorites"
    elif "sci-fi" in low:
        out["collection"] = "Sci-Fi"
    elif "classics" in low:
        out["collection"] = "Classics"
    elif "drama" in low:
        out["collection"] = "Drama"
    elif "my collection" in low or "my list" in low:
        out["collection"] = "my collection"
    return out


def _build(
    *,
    collections: list[dict[str, Any]] | None = None,
    execute_calls: list[Any] | None = None,
) -> Any:
    cols = collections if collections is not None else [
        {"collectionId": "0123456789abcdef01234567", "name": "Sci-Fi", "isDefault": False,
         "movieCount": 0},
    ]
    calls = execute_calls if execute_calls is not None else []

    async def list_collections() -> list[dict[str, Any]]:
        return cols

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append((str(operation), args, key))
        if str(operation) == "create_collection":
            return ExecOutcome(status="applied", data={"collectionId": "newcollection0000000000aa"})
        return ExecOutcome(status="applied", data={"movieId": "m1"})

    return build_graph(
        classifier=_classifier,
        curator=build_curator(extract=_extract, search=_search, details=_details),
        organizer=build_organizer(list_collections=list_collections, gen_id=lambda: "p1"),
        approval_gate=build_approval_gate(execute=execute),
        checkpointer=MemorySaver(),
    )


def _config(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread}}


# ── RC2 (T069a): the spoken target collection survives disambiguation ───────────────────────


async def test_ambiguous_turn_preserves_named_collection() -> None:
    graph = _build()
    result = await graph.ainvoke(
        {"messages": [("user", "add Pirates of the Caribbean to my Favorites")]},
        _config("amb-target"),
    )
    assert result["match_confidence"] == "ambiguous"
    assert len(result["options"]) == 3
    # RC2: "Favorites" must not be dropped on the ambiguous branch.
    assert result["target_collection_name"] == "Favorites"


# ── RC2 ("this"): a current-screen reference survives an ambiguous-title disambiguation ──────

_SCI_FI_ID = "0123456789abcdef01234567"  # the default _build() collection


async def test_ambiguous_this_is_captured_and_resolves_current_collection_after_pick() -> None:
    # Turn 1 "add <ambiguous> to this" on a collection screen: the title is ambiguous so the
    # organizer (which resolves "this") is never reached — the curator must still capture the
    # current-screen reference as the canonical "this" marker so it survives to turn 2.
    graph = _build()
    cfg = _config("amb-this")
    ui = {"current_screen": "collection", "collection_id": _SCI_FI_ID}

    turn1 = await graph.ainvoke(
        {"messages": [("user", "add Pirates of the Caribbean to this")], "ui_snapshot": ui}, cfg
    )
    assert turn1["match_confidence"] == "ambiguous"
    assert turn1["target_collection_name"] == "this"  # RC2: the "this" ref is captured + preserved

    turn2 = await graph.ainvoke(
        {"messages": [("user", "the first one")], "ui_snapshot": ui}, cfg
    )
    assert "__interrupt__" in turn2  # the pick resolved → approval gate
    payload = turn2["__interrupt__"][0].value
    assert payload["target"]["collection_id"] == _SCI_FI_ID  # resolved the on-screen collection
    assert payload["target"]["create_if_missing"] is False  # never creates a literal "this"


async def test_ambiguous_this_on_home_clarifies_after_pick() -> None:
    # No on-screen collection (home) → after the pick, "this" is unresolvable → ask which
    # collection, never guess (US3-AC2 / FR-014).
    graph = _build()
    cfg = _config("amb-this-home")
    ui = {"current_screen": "home", "collection_id": None}

    await graph.ainvoke(
        {"messages": [("user", "add Pirates of the Caribbean to this")], "ui_snapshot": ui}, cfg
    )
    turn2 = await graph.ainvoke(
        {"messages": [("user", "the first one")], "ui_snapshot": ui}, cfg
    )
    assert "__interrupt__" not in turn2  # unresolvable "this" → clarify, never auto-target
    assert turn2["add_stage"] == "awaiting_collection"


async def test_ambiguous_named_target_still_beats_a_this_in_the_message() -> None:
    # An explicitly named collection on the ambiguous turn wins over a stray "this" — the
    # normalization must not hijack a real target (mirrors organizer._add's guard).
    cols = [
        {"collectionId": "a" * 24, "name": "Favorites", "isDefault": False, "movieCount": 0},
    ]
    graph = _build(collections=cols)
    turn1 = await graph.ainvoke(
        {
            "messages": [("user", "add this Pirates of the Caribbean movie to my Favorites")],
            "ui_snapshot": {"current_screen": "collection", "collection_id": _SCI_FI_ID},
        },
        _config("amb-named-wins"),
    )
    assert turn1["match_confidence"] == "ambiguous"
    assert turn1["target_collection_name"] == "Favorites"  # not hijacked to "this"


# ── RC1 (T069b): ordinal / year picks resolve against the offered options ────────────────────


async def test_ordinal_pick_resolves_and_proposes() -> None:
    graph = _build()
    cfg = _config("amb-ordinal")
    await graph.ainvoke(
        {"messages": [("user", "add Pirates of the Caribbean to Sci-Fi")]}, cfg
    )
    result = await graph.ainvoke({"messages": [("user", "the first one")]}, cfg)
    assert "__interrupt__" in result  # the pick resolved → proceeded to the approval gate
    payload = result["__interrupt__"][0].value
    assert payload["type"] == "approval_request"
    assert payload["items"][-1]["movie"]["title"] == _OPTIONS[0]["title"]


async def test_year_pick_resolves_to_matching_option() -> None:
    graph = _build()
    cfg = _config("amb-year")
    await graph.ainvoke(
        {"messages": [("user", "add Pirates of the Caribbean to Sci-Fi")]}, cfg
    )
    result = await graph.ainvoke({"messages": [("user", "the 2006 one")]}, cfg)
    assert "__interrupt__" in result
    assert result["__interrupt__"][0].value["items"][-1]["movie"]["year"] == 2006


async def test_unresolvable_pick_reasks_without_proposing() -> None:
    graph = _build()
    cfg = _config("amb-bad")
    await graph.ainvoke(
        {"messages": [("user", "add Pirates of the Caribbean to Sci-Fi")]}, cfg
    )
    # An in-domain reply that still doesn't pin a single option (no ordinal/year/full title).
    result = await graph.ainvoke({"messages": [("user", "the green pirates one")]}, cfg)
    assert "__interrupt__" not in result  # cannot resolve → re-ask, never guess (FR-014)
    assert result["match_confidence"] == "ambiguous"  # still awaiting a pick


# ── RC3 (T069c): default-collection resolution + clarify when none ───────────────────────────


async def test_generic_target_resolves_to_default_collection() -> None:
    cols = [
        {"collectionId": "a" * 24, "name": "Classics", "isDefault": False, "movieCount": 0},
        {"collectionId": "b" * 24, "name": "My Favorites", "isDefault": True, "movieCount": 0},
    ]
    graph = _build(collections=cols)
    result = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to my collection")]}, _config("def-1")
    )
    assert "__interrupt__" in result
    payload = result["__interrupt__"][0].value
    # Generic "my collection" → the user's actual default, not a literal new "my collection".
    assert payload["target"]["collection_id"] == "b" * 24
    assert [i for i in payload["items"] if i["operation"] == "create_collection"] == []


async def test_generic_target_without_default_clarifies_then_completes() -> None:
    cols = [
        {"collectionId": "a" * 24, "name": "Drama", "isDefault": False, "movieCount": 0},
        {"collectionId": "c" * 24, "name": "Classics", "isDefault": False, "movieCount": 0},
    ]
    calls: list[Any] = []
    graph = _build(collections=cols, execute_calls=calls)
    cfg = _config("def-2")
    clarify = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to my collection")]}, cfg
    )
    assert "__interrupt__" not in clarify  # no default → ask which, never auto-create
    assert clarify["add_stage"] == "awaiting_collection"
    text = str(clarify["messages"][-1].content)
    assert "Drama" in text and "Classics" in text  # lists the user's collections

    chosen = await graph.ainvoke({"messages": [("user", "Drama")]}, cfg)
    assert "__interrupt__" in chosen  # naming a collection completes the pending add
    assert chosen["__interrupt__"][0].value["target"]["collection_id"] == "a" * 24
    assert [c for c in calls if c[0] == "create_collection"] == []  # nothing created


# ── RC4 (T069d): finished-add state does not leak into the next turn ─────────────────────────


async def test_completed_add_does_not_leak_into_next_turn() -> None:
    graph = _build()
    cfg = _config("reset-1")
    await graph.ainvoke(
        {"messages": [("user", "add Pirates of the Caribbean to Sci-Fi")]}, cfg
    )
    await graph.ainvoke({"messages": [("user", "the first one")]}, cfg)  # → interrupt
    await graph.ainvoke(Command(resume={"decision": "approved"}), cfg)  # apply + reset

    follow = await graph.ainvoke({"messages": [("user", "tell me about Inception")]}, cfg)
    assert "__interrupt__" not in follow  # an unrelated enrich is not hijacked into the add
    assert not follow.get("options")  # stale options cleared (RC4)
    assert follow.get("match_confidence") != "ambiguous"
