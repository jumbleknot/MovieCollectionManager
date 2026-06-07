"""Curator node: discover + enrich movie metadata; propose additions (T039, US1).

Tool allowlist: web-api-mcp (read-only) + movie-mcp reads — enforced by `invoke_tool` at the
gateway, not here. Enrichment is orchestrated in CODE (search → details), not LLM tool-calling,
so it is deterministic and the LLM is used only to (a) extract the title/year from the request
and (b) phrase the reply. The curator NEVER writes; on an exact match it emits a
`render_movie_card` preview and carries the EnrichedMovieCandidate forward for the organizer
to turn into an HITL-gated proposal. Match confidence is honoured (FR): ambiguous → offer
options, none → say so — never fabricate metadata.

`build_curator(extract, search, details)` is the seam: `search`/`details` are async callables
(in production, closures over `invoke_tool` → web-api-mcp; in tests, mocks/real TMDB), and
`extract` maps the conversation to `{title, year}` (model-backed in production, stub in tests).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage

from src.proposals import EnrichedMovieCandidate
from src.tools.generative_ui_tools import RENDER_MOVIE_CARD, render_movie_card

if TYPE_CHECKING:
    from src.eval.cassette import ChatModel

SearchFn = Callable[[str, int | None], Awaitable[dict[str, Any]]]
DetailsFn = Callable[[str], Awaitable[dict[str, Any]]]
ExtractFn = Callable[[Sequence[Any]], dict[str, Any]]


def extract_entities(model: ChatModel, messages: Sequence[Any]) -> dict[str, Any]:
    """Pull {title, year, collection} from the latest request using the curator model.

    Returns {} defensively on any parse failure so the curator asks the user to clarify
    rather than fabricating a lookup. Pure w.r.t. the model: injected (T039/T032).
    """
    last = messages[-1].content if messages else ""
    prompt = (
        "Extract the movie the user wants to add/look up and the target collection.\n"
        'Reply with ONLY a JSON object: {"title": string|null, "year": number|null, '
        '"collection": string|null}. No prose.\n'
        f"Request: {last}"
    )
    try:
        return dict(json.loads(str(model.invoke(prompt).content)))
    except (ValueError, TypeError):
        return {}


@dataclass
class EnrichResult:
    """Outcome of enrichment: a confident candidate, options to disambiguate, or no match."""

    confidence: str  # "exact" | "ambiguous" | "none"
    candidate: EnrichedMovieCandidate | None
    options: list[dict[str, Any]] = field(default_factory=list)


async def enrich_movie(
    query: str, year: int | None, *, search: SearchFn, details: DetailsFn
) -> EnrichResult:
    """Search the external source, then (only on an exact match) fetch full details.

    Never fetches details for an ambiguous/none result — the assistant asks the user to
    disambiguate rather than inventing a match.
    """
    found = await search(query, year)
    confidence = found.get("matchConfidence", "none")
    results = found.get("results", [])
    if confidence == "none" or not results:
        return EnrichResult(confidence="none", candidate=None)
    if confidence == "ambiguous":
        return EnrichResult(confidence="ambiguous", candidate=None, options=list(results))
    detail = await details(results[0]["sourceId"])
    candidate = EnrichedMovieCandidate.model_validate({**detail, "matchConfidence": "exact"})
    return EnrichResult(confidence="exact", candidate=candidate)


def build_curator(*, extract: ExtractFn, search: SearchFn, details: DetailsFn) -> Any:
    """Build the curator graph node from injected extraction + enrichment callables."""

    async def curator(state: dict[str, Any]) -> dict[str, Any]:
        parsed = extract(state.get("messages", []))
        title = str(parsed.get("title") or "").strip()
        year = parsed.get("year")
        target_collection = str(parsed.get("collection") or "").strip()

        if not title:
            return _reply("What movie would you like me to look up?", confidence="none")

        result = await enrich_movie(title, year, search=search, details=details)

        if result.confidence == "none":
            return _reply(
                f'I couldn\'t find a movie called "{title}". Could you check the title?',
                confidence="none",
            )
        if result.confidence == "ambiguous":
            names = ", ".join(f"{o.get('title')} ({o.get('year')})" for o in result.options[:5])
            return _reply(
                f'I found a few matches for "{title}": {names}. Which did you mean?',
                confidence="ambiguous",
                options=result.options,
            )

        candidate = result.candidate
        assert candidate is not None  # exact ⇒ candidate present
        props = render_movie_card(candidate)
        message = AIMessage(
            content=f"I found {candidate.title} ({candidate.year}). Here's a preview:",
            tool_calls=[
                {"name": RENDER_MOVIE_CARD, "args": props, "id": f"rmc-{candidate.source_id}"}
            ],
        )
        return {
            "messages": [message],
            "candidate": candidate,
            "match_confidence": "exact",
            # Carry the spoken target collection forward so the organizer can resolve it
            # (create-if-missing when absent). Empty when the user named no collection.
            "target_collection_name": target_collection,
        }

    return curator


def _reply(
    text: str, *, confidence: str, options: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "messages": [AIMessage(content=text)],
        "candidate": None,
        "match_confidence": confidence,
    }
    if options is not None:
        out["options"] = options
    return out
