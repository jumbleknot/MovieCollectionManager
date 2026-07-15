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

from src.nodes.organizer import _as_int, _last_user_text, references_current_screen
from src.proposals import EnrichedMovieCandidate, tmdb_movie_url
from src.tools.generative_ui_tools import (
    RENDER_DISAMBIGUATION,
    RENDER_MOVIE_CARD,
    render_disambiguation,
    render_movie_card,
)

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


def _unique_exact_match(
    query: str, year: int | None, results: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """A single result whose title EXACTLY (article-insensitively) matches `query` — and, when a
    year was given, whose year agrees (013 Inc5).

    Lets a specific request ("Back to the Future (1985)") resolve directly even when the search
    tool flags the set ambiguous because it also returned a SUPERSET title ("Looking Back to the
    Future…", same year). Returns None when zero or several results exact-match (truly ambiguous).
    """
    from src.text_match import normalize_title

    norm = normalize_title(query)
    if not norm:
        return None
    matches = [r for r in results if normalize_title(str(r.get("title", ""))) == norm]
    if year is not None:
        matches = [r for r in matches if _as_int(r.get("year")) == year]
    return matches[0] if len(matches) == 1 else None


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
        # An unambiguous EXACT (title, year) match among the candidates resolves directly — don't
        # send a specific request back through disambiguation (013 Inc5).
        exact = _unique_exact_match(query, year, list(results))
        if exact is None:
            return EnrichResult(confidence="ambiguous", candidate=None, options=list(results))
        detail = await details(exact["sourceId"])
        candidate = EnrichedMovieCandidate.model_validate({**detail, "matchConfidence": "exact"})
        return EnrichResult(confidence="exact", candidate=candidate)
    detail = await details(results[0]["sourceId"])
    candidate = EnrichedMovieCandidate.model_validate({**detail, "matchConfidence": "exact"})
    return EnrichResult(confidence="exact", candidate=candidate)


def build_curator(*, extract: ExtractFn, search: SearchFn, details: DetailsFn) -> Any:
    """Build the curator graph node from injected extraction + enrichment callables."""

    async def curator(state: dict[str, Any]) -> dict[str, Any]:
        messages = state.get("messages", [])
        # 040 US4: an ownership Yes/No reply for an already-resolved add — do NOT re-enrich (the
        # message is "yes"/"no", not a film). Pass through unchanged so the organizer parses the
        # answer and builds the proposal. route_after_curator sends it on (candidate is set).
        if str(state.get("add_stage") or "") == "awaiting_ownership" and state.get("candidate") is not None:
            return {}
        # Graceful degradation (T061/FR-018): a provider/reasoning failure in entity extraction
        # → a "couldn't complete" reply, never a crash. (The enrichment LOOKUP already degrades
        # via the tool dead-letter, T024a.) Clears any in-progress add via the reply.
        try:
            parsed = extract(messages)
        except Exception:  # noqa: BLE001 — any model/provider failure degrades gracefully
            return _reply(
                "Sorry — I couldn't complete that just now. Please try again.",
                confidence="none",
                target=str(state.get("target_collection_name") or ""),
            )
        # Prefer a freshly-named collection, else keep the one captured on the original
        # "add ... to <collection>" turn (a disambiguation reply names only the movie). The
        # target survives EVERY branch (T069/R14, RC2) — it is never dropped on a re-ask.
        target_collection = str(
            parsed.get("collection") or state.get("target_collection_name") or ""
        ).strip()
        # RC2 ("add <ambiguous> to this"): when the title is ambiguous the organizer (which
        # resolves "this" against the ui_snapshot) is never reached, so the curator normalizes a
        # current-screen reference to the canonical "this" marker here. It then survives the
        # disambiguation exactly like a named target, and the organizer resolves it once the film
        # is picked. Mirrors organizer._add's `target_is_current` guard so a real named target
        # (or a "this" that merely qualifies the movie, e.g. "add this Pirates movie to Favorites")
        # is never hijacked.
        if references_current_screen(target_collection) or (
            not target_collection and references_current_screen(_last_user_text(messages))
        ):
            target_collection = "this"
        stage = str(state.get("add_stage") or "")

        # Awaiting only the collection for an already-resolved movie (T069/R14): the reply names
        # the collection — thread it to the organizer; do NOT re-enrich (keep the candidate).
        # A reply that names a NEW film instead falls through to a fresh enrichment.
        if (
            stage == "awaiting_collection"
            and state.get("candidate") is not None
            and not parsed.get("title")
        ):
            last_text = str(getattr(messages[-1], "content", "") if messages else "").strip()
            name = str(parsed.get("collection") or last_text).strip()
            return {"target_collection_name": name, "add_stage": ""}

        # A disambiguation pick the supervisor already resolved (T069/R14, RC1): fetch details
        # for the chosen option directly — no re-search, no re-ambiguation.
        resolved = state.get("resolved_pick")
        if resolved:
            detail = await details(str(resolved["sourceId"]))
            candidate = EnrichedMovieCandidate.model_validate(
                {**detail, "matchConfidence": "exact"}
            )
            return _exact_result(candidate, target_collection)

        title = str(parsed.get("title") or "").strip()
        year = parsed.get("year")

        if not title:
            # An unresolvable reply while offering options → re-offer the same options rather
            # than dropping the pending pick (T069/R14, RC1).
            if stage == "awaiting_pick" and state.get("options"):
                options = list(state["options"])
                names = ", ".join(f"{o.get('title')} ({o.get('year')})" for o in options[:5])
                return _reply(
                    f"I'm not sure which one you mean. The matches are: {names}. "
                    "You can say the title, the year, or e.g. \"the first one\".",
                    confidence="ambiguous",
                    options=options,
                    target=target_collection,
                    stage="awaiting_pick",
                )
            return _reply(
                "What movie would you like me to look up?",
                confidence="none",
                target=target_collection,
            )

        result = await enrich_movie(title, year, search=search, details=details)

        if result.confidence == "none":
            return _reply(
                f'I couldn\'t find a movie called "{title}". Could you check the title?',
                confidence="none",
                target=target_collection,
            )
        if result.confidence == "ambiguous":
            names = ", ".join(f"{o.get('title')} ({o.get('year')})" for o in result.options[:5])
            return _reply(
                f'I found a few matches for "{title}": {names}. Which did you mean?',
                confidence="ambiguous",
                options=result.options,
                target=target_collection,
                stage="awaiting_pick",
            )

        assert result.candidate is not None  # exact ⇒ candidate present
        return _exact_result(result.candidate, target_collection)

    return curator


def _exact_result(candidate: EnrichedMovieCandidate, target_collection: str) -> dict[str, Any]:
    """A resolved single film: emit the preview + carry the candidate/target to the organizer,
    clearing the disambiguation lifecycle (T069/R14).

    013 Bug 2: a TMDB-sourced preview carries the clickable themoviedb.org link (FR-016) so a
    "look up X" enrich preview shows a tappable source link — parity with the search web card. A
    non-tmdb (library) candidate yields no url (never a malformed link)."""
    props = render_movie_card(candidate, url=tmdb_movie_url(candidate.source_id))
    message = AIMessage(
        content=f"I found {candidate.title} ({candidate.year}). Here's a preview:",
        tool_calls=[{"name": RENDER_MOVIE_CARD, "args": props, "id": f"rmc-{candidate.source_id}"}],
    )
    return {
        "messages": [message],
        "candidate": candidate,
        "match_confidence": "exact",
        "target_collection_name": target_collection,
        "options": [],
        "add_stage": "",
        "resolved_pick": None,
    }


def _reply(
    text: str,
    *,
    confidence: str,
    options: list[dict[str, Any]] | None = None,
    target: str = "",
    stage: str = "",
) -> dict[str, Any]:
    # 013 US4: when offering ambiguous matches, also emit a render_disambiguation tool call so the
    # client renders selectable buttons (text above is the fallback). Picks resolve unchanged.
    tool_calls: list[dict[str, Any]] = []
    if options:
        tool_calls = [
            {
                "name": RENDER_DISAMBIGUATION,
                "args": render_disambiguation(options),
                "id": f"rdis-{options[0].get('sourceId') or '0'}",
            }
        ]
    out: dict[str, Any] = {
        "messages": [AIMessage(content=text, tool_calls=tool_calls)],
        "candidate": None,
        "match_confidence": confidence,
        # Preserve the spoken target across re-asks (RC2) and set the lifecycle stage (RC1).
        "target_collection_name": target,
        "add_stage": stage,
    }
    if options is not None:
        out["options"] = options
    return out
