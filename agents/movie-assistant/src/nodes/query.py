"""Query node: answer COUNT/LIST questions about what is ALREADY in the user's collections (US4).

The supervisor routes a "query" intent ("how many sci-fi do I have", "what's in my Favorites",
"list my Sci-Fi movies") here. This node is READ-ONLY: it never writes and never reaches the
approval gate. It performs ONE LLM extraction (`{collection_ref, filter}`) and then resolves
everything else in PURE CODE — so the model decision is small, golden-gated (T071f), and the
collection/mode resolution carries no LLM ambiguity.

Two answer shapes, decided in pure code from the request + extraction:
  - **count** ("how many …") → `count_movies` → "You have N movie(s) …". "all my collections"
    sums each collection's server-side count.
  - **list** ("what's in …", "list my …") → `count_movies` + first `list_movies` page →
    render_collection_summary + the first titles + "showing N of <count>".

Locating ONE specific film ("do I have X", "find X", "open X") is the **search** node's job (013
Inc5 concern: query is count/list only; search owns all "find"). The supervisor routes those to
search, which locates + opens the movie (or disambiguates / offers a web fallback).

Reads only ever return the user's OWN collections/movies (downscoped `aud=mc-service` token), so
an answer can never describe a collection the user couldn't reach directly (FR-010/011/012a — DAC
parity). An unresolvable/ambiguous target asks the user to clarify rather than guessing (FR-014).

`build_query_node(list_collections, list_movies, count_movies, extract)` is the seam: the reads
are async closures over `invoke_tool` → movie-mcp in production (stubs in tests); `extract` is the
model-backed entity extraction (golden-gated). All resolution below it is pure.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from langchain_core.messages import AIMessage

from src.nodes.organizer import (
    _GENERIC_TARGETS,
    _last_user_text,
    _resolve_current_collection,
    references_current_screen,
)
from src.tools.generative_ui_tools import RENDER_COLLECTION_SUMMARY, render_collection_summary

if TYPE_CHECKING:
    from src.eval.cassette import ChatModel

ListCollectionsFn = Callable[[], Awaitable[list[dict[str, Any]]]]
# Query reads use the mc-service page/count shapes directly (unlike the organizer's flattened
# list): list_movies → { items, nextCursor }, count_movies → an int total.
ListMoviesPageFn = Callable[[str, dict[str, Any] | None], Awaitable[dict[str, Any]]]
CountMoviesFn = Callable[[str, dict[str, Any] | None], Awaitable[int]]
ExtractFn = Callable[[Sequence[Any]], dict[str, Any]]

# How many movie titles to spell out inline for a "list" answer before deferring to the count.
_LIST_DISPLAY_CAP = 10

# A reset that clears any in-progress add lifecycle (a query is an unrelated read turn). Mirrors
# the navigator so a stale add never leaks past a query (T069/R14, RC4).
_LIFECYCLE_RESET = {"pending_proposal": None, "add_stage": "", "resolved_pick": None}

# Pure linguistic signals (no LLM → no golden re-record): a COUNT question, and a request that
# spans ALL of the user's collections.
_COUNT_RE = re.compile(
    r"\bhow many\b|\bnumber of\b|\bhow much\b|\bcount\b|\btotal\b", re.IGNORECASE
)
_ALL_RE = re.compile(
    r"\ball (?:of )?my collections\b|\bacross (?:all )?(?:my )?collections\b"
    r"|\ball collections\b|\bin total\b|\baltogether\b",
    re.IGNORECASE,
)


def extract_query(model: ChatModel, messages: Sequence[Any]) -> dict[str, Any]:
    """Pull `{collection_ref, filter}` from a collection count/list question (US4).

    `collection_ref` is the named collection (or "this"/"all" when the user said so, else null);
    `filter` captures any genre/decade/owned/language constraint. The query node answers only
    COUNT and LIST questions — locating a specific film ("do I have X") is the search node's job
    (013 Inc5 concern), so no movie title is extracted here. Defensive `null`-ish default on any
    parse failure so the node resolves to the default collection / clarifies rather than inventing
    a filter. Pure w.r.t. the model: injected (T071e/T071f, golden-gated).
    """
    last = messages[-1].content if messages else ""
    prompt = (
        "Extract what the user is asking about their OWN movie collection.\n"
        'Reply with ONLY JSON: {"collection_ref": string|null, '
        '"filter": {"genre": string|null, "decade": number|null, "owned": boolean|null, '
        '"language": string|null}}. No prose.\n'
        '"collection_ref": the collection they named (or "this" if they said this/here/current, '
        'or "all" if they asked across all their collections), else null.\n'
        '"filter.genre": a genre they constrained to (e.g. "comedy"), else null.\n'
        '"filter.decade": a decade as a 4-digit year (the 1990s => 1990), else null.\n'
        '"filter.owned": true ONLY if they explicitly ask about movies they OWN / have on '
        "physical media (DVD/Blu-ray), else null.\n"
        '"filter.language": a spoken language they constrained to, else null.\n'
        f"Request: {last}"
    )
    try:
        parsed = dict(json.loads(str(model.invoke(prompt).content)))
    except (ValueError, TypeError):
        return {"collection_ref": None, "filter": {}}
    parsed.setdefault("filter", {})
    return parsed


def _map_filter(raw: Any) -> dict[str, Any]:
    """Map an extracted `filter` to mc-service movie query params (genre/decade/owned/language).

    Only well-typed, present constraints pass through — anything missing or malformed is dropped
    (an over-eager filter would silently undercount). `decade` accepts 1990 or "1990s"/"90s".
    """
    out: dict[str, Any] = {}
    if not isinstance(raw, Mapping):
        return out
    genre = raw.get("genre")
    if isinstance(genre, str) and genre.strip():
        out["genre"] = genre.strip()
    decade = _coerce_decade(raw.get("decade"))
    if decade is not None:
        out["decade"] = decade
    if isinstance(raw.get("owned"), bool):
        out["owned"] = raw["owned"]
    language = raw.get("language")
    if isinstance(language, str) and language.strip():
        out["language"] = language.strip()
    return out


def _coerce_decade(value: Any) -> int | None:
    """Coerce a decade hint (1990, "1990s", "90s") to a 4-digit decade int, or None."""
    if isinstance(value, bool):  # bool is an int subclass — exclude it explicitly
        return None
    if isinstance(value, int):
        return value if 1900 <= value <= 2100 else None
    if isinstance(value, str):
        digits = value.strip().lower().rstrip("s")
        if digits.isdigit():
            year = int(digits)
            if year < 100:  # "90s" → 1990
                year += 1900
            return year if 1900 <= year <= 2100 else None
    return None


def _resolve_query_collection(
    collection_ref: str, text: str, ui_snapshot: Any, collections: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Resolve the target collection for a single-collection query (else None → clarify).

    Order: current-screen ("this"/"here") via the ui_snapshot → an exact then substring name
    match → the user's default collection (FR-005b) for a generic/empty ref. Returns None when
    nothing resolves so the node asks rather than guessing (FR-014).
    """
    if references_current_screen(collection_ref) or (
        not collection_ref and references_current_screen(text)
    ):
        current = _resolve_current_collection(ui_snapshot, collections)
        if current is not None:
            return next(
                (c for c in collections if str(c.get("collectionId")) == current.collection_id),
                None,
            )

    name = str(collection_ref or "").casefold().strip()
    if name and name not in _GENERIC_TARGETS:
        exact = [c for c in collections if str(c.get("name", "")).casefold() == name]
        if len(exact) == 1:
            return exact[0]
        partial = [
            c
            for c in collections
            if (n := str(c.get("name", "")).casefold()) and len(n) >= 2 and n in name
        ]
        if len(partial) == 1:
            return partial[0]

    # Generic/empty ref → the user's default collection (FR-005b); none → clarify.
    return next((c for c in collections if c.get("isDefault")), None)


def _references_all(collection_ref: str, text: str) -> bool:
    """Whether the question spans ALL the user's collections (sum the per-collection counts)."""
    return collection_ref.strip().casefold() == "all" or bool(_ALL_RE.search(text or ""))


def _describe_filter(filt: dict[str, Any]) -> str:
    """A short human phrase for the active filter (" in the Sci-Fi genre …"), or "" if none."""
    parts: list[str] = []
    if filt.get("genre"):
        parts.append(f'in the {filt["genre"]} genre')
    if filt.get("decade"):
        parts.append(f'from the {filt["decade"]}s')
    if filt.get("owned") is True:
        parts.append("you own")
    if filt.get("language"):
        parts.append(f'in {filt["language"]}')
    return (" " + " and ".join(parts)) if parts else ""


def _reply(content: str, *, tool_calls: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    message = AIMessage(content=content, tool_calls=tool_calls or [])
    return {**_LIFECYCLE_RESET, "messages": [message]}


def _clarify(collections: list[dict[str, Any]]) -> dict[str, Any]:
    names = ", ".join(str(c.get("name", "")) for c in collections if c.get("name"))
    listing = f" You have: {names}." if names else ""
    return _reply(f"Which collection do you mean?{listing}")


def build_query_node(
    *,
    list_collections: ListCollectionsFn,
    list_movies: ListMoviesPageFn,
    count_movies: CountMoviesFn,
    extract: ExtractFn,
) -> Any:
    """Build the read-only query node from injected downscoped reads + model extraction."""

    async def query(state: dict[str, Any]) -> dict[str, Any]:
        text = _last_user_text(state.get("messages", []))
        try:
            extraction = extract(state.get("messages", []))
        except Exception:  # noqa: BLE001 — any model/provider failure degrades gracefully
            return _reply("Sorry — I couldn't complete that just now. Please try again.")

        collection_ref = str(extraction.get("collection_ref") or "").strip()
        filt = _map_filter(extraction.get("filter"))
        collections = await list_collections()

        # "How many … across all my collections" → sum each collection's server-side count.
        if _references_all(collection_ref, text):
            total = 0
            for collection in collections:
                total += await count_movies(str(collection["collectionId"]), filt)
            scope = _describe_filter(filt)
            return _reply(
                f"You have {total} movie(s){scope} across "
                f"{len(collections)} collection(s)."
            )

        target = _resolve_query_collection(
            collection_ref, text, state.get("ui_snapshot"), collections
        )
        if target is None:
            return _clarify(collections)
        cid = str(target["collectionId"])
        name = str(target.get("name") or "your collection")
        is_count = bool(_COUNT_RE.search(text or ""))

        count = await count_movies(cid, filt)
        scope = _describe_filter(filt)

        # COUNT — "how many …".
        if is_count:
            return _reply(f'You have {count} movie(s){scope} in your "{name}" collection.')

        # LIST — "what's in …" / "list my …": the count + the first page of titles.
        page = await list_movies(cid, filt)
        items = page.get("items", [])
        shown = items[:_LIST_DISPLAY_CAP]
        titles = ", ".join(str(m.get("title", "")) for m in shown if m.get("title"))
        more = f" (showing {len(shown)} of {count})" if count > len(shown) else ""
        listing = f" {titles}.{more}" if titles else ""
        summary = render_collection_summary({**target, "movieCount": count})
        return _reply(
            f'Your "{name}" collection has {count} movie(s){scope}:{listing}',
            tool_calls=[
                {"name": RENDER_COLLECTION_SUMMARY, "args": summary, "id": f"q-rcs-{cid}"}
            ],
        )

    return query
