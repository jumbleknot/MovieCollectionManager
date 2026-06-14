"""T045: unit matrix for the pure export shapers (US3, feature 014).

`export_collection.py` turns the user's stored movies into `build_workbook`-ready tabs — one
tab per collection, one column per movie attribute (excluding collection/user/ownership ids),
booleans rendered Yes/No, multi-value attributes kept as lists for the `|`-join, and external
ids expanded into the fixed IMDB/TMDB id+url columns. The header choices mirror the import alias
table so an export→import round-trip is lossless (SC-004).

Covers: US3-AC2/3/4, FR-025/026/027, SC-004.
"""

from __future__ import annotations

from src.nodes.export_collection import (
    EXPORT_COLUMNS,
    build_export_tabs,
    movie_to_export_row,
    select_export_collections,
)


def _movie(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "movieId": "m1",
        "collectionId": "c1",
        "title": "Dune",
        "year": 2021,
        "contentType": "Movie",
        "language": "English",
        "owned": True,
        "ripped": False,
        "childrens": False,
        "genres": ["Sci-Fi", "Adventure"],
        "directors": ["Denis Villeneuve"],
        "actors": ["Timothée Chalamet", "Zendaya"],
        "tags": [],
        "externalIds": [
            {"system": "IMDB", "uniqueId": "tt1160419", "url": "https://imdb.com/title/tt1160419"},
            {"system": "TMDB", "uniqueId": "438631", "url": "https://tmdb.org/movie/438631"},
        ],
    }
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# Column set (FR-026: one column per attribute, no id/ownership fields)
# ---------------------------------------------------------------------------


def test_columns_include_core_attributes_and_exclude_ids() -> None:
    for header in ("Title", "Year", "Video Type", "Language", "Genres", "Directors", "Set"):
        assert header in EXPORT_COLUMNS
    # Never export server-assigned identity / collection-membership fields.
    for forbidden in ("movieId", "collectionId", "ownerId", "acl", "Movie Id", "Collection Id"):
        assert forbidden not in EXPORT_COLUMNS


def test_external_id_columns_are_expanded() -> None:
    for header in ("IMDB Id", "IMDB URL", "TMDB Id", "TMDB URL"):
        assert header in EXPORT_COLUMNS


# ---------------------------------------------------------------------------
# Row rendering
# ---------------------------------------------------------------------------


def test_scalar_and_passthrough_cells() -> None:
    row = movie_to_export_row(_movie())
    assert row["Title"] == "Dune"
    assert row["Year"] == 2021
    assert row["Video Type"] == "Movie"
    assert row["Language"] == "English"


def test_booleans_render_yes_no() -> None:
    row = movie_to_export_row(_movie(owned=True, ripped=False, childrens=False))
    assert row["Owned"] == "Yes"
    assert row["Ripped"] == "No"
    assert row["Children's"] == "No"


def test_multi_value_attributes_kept_as_lists() -> None:
    row = movie_to_export_row(_movie())
    assert row["Genres"] == ["Sci-Fi", "Adventure"]
    assert row["Directors"] == ["Denis Villeneuve"]
    assert row["Tags"] == []  # empty multi-value → empty list (blank cell)


def test_external_ids_split_into_id_and_url_columns() -> None:
    row = movie_to_export_row(_movie())
    assert row["IMDB Id"] == "tt1160419"
    assert row["IMDB URL"] == "https://imdb.com/title/tt1160419"
    assert row["TMDB Id"] == "438631"
    assert row["TMDB URL"] == "https://tmdb.org/movie/438631"


def test_missing_attributes_render_blank() -> None:
    row = movie_to_export_row({"title": "X", "year": 1999, "contentType": "Movie"})
    assert row["Language"] == ""
    assert row["Genres"] == []
    assert row["IMDB Id"] == ""


def test_absent_optional_language_is_blank_not_default() -> None:
    # US1 interplay: a movie with no language must export an empty cell, never "English".
    row = movie_to_export_row(_movie(language=None))
    assert row["Language"] == ""


# ---------------------------------------------------------------------------
# Tab assembly
# ---------------------------------------------------------------------------


def test_build_export_tabs_one_tab_per_collection() -> None:
    tabs = build_export_tabs(
        [
            {"collectionName": "Action", "movies": [_movie(title="Dune")]},
            {"collectionName": "Empty", "movies": []},
        ]
    )
    assert [t["collectionName"] for t in tabs] == ["Action", "Empty"]
    assert tabs[0]["columns"] == EXPORT_COLUMNS
    assert len(tabs[0]["rows"]) == 1
    assert tabs[0]["rows"][0]["Title"] == "Dune"
    assert tabs[1]["rows"] == []  # empty collection → header-only sheet


# ---------------------------------------------------------------------------
# Collection selection
# ---------------------------------------------------------------------------


def test_select_named_subset_preserves_collection_order() -> None:
    collections = [
        {"collectionId": "c1", "name": "Action"},
        {"collectionId": "c2", "name": "Drama"},
        {"collectionId": "c3", "name": "Sci-Fi"},
    ]
    chosen = select_export_collections(["c3", "c1"], collections)
    assert [c["collectionId"] for c in chosen] == ["c1", "c3"]


def test_select_empty_request_returns_all() -> None:
    collections = [{"collectionId": "c1", "name": "A"}, {"collectionId": "c2", "name": "B"}]
    assert select_export_collections([], collections) == collections


def test_select_unknown_ids_are_ignored() -> None:
    collections = [{"collectionId": "c1", "name": "A"}]
    assert select_export_collections(["nope"], collections) == []
