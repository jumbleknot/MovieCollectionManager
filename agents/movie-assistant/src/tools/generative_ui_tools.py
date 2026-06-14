"""Generative-UI tools: return structured props only (client renders existing components).

Implements: T040 (render_movie_card), T052 (render_collection_summary, render_wishlist).
Contract: specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md.

These are PURE prop builders (no I/O, no token). A specialist node emits the result as an
AG-UI tool call (`render_*`) that the CopilotKit client maps to an existing Components-Layer
component via `useRenderTool` (universal web+mobile; no server-rendered UI). `proposal_item_id`
links a preview card to a pending ProposalItem so the approval UI can correlate them.
"""

from __future__ import annotations

from typing import Any

from src.proposals import EnrichedMovieCandidate

RENDER_MOVIE_CARD = "render_movie_card"
RENDER_COLLECTION_SUMMARY = "render_collection_summary"
RENDER_DISAMBIGUATION = "render_disambiguation"
RENDER_SELECTION = "render_selection"
REQUEST_IMPORT_FILE = "request_import_file"


def request_import_file(prompt: str = "") -> dict[str, Any]:
    """Build `request_import_file` props — the import node emits this when it has no staged file.

    The client renders a "Choose file…" + "Cancel" affordance (web-first); choosing uploads the
    file to the BFF and re-runs the import turn. So an import is started by the user TYPING the
    request (e.g. "import my movies"); the assistant then asks for the file — there is no always-on
    upload button (014 UX fix). Pure; carries no token and no file bytes.
    """
    return {"prompt": prompt or "Choose the spreadsheet you'd like to import."}

# The selectable-button kinds a `render_selection` option may carry (013 US7). `movie`/`collection`
# pick a result/scope; `scope`/`control` drive the workflow ("search the web", "exit search").
SELECTION_KINDS = frozenset({"movie", "collection", "scope", "control"})


def render_movie_card(
    candidate: EnrichedMovieCandidate,
    *,
    movie_id: str | None = None,
    collection_id: str | None = None,
    proposal_item_id: str | None = None,
    url: str | None = None,
    addable: bool = False,
) -> dict[str, Any]:
    """Build `render_movie_card` props from an EnrichedMovieCandidate (contract shape).

    `movie_id` + `collection_id` are set only for an in-collection movie (the client card then
    deep-links to /collections/<collection_id>/movies/<movie_id>); a look-up-only TMDB preview
    leaves them None so the client renders the card non-interactive (013 US3).

    013 US10: a web (`source="tmdb"`) preview card also carries `url` (the themoviedb.org link,
    FR-016 rule) rendered as a tappable source link, and `addable=True` to surface an "add to
    collection" affordance whose tap posts an add message into the existing approval-gated flow.
    """
    return {
        "movieId": movie_id,
        "collectionId": collection_id,
        "title": candidate.title,
        "year": candidate.year,
        "posterUrl": candidate.poster_url,
        "genres": list(candidate.genres),
        "overview": candidate.overview,
        "source": candidate.source,
        "proposalItemId": proposal_item_id,
        "url": url,
        "addable": addable,
    }


def render_selection(options: list[dict[str, Any]]) -> dict[str, Any]:
    """Build `render_selection` props — a generalized selectable-button list (013 US7, FR-024/026).

    Each option is `{ label, value, kind }`: `label` is the button text, `value` is the canonical
    command/title text a tap posts through the dock send path (so resolution stays pure code, no
    state mutation from the client), and `kind` ∈ SELECTION_KINDS keys the client styling. Pure;
    the client renders ≤5 buttons + a "view more" overflow (reuses the US4 disambiguation cap).
    Generalizes `render_disambiguation` (movie-only) to scope/collection/control buttons too.
    """
    out: list[dict[str, Any]] = []
    for opt in options:
        kind = str(opt.get("kind") or "control")
        out.append(
            {
                "label": str(opt.get("label") or ""),
                "value": str(opt.get("value") or ""),
                "kind": kind if kind in SELECTION_KINDS else "control",
            }
        )
    return {"options": out}


def render_disambiguation(options: list[dict[str, Any]]) -> dict[str, Any]:
    """Build `render_disambiguation` props from the curator's ambiguous-match options (013 US4).

    Pure: each option carries the title + year so the client can render one selectable button per
    candidate (label "<title> (<year>)") that, on tap, posts the SAME canonical disambiguator text
    the user could type. `sourceId` is forwarded for keying. The accompanying assistant text is the
    fallback for clients that don't render the tool. No change to how a pick is resolved
    (`resolve_option` reads the typed/echoed text in pure code).
    """
    return {
        "options": [
            {
                "title": str(o.get("title") or ""),
                "year": o.get("year"),
                "sourceId": str(o.get("sourceId") or ""),
            }
            for o in options
        ]
    }


def render_collection_summary(collection: dict[str, Any]) -> dict[str, Any]:
    """Build `render_collection_summary` props from an mc-service collection dict (contract shape).

    A "wishlist" renders here too — it is just a user-named collection (no distinct entity).
    Pure: derives only display fields; carries no token. `role` defaults to "owner" when the
    list endpoint omits it.
    """
    return {
        "collectionId": str(collection.get("collectionId") or ""),
        "name": str(collection.get("name") or ""),
        "movieCount": int(collection.get("movieCount") or 0),
        "role": str(collection.get("role") or "owner"),
    }
