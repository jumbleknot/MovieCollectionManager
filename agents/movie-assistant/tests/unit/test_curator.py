"""Unit tests for the curator node (T034 / T039, US1).

The curator discovers + enriches movie metadata (web-api-mcp read-only) and emits a
render_movie_card preview; it NEVER writes. Enrichment is orchestrated in code (search →
details) with the LLM used only for entity extraction + phrasing — so the logic is
deterministic with injected/mocked tools (the real TMDB path is T035). Match confidence is
honoured: exact → candidate + preview; ambiguous → offer options (no candidate); none →
say so (never fabricate, spec edge case).
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage

from src.nodes.curator import EnrichResult, build_curator, enrich_movie
from src.tools.generative_ui_tools import RENDER_MOVIE_CARD

_DETAILS = {
    "source": "tmdb", "sourceId": "tmdb:603", "title": "The Matrix", "year": 1999,
    "overview": "A hacker learns the truth.", "genres": ["Science Fiction"],
    "posterUrl": "https://image.tmdb.org/x.jpg", "language": "English",
}


async def _search_exact(query: str, year: int | None) -> dict[str, Any]:
    return {
        "matchConfidence": "exact",
        "results": [{"sourceId": "tmdb:603", "title": "The Matrix", "year": 1999}],
    }


async def _details_matrix(source_id: str) -> dict[str, Any]:
    return _DETAILS


def _render_call(messages: list[Any]) -> dict[str, Any] | None:
    for m in messages:
        for tc in getattr(m, "tool_calls", []) or []:
            if tc["name"] == RENDER_MOVIE_CARD:
                return tc["args"]
    return None


# ── enrich_movie (the T035 integration target, here with mocked tools) ────────

async def test_enrich_exact_match_returns_candidate() -> None:
    detail_calls = 0

    async def details(source_id: str) -> dict[str, Any]:
        nonlocal detail_calls
        detail_calls += 1
        return _DETAILS

    result = await enrich_movie("The Matrix", 1999, search=_search_exact, details=details)
    assert result.confidence == "exact"
    assert result.candidate is not None
    assert result.candidate.title == "The Matrix"
    assert result.candidate.source_id == "tmdb:603"
    assert detail_calls == 1


async def test_enrich_ambiguous_offers_options_without_fetching_details() -> None:
    fetched = False

    async def search(query: str, year: int | None) -> dict[str, Any]:
        return {"matchConfidence": "ambiguous", "results": [
            {"sourceId": "tmdb:1", "title": "A", "year": 1999},
            {"sourceId": "tmdb:2", "title": "B", "year": 2003},
        ]}

    async def details(source_id: str) -> dict[str, Any]:
        nonlocal fetched
        fetched = True
        return _DETAILS

    result = await enrich_movie("ambiguous", None, search=search, details=details)
    assert result.confidence == "ambiguous"
    assert result.candidate is None
    assert len(result.options) == 2
    assert fetched is False  # never fabricate; ask the user to disambiguate first


async def test_enrich_no_match_returns_none() -> None:
    async def search(query: str, year: int | None) -> dict[str, Any]:
        return {"matchConfidence": "none", "results": []}

    result = await enrich_movie("zzznope", None, search=search, details=_details_matrix)
    assert result.confidence == "none"
    assert result.candidate is None


# ── curator node ─────────────────────────────────────────────────────────────

def _state(text: str) -> dict[str, Any]:
    return {"messages": [HumanMessage(content=text)]}


async def test_curator_exact_emits_render_movie_card_and_carries_candidate() -> None:
    node = build_curator(
        extract=lambda _m: {"title": "The Matrix", "year": 1999},
        search=_search_exact,
        details=_details_matrix,
    )
    out = await node(_state("add The Matrix"))
    assert out["match_confidence"] == "exact"
    assert out["candidate"].title == "The Matrix"
    props = _render_call(out["messages"])
    assert props is not None
    assert props["title"] == "The Matrix"
    assert props["year"] == 1999
    assert props["source"] == "tmdb"


async def test_curator_carries_target_collection_name_from_extraction() -> None:
    # The extracted target collection must flow to the organizer (state.target_collection_name);
    # without this the spoken "to <collection>" is dropped and the organizer can't resolve it.
    node = build_curator(
        extract=lambda _m: {"title": "The Matrix", "year": 1999, "collection": "Sci-Fi"},
        search=_search_exact,
        details=_details_matrix,
    )
    out = await node(_state("add The Matrix to Sci-Fi"))
    assert out["target_collection_name"] == "Sci-Fi"


async def test_curator_preserves_existing_target_collection_when_reply_omits_it() -> None:
    # On a disambiguation reply (title only, no collection named), the curator must keep the
    # collection captured on the original "add ... to <collection>" turn — else the target is lost.
    node = build_curator(
        extract=lambda _m: {"title": "The Matrix", "year": 1999, "collection": None},
        search=_search_exact,
        details=_details_matrix,
    )
    state = {
        "messages": [HumanMessage(content="The Matrix (1999)")],
        "target_collection_name": "my collection",
    }
    out = await node(state)
    assert out["target_collection_name"] == "my collection"


async def test_curator_ambiguous_asks_to_clarify_without_candidate() -> None:
    async def search(query: str, year: int | None) -> dict[str, Any]:
        return {"matchConfidence": "ambiguous", "results": [
            {"sourceId": "tmdb:1", "title": "A", "year": 1999},
            {"sourceId": "tmdb:2", "title": "B", "year": 2003},
        ]}

    node = build_curator(
        extract=lambda _m: {"title": "A", "year": None},
        search=search,
        details=_details_matrix,
    )
    out = await node(_state("add A"))
    assert out["match_confidence"] == "ambiguous"
    assert out["candidate"] is None
    assert _render_call(out["messages"]) is None  # no preview emitted for an unresolved match
    assert any(isinstance(m, AIMessage) for m in out["messages"])


async def test_curator_no_match_says_so_without_candidate() -> None:
    async def search(query: str, year: int | None) -> dict[str, Any]:
        return {"matchConfidence": "none", "results": []}

    node = build_curator(
        extract=lambda _m: {"title": "zzznope", "year": None},
        search=search,
        details=_details_matrix,
    )
    out = await node(_state("add zzznope"))
    assert out["match_confidence"] == "none"
    assert out["candidate"] is None
    assert _render_call(out["messages"]) is None


def test_enrich_result_is_a_dataclass_with_expected_fields() -> None:
    r = EnrichResult(confidence="none", candidate=None, options=[])
    assert r.confidence == "none" and r.candidate is None and r.options == []
