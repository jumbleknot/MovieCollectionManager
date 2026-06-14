"""Export-collection node: build a multi-tab `.xlsx` from the user's collections (US3, feature 014).

The PURE shapers here turn stored movies into `build_workbook`-ready tabs (one tab per selected
collection, one column per movie attribute, booleans Yes/No, multi-value attributes kept as lists
for the `|`-join, external ids expanded into the fixed IMDB/TMDB id+url columns). Header choices
mirror the import alias table (import_resolvers._ALIAS_TABLE / _EXTERNAL_ID_SOURCES) so an
export→import round-trip is lossless for the multi-value sets (SC-004).

The runtime wiring (reading collections/movies via movie-mcp, calling `build_workbook` via
spreadsheet-mcp, surfacing the download UI-action) lives in runtime_nodes._build_export_node and
composes these functions. Keeping the shaping pure makes it exhaustively unit-testable. Export is
read-only — it never routes through the HITL write gate.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

# Scalar movie attributes → export header (inverse of import_resolvers._ALIAS_TABLE).
_SCALAR_COLUMNS: tuple[tuple[str, str], ...] = (
    ("Title", "title"),
    ("Year", "year"),
    ("Video Type", "contentType"),
    ("Language", "language"),
    ("Original Title", "originalTitle"),
    ("Release Date", "releaseDate"),
    ("Runtime", "runtime"),
    ("MPAA", "rated"),
    ("Owned", "owned"),
    ("Ripped", "ripped"),
    ("Children's", "childrens"),
    ("Set", "movieSet"),
    ("Outline", "outline"),
    ("Plot", "plot"),
)

# Multi-value attributes → export header. Kept as lists in the row; `build_workbook` `|`-joins.
_MULTI_COLUMNS: tuple[tuple[str, str], ...] = (
    ("Directors", "directors"),
    ("Actors", "actors"),
    ("Genres", "genres"),
    ("Tags", "tags"),
    ("Media", "ownedMedia"),
    ("Rip Quality", "ripQuality"),
)

# externalIds → fixed (system, id-header, url-header) columns (inverse of the import sources).
_EXTERNAL_ID_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("IMDB", "IMDB Id", "IMDB URL"),
    ("TMDB", "TMDB Id", "TMDB URL"),
)

_BOOLEAN_ATTRIBUTES = frozenset({"owned", "ripped", "childrens"})

# The ordered export header list (FR-026) — scalars, then multi-values, then external ids.
EXPORT_COLUMNS: list[str] = (
    [header for header, _ in _SCALAR_COLUMNS]
    + [header for header, _ in _MULTI_COLUMNS]
    + [col for _, id_h, url_h in _EXTERNAL_ID_COLUMNS for col in (id_h, url_h)]
)


def movie_to_export_row(movie: dict[str, Any]) -> dict[str, Any]:
    """Render one stored movie into a `{header: cell}` row keyed by `EXPORT_COLUMNS`.

    Booleans → "Yes"/"No"; multi-value attributes → lists (empty when absent); external ids →
    their id/url columns; a missing attribute → "" (or [] for a multi-value column).
    """
    row: dict[str, Any] = {}

    for header, attribute in _SCALAR_COLUMNS:
        value = movie.get(attribute)
        if attribute in _BOOLEAN_ATTRIBUTES:
            row[header] = "" if value is None else ("Yes" if value else "No")
        else:
            row[header] = "" if value is None else value

    for header, attribute in _MULTI_COLUMNS:
        value = movie.get(attribute)
        row[header] = list(value) if isinstance(value, (list, tuple)) else []

    external_ids = movie.get("externalIds") or []
    by_system = {
        str(eid.get("system", "")).strip().upper(): eid
        for eid in external_ids
        if isinstance(eid, dict)
    }
    for system, id_header, url_header in _EXTERNAL_ID_COLUMNS:
        eid = by_system.get(system)
        row[id_header] = str(eid.get("uniqueId") or "") if eid else ""
        row[url_header] = str(eid.get("url") or "") if eid else ""

    return row


def build_export_tabs(
    collections: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Turn `[{collectionName, movies}]` into `build_workbook` tabs (one per collection).

    Every tab carries the full ordered `EXPORT_COLUMNS`; an empty collection yields a tab with
    no rows (a header-only sheet).
    """
    return [
        {
            "collectionName": str(entry.get("collectionName", "")),
            "columns": EXPORT_COLUMNS,
            "rows": [movie_to_export_row(movie) for movie in entry.get("movies", [])],
        }
        for entry in collections
    ]


def select_export_collections(
    requested_ids: Sequence[str], collections: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Resolve the user's multi-select to collection records (FR-024).

    An empty request means "all collections". Otherwise return the requested collections in the
    user's collection order (stable, de-duplicated); unknown ids are ignored.
    """
    if not requested_ids:
        return list(collections)
    wanted = {str(cid) for cid in requested_ids}
    return [c for c in collections if str(c.get("collectionId")) in wanted]
