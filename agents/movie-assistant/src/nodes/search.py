"""Search node: the unified movie-search workflow (013 US7, FR-021–FR-031).

ONE conversational resolution path for any search-style movie prompt ("show me / find / search /
open / go to <movie>"), replacing the prior split query(find) + navigator(movie) handling for
those prompts. Fixes Bug 1 (a generic "my collection" now resolves to the current/default/only
collection instead of summing across all) and Bug 2 (multiple matches DISAMBIGUATE with buttons
instead of opening the first).

Multi-turn via a PURE-CODE state machine (mirrors the T069 add state machine — picks resolved in
code, so the only golden surface is the supervisor intent label, not this node). Button taps post
canonical tokens that re-enter the node and advance `search_stage`:

    ""                     fresh search — extract title, resolve collection, run owned search
    "awaiting_scope"       >1 collection, none resolvable — pick "a collection" / "the web"
    "awaiting_collection"  pick which collection to search
    "awaiting_pick"        results shown — pick a result, or a control button

Collection resolution (pure code, Bug 1): named → current-screen (ui_snapshot) → default → only;
else (>1, none) scope buttons. Zero collections → straight to web search (AC5).

Title extraction is PURE CODE (strip lead verb + trailing collection clause) — so the assistant
never injects an article it wasn't given (Bug 3a) and there is no extraction golden kind. Owned
matching is article-insensitive (US8, `text_match`). Owned pick → `navigate_to_movie` (AC8); web
pick → a TMDB preview card (US10, AC10). "exit search" leaves the workflow (AC11).

Reads return only the user's OWN data (downscoped token), so a navigate target is reachable by
construction (FR-030 / DAC parity). `build_search_node(list_collections, list_movies, web_search)`
is the seam: all three are async closures over `invoke_tool` in production (stubs in tests).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

from langchain_core.messages import AIMessage

from src.nodes.organizer import (
    _GENERIC_TARGETS,
    _last_user_text,
    _resolve_current_collection,
)
from src.nodes.supervisor import resolve_option
from src.proposals import tmdb_movie_url
from src.text_match import normalize_title, titles_match
from src.tools.generative_ui_tools import (
    RENDER_MOVIE_CARD,
    RENDER_SELECTION,
    render_selection,
)
from src.tools.ui_action_tools import NAVIGATE_TO_MOVIE, navigate_to_movie

ListCollectionsFn = Callable[[], Awaitable[list[dict[str, Any]]]]
# Owned search: (collection_id, search_term) → the matching movies (first page is enough — the
# search filter is applied server-side; the node post-filters article-insensitively).
ListMoviesFn = Callable[[str, str], Awaitable[list[dict[str, Any]]]]
# Web search: (query, year) → { results: [{title, year, sourceId, posterUrl, overview}], ... }.
WebSearchFn = Callable[[str, int | None], Awaitable[dict[str, Any]]]

# ── canonical control/scope tokens (button `value`s; also accepted typed) ──────────────────
SCOPE_A_COLLECTION = "search a collection"
SCOPE_THE_WEB = "search the web"
CTRL_ANOTHER = "search another collection"
CTRL_EXIT = "exit search"

# How many result/collection buttons the client shows before "view more" (US4 cap; client-side).
_BUTTON_CAP = 5

# Clears the search workflow (terminal turns: navigate / web card / exit / scope→collection list).
_SEARCH_RESET: dict[str, Any] = {
    "search_stage": "",
    "search_scope": "",
    "search_query": "",
    "search_results": [],
}
# A search turn is unrelated to any in-progress add — clear that lifecycle too (mirrors navigator).
_LIFECYCLE_RESET = {"pending_proposal": None, "add_stage": "", "resolved_pick": None}

# Lead search verbs stripped to isolate the title (pure, article-safe — never injects "the").
# Includes existence lead-ins ("do I have / do I own / have I got / is / are there <X>") so an
# existence question routed here (013 Inc5 concern: "do I have X" => search, not query) isolates
# the title rather than searching the literal phrase.
_SEARCH_VERB_RE = re.compile(
    r"^\s*(?:please\s+)?(?:can you\s+|could you\s+)?"
    r"(?:do (?:i|you|we) (?:have|own)|have (?:i|we) got|are there(?: any)?|is|"
    r"show me|show|find me|find|search for|search|look up|look for|"
    r"open|go to|navigate to|take me to|pull up|bring up|get me)\s+",
    re.IGNORECASE,
)
# Trailing "… in my <Name> collection/list" → a NAMED collection scope.
_CLAUSE_NAMED_RE = re.compile(
    r"\s+(?:in|from|within|inside)\s+(?:my\s+|the\s+|our\s+)?"
    r"(?P<ref>[\w][\w\s'&-]*?)\s+(?:collection|list)\s*$",
    re.IGNORECASE,
)
# Trailing "… in my collection / this collection / here / this" → a GENERIC/current scope.
_CLAUSE_GENERIC_RE = re.compile(
    r"\s+(?:in|from|within|inside)?\s*"
    r"(?:my\s+collections?|my\s+list|the\s+collection|this\s+collection|this|here|current)\s*$",
    re.IGNORECASE,
)
_TRAILING_YEAR_RE = re.compile(r"\s*\(?\b((?:19|20)\d{2})\b\)?\s*$")


def _extract_search(text: str) -> dict[str, Any]:
    """Pull `{title, collection_ref, current, year}` from a search prompt — PURE CODE.

    Strips a leading search verb and a trailing "in <…> collection" clause; the remainder is the
    title, echoed VERBATIM (no article ever prepended — Bug 3a). `current` is set when the clause
    referenced this/here/current; `collection_ref` is a named collection, else "".
    """
    s = _SEARCH_VERB_RE.sub("", text or "", count=1).strip()
    ref = ""
    current = False
    named = _CLAUSE_NAMED_RE.search(s)
    if named:
        ref = named.group("ref").strip()
        # "this/here/current collection" is the CURRENT screen, not a collection literally named
        # "this" — route it to current-screen resolution (Bug 1 / FR-029).
        if ref.casefold() in {"this", "here", "current"}:
            current = True
            ref = ""
        s = s[: named.start()].strip()
    else:
        generic = _CLAUSE_GENERIC_RE.search(s)
        if generic:
            current = bool(re.search(r"\b(?:this|here|current)\b", generic.group(0), re.IGNORECASE))
            s = s[: generic.start()].strip()
    year: int | None = None
    ym = _TRAILING_YEAR_RE.search(s)
    if ym:
        year = int(ym.group(1))
        s = s[: ym.start()].strip()
    title = s.strip().strip('"').strip()
    return {"title": title, "collection_ref": ref, "current": current, "year": year}


def _resolve_scope_collection(
    extraction: dict[str, Any], ui_snapshot: Any, collections: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Resolve the collection to search (Bug 1): named → current-screen → default → only, else None.

    None means >1 collection and none resolvable → the caller offers scope buttons (AC4). Never
    sums across collections.
    """
    ref = str(extraction.get("collection_ref") or "").casefold().strip()
    named = bool(ref and ref not in _GENERIC_TARGETS)
    if named:
        exact = [c for c in collections if str(c.get("name", "")).casefold() == ref]
        if len(exact) == 1:
            return exact[0]
        partial = [
            c
            for c in collections
            if (n := str(c.get("name", "")).casefold()) and len(n) >= 2 and n in ref
        ]
        if len(partial) == 1:
            return partial[0]

    # No explicitly NAMED collection → prefer the ON-SCREEN collection (Bug 1). This applies for
    # ANY bare search ("look up X"), not only an explicit "this/here/current": a search run while
    # viewing a collection targets THAT collection, not the default. A named-but-unresolved ref is
    # NOT redirected to the current screen (it falls through to default/only/None below).
    if not named:
        current = _resolve_current_collection(ui_snapshot, collections)
        if current is not None:
            return next(
                (c for c in collections if str(c.get("collectionId")) == current.collection_id),
                None,
            )

    default = next((c for c in collections if c.get("isDefault")), None)
    if default is not None:
        return default
    if len(collections) == 1:
        return collections[0]
    return None


async def _owned_matches(
    title: str, collection_id: str, list_movies: ListMoviesFn
) -> list[dict[str, Any]]:
    """The user's movies in `collection_id` matching `title`, article-insensitively (US8)."""
    term = normalize_title(title) or title
    items = await list_movies(collection_id, term)
    return [m for m in items if titles_match(title, str(m.get("title", "")))]


def _result_label(item: dict[str, Any]) -> str:
    title = str(item.get("title") or "")
    year = item.get("year")
    return f"{title} ({year})" if year else title


def _result_options(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One selectable `movie` button per result; the tap posts the canonical "Title (Year)"."""
    return [
        {"label": _result_label(r), "value": _result_label(r), "kind": "movie"} for r in results
    ]


def _control_options(*, on_web: bool) -> list[dict[str, Any]]:
    """The workflow control buttons offered alongside results / on no results (AC6/AC9/AC11)."""
    if on_web:
        return [
            {"label": "Search a collection", "value": SCOPE_A_COLLECTION, "kind": "control"},
            {"label": "Exit search", "value": CTRL_EXIT, "kind": "control"},
        ]
    return [
        {"label": "Search another collection", "value": CTRL_ANOTHER, "kind": "control"},
        {"label": "Search the web", "value": SCOPE_THE_WEB, "kind": "control"},
        {"label": "Exit search", "value": CTRL_EXIT, "kind": "control"},
    ]


def _selection(
    content: str, options: list[dict[str, Any]], *, call_id: str, **state: Any
) -> dict[str, Any]:
    """An assistant turn carrying a `render_selection` tool call + the advanced search state."""
    return {
        **_LIFECYCLE_RESET,
        **state,
        "messages": [
            AIMessage(
                content=content,
                tool_calls=[
                    {"name": RENDER_SELECTION, "args": render_selection(options), "id": call_id}
                ],
            )
        ],
    }


def _navigate(collection_id: str, movie: dict[str, Any]) -> dict[str, Any]:
    """Terminal: open the resolved owned movie (AC8) + clear the workflow."""
    mid = str(movie.get("movieId") or "")
    return {
        **_LIFECYCLE_RESET,
        **_SEARCH_RESET,
        "messages": [
            AIMessage(
                content=f'Opening "{movie.get("title")}".',
                tool_calls=[
                    {
                        "name": NAVIGATE_TO_MOVIE,
                        "args": navigate_to_movie(collection_id, mid),
                        "id": f"search-nav-{collection_id}-{mid}",
                    }
                ],
            )
        ],
    }


def _web_card_props(result: dict[str, Any]) -> dict[str, Any]:
    """render_movie_card props for a TMDB web result — read-only preview + US10 url + add (AC10).

    `addCollectionId`/`addCollectionName` carry the collection the search was scoped to (013 Inc5
    Bug 1) so the card's "add to collection" targets THAT collection — not the user's default. They
    ride on the stored result (`addCollectionId`/`addCollectionName` keys) so a multi-result pick
    preserves them; absent ⇒ null (the add falls back to default/create).
    """
    source_id = str(result.get("sourceId") or "")
    return {
        "movieId": None,
        "collectionId": None,
        "title": str(result.get("title") or ""),
        "year": result.get("year"),
        "posterUrl": result.get("posterUrl"),
        "genres": list(result.get("genres") or []),
        "overview": str(result.get("overview") or ""),
        "source": "tmdb",
        "proposalItemId": None,
        "url": tmdb_movie_url(source_id),
        "addable": True,
        "addCollectionId": str(result.get("addCollectionId") or "") or None,
        "addCollectionName": str(result.get("addCollectionName") or "") or None,
    }


def _web_card(result: dict[str, Any]) -> dict[str, Any]:
    """Terminal: a read-only TMDB preview card (never auto-adds) + clear the workflow (AC10)."""
    return {
        **_LIFECYCLE_RESET,
        **_SEARCH_RESET,
        "messages": [
            AIMessage(
                content=f'Here\'s "{result.get("title")}" from TMDB. '
                "You can open it on TMDB or add it to a collection.",
                tool_calls=[
                    {
                        "name": RENDER_MOVIE_CARD,
                        "args": _web_card_props(result),
                        "id": f"search-web-{result.get('sourceId')}",
                    }
                ],
            )
        ],
    }


def _add_target_fields(add_target: dict[str, Any] | None) -> dict[str, Any]:
    """The `addCollectionId`/`addCollectionName` to stamp on web results from a scoped collection.

    Absent ⇒ both null (the card's add falls back to the user's default collection / create).
    """
    if not add_target:
        return {"addCollectionId": None, "addCollectionName": None}
    return {
        "addCollectionId": str(add_target.get("collectionId") or "") or None,
        "addCollectionName": str(add_target.get("name") or "") or None,
    }


def _exit() -> dict[str, Any]:
    return {
        **_LIFECYCLE_RESET,
        **_SEARCH_RESET,
        "messages": [AIMessage(content="Okay — exited search.")],
    }


def _scope_buttons(query: str) -> dict[str, Any]:
    """>1 collection, none resolvable → ask where to search (AC4)."""
    return _selection(
        f'Where should I look for "{query}"?',
        [
            {"label": "Search a collection", "value": SCOPE_A_COLLECTION, "kind": "scope"},
            {"label": "Search the web", "value": SCOPE_THE_WEB, "kind": "scope"},
        ],
        call_id="search-scope",
        search_stage="awaiting_scope",
        search_query=query,
        search_results=[],
    )


def _collection_buttons(query: str, collections: list[dict[str, Any]]) -> dict[str, Any]:
    """Offer the user's collections as buttons (AC5); the client caps at 5 + view more."""
    options = [
        {"label": str(c.get("name") or ""), "value": str(c.get("name") or ""), "kind": "collection"}
        for c in collections
        if c.get("name")
    ]
    return _selection(
        "Which collection should I search?",
        options,
        call_id="search-collections",
        search_stage="awaiting_collection",
        search_query=query,
        search_results=[],
    )


def build_search_node(
    *,
    list_collections: ListCollectionsFn,
    list_movies: ListMoviesFn,
    web_search: WebSearchFn,
) -> Any:
    """Build the unified search node from injected downscoped reads (movie-mcp) + web search."""

    async def _run_owned(
        query: str, collection: dict[str, Any]
    ) -> dict[str, Any]:
        cid = str(collection["collectionId"])
        name = str(collection.get("name") or "your collection")
        matches = await _owned_matches(query, cid, list_movies)
        if not matches:
            return _selection(
                f'I couldn\'t find "{query}" in your "{name}" collection. '
                "Want to look elsewhere?",
                _control_options(on_web=False),
                call_id="search-none",
                search_stage="awaiting_pick",
                search_scope=cid,
                search_query=query,
                search_results=[],
            )
        # New Scope 1: ANY owned result(s) — even exactly one — are offered as buttons (+ the
        # control buttons) so the user chooses to open one or search elsewhere; never auto-navigate
        # (the navigation happens only when the user taps a result, in the awaiting_pick handler).
        results = [
            {
                "title": str(m.get("title") or ""),
                "year": m.get("year"),
                "collectionId": cid,
                "movieId": str(m.get("movieId") or ""),
                "kind": "owned",
            }
            for m in matches
        ]
        listed = ", ".join(_result_label(r) for r in results[:_BUTTON_CAP])
        prompt = (
            f'I found "{listed}" in "{name}". Open it, or search elsewhere?'
            if len(results) == 1
            else f'I found a few matches for "{query}" in "{name}": {listed}. Which one?'
        )
        return _selection(
            prompt,
            _result_options(results) + _control_options(on_web=False),
            call_id="search-pick",
            search_stage="awaiting_pick",
            search_scope=cid,
            search_query=query,
            search_results=results,
        )

    async def _run_web(
        query: str, year: int | None = None, *, add_target: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        # `add_target` is the collection the search was scoped to (013 Inc5 Bug 1); it is stamped
        # onto every web result so the preview card's "add to collection" targets it.
        add_fields = _add_target_fields(add_target)
        out = await web_search(query, year)
        results = list(out.get("results") or []) if isinstance(out, dict) else []
        if not results:
            return _selection(
                f'I couldn\'t find "{query}" on TMDB either. What next?',
                _control_options(on_web=True),
                call_id="search-web-none",
                search_stage="awaiting_pick",
                search_scope="web",
                search_query=query,
                search_results=[],
            )
        if len(results) == 1:
            return _web_card({**results[0], **add_fields})
        stored = [
            {
                "title": str(r.get("title") or ""),
                "year": r.get("year"),
                "sourceId": str(r.get("sourceId") or ""),
                "posterUrl": r.get("posterUrl"),
                "overview": str(r.get("overview") or ""),
                "kind": "web",
                **add_fields,
            }
            for r in results
        ]
        listed = ", ".join(_result_label(r) for r in stored[:_BUTTON_CAP])
        return _selection(
            f'TMDB has a few matches for "{query}": {listed}. Which one?',
            _result_options(stored) + _control_options(on_web=True),
            call_id="search-web-pick",
            search_stage="awaiting_pick",
            search_scope="web",
            search_query=query,
            search_results=stored,
        )

    async def search(state: dict[str, Any]) -> dict[str, Any]:
        text = _last_user_text(state.get("messages", []))
        stage = str(state.get("search_stage") or "")
        query = str(state.get("search_query") or "")
        low = text.casefold().strip()

        # Universal controls (valid in any continuation stage).
        if stage and (CTRL_EXIT in low or low in {"exit", "cancel", "never mind", "nevermind"}):
            return _exit()

        if stage == "awaiting_scope":
            if "web" in low:
                return await _run_web(query)
            if "collection" in low or low == "a collection":
                collections = await list_collections()
                return _collection_buttons(query, collections)
            return _scope_buttons(query)

        if stage == "awaiting_collection":
            collections = await list_collections()
            chosen = next(
                (c for c in collections if str(c.get("name", "")).casefold() == low), None
            ) or next(
                (
                    c
                    for c in collections
                    if (n := str(c.get("name", "")).casefold()) and len(n) >= 2 and n in low
                ),
                None,
            )
            if chosen is not None:
                return await _run_owned(query, chosen)
            return _collection_buttons(query, collections)

        if stage == "awaiting_pick":
            if low in {SCOPE_THE_WEB, "the web", "web"}:
                # Going to the web AFTER searching a specific collection → carry that collection as
                # the add target so the preview card adds to it, not the default (013 Inc5 Bug 1).
                scope_cid = str(state.get("search_scope") or "")
                add_target: dict[str, Any] | None = None
                if scope_cid and scope_cid != "web":
                    add_target = next(
                        (
                            c
                            for c in await list_collections()
                            if str(c.get("collectionId")) == scope_cid
                        ),
                        None,
                    )
                return await _run_web(query, add_target=add_target)
            if low in {CTRL_ANOTHER, SCOPE_A_COLLECTION, "another collection", "a collection"}:
                collections = await list_collections()
                return _collection_buttons(query, collections)
            results = list(state.get("search_results") or [])
            pick = resolve_option(text, results)
            if pick is not None:
                if pick.get("kind") == "web":
                    return _web_card(pick)
                return _navigate(str(pick.get("collectionId") or ""), pick)
            # Unresolvable reply → re-offer the same buttons (never guess).
            on_web = str(state.get("search_scope") or "") == "web"
            return _selection(
                "Sorry, I didn't catch which one. Please pick a button.",
                _result_options(results) + _control_options(on_web=on_web),
                call_id="search-repick",
                search_stage="awaiting_pick",
                search_scope=str(state.get("search_scope") or ""),
                search_query=query,
                search_results=results,
            )

        # ── fresh search (stage == "") ──────────────────────────────────────────────────────
        extraction = _extract_search(text)
        title = str(extraction.get("title") or "").strip()
        if not title:
            return {
                **_LIFECYCLE_RESET,
                **_SEARCH_RESET,
                "messages": [AIMessage(content="What movie would you like to search for?")],
            }
        collections = await list_collections()
        if not collections:  # AC5: nothing owned → straight to the web
            return await _run_web(title, extraction.get("year"))
        target = _resolve_scope_collection(extraction, state.get("ui_snapshot"), collections)
        if target is None:  # AC4: >1 collection, none resolvable → scope buttons
            return _scope_buttons(title)
        return await _run_owned(title, target)

    return search
