"""T051/T053/T055: build_import_preview honours resolved disambiguations (US4).

After the user taps a button, the recorded choice (collection target / column attribute / title
article) must be APPLIED when the preview is (re)built — and never re-asked. Pure: drives
`build_import_preview` with a `resolutions` dict directly (no graph, no IO).

Covers: US4-AC1/2/3, FR-010/012/015.
"""

from __future__ import annotations

from typing import Any

from src.nodes.import_collection import build_import_preview

_FAV = [{"collectionId": "c1", "name": "Favourites"}]


def _tab(name: str, columns: list[dict], rows: list[dict]) -> dict:
    return {"name": name, "eligible": True, "columns": columns, "rows": rows}


def _preview(tab: dict, collections: list[dict], resolutions: dict[str, Any]) -> Any:
    return build_import_preview(
        tabs=[tab],
        collections=collections,
        existing_by_collection={},
        thread_id="t",
        resolutions=resolutions,
    )


_BASE_COLS = [{"header": "Title"}, {"header": "Year"}, {"header": "Video Type"}]


# ---------------------------------------------------------------------------
# T051: collection target resolution
# ---------------------------------------------------------------------------


def test_resolved_collection_plans_rows_into_the_chosen_collection() -> None:
    tab = _tab("My Movies", _BASE_COLS, [{"Title": "Dune", "Year": "2021", "Video Type": "Movie"}])
    preview = _preview(tab, _FAV, {"collection": {"My Movies": "c1"}})
    plan = preview.tabs[0]
    assert plan.needs_collection_choice is False
    assert plan.target_collection_id == "c1"
    assert [item.title for item in plan.to_create] == ["Dune"]


def test_unresolved_collection_still_defers() -> None:
    tab = _tab("My Movies", _BASE_COLS, [{"Title": "Dune", "Year": "2021", "Video Type": "Movie"}])
    plan = _preview(tab, _FAV, {}).tabs[0]
    assert plan.needs_collection_choice is True
    assert plan.to_create == []


# ---------------------------------------------------------------------------
# T053: medium-confidence column resolution
# ---------------------------------------------------------------------------


def test_confirmed_column_is_applied_as_the_chosen_attribute() -> None:
    cols = _BASE_COLS + [{"header": "Rating", "sampleValues": ["PG-13", "great"]}]
    tab = _tab(
        "Favourites", cols,
        [{"Title": "Dune", "Year": "2021", "Video Type": "Movie", "Rating": "PG-13"}],
    )
    plan = _preview(tab, _FAV, {"column": {"Rating": "rated"}}).tabs[0]
    assert plan.to_create[0].payload["rated"] == "PG-13"


def test_unconfirmed_medium_column_is_not_applied() -> None:
    cols = _BASE_COLS + [{"header": "Rating", "sampleValues": ["PG-13", "great"]}]
    tab = _tab(
        "Favourites", cols,
        [{"Title": "Dune", "Year": "2021", "Video Type": "Movie", "Rating": "PG-13"}],
    )
    plan = _preview(tab, _FAV, {}).tabs[0]
    # The unconfirmed column's VALUE ("PG-13") must not be applied — `rated` is the null
    # create-default (a CreateMovieDto needs every optional scalar present, _CREATE_NULL_DEFAULTS),
    # never the column value.
    assert plan.to_create[0].payload.get("rated") is None


def test_ignored_column_is_dropped() -> None:
    cols = _BASE_COLS + [{"header": "Rating", "sampleValues": ["PG-13", "great"]}]
    tab = _tab(
        "Favourites", cols,
        [{"Title": "Dune", "Year": "2021", "Video Type": "Movie", "Rating": "PG-13"}],
    )
    plan = _preview(tab, _FAV, {"column": {"Rating": "__ignore__"}}).tabs[0]
    # The ignored column's VALUE ("PG-13") is dropped — `rated` is the null create-default, not it.
    assert plan.to_create[0].payload.get("rated") is None


# ---------------------------------------------------------------------------
# T055: article resolution
# ---------------------------------------------------------------------------


def test_article_reorder_choice_applied_to_title() -> None:
    tab = _tab(
        "Favourites", _BASE_COLS,
        [{"Title": "Goodbye, Lenin!", "Year": "2003", "Video Type": "Movie"}],
    )
    plan = _preview(tab, _FAV, {"article": {"Goodbye, Lenin!": "Lenin! Goodbye"}}).tabs[0]
    assert plan.to_create[0].payload["title"] == "Lenin! Goodbye"


def test_article_keep_choice_leaves_title_untouched() -> None:
    tab = _tab(
        "Favourites", _BASE_COLS,
        [{"Title": "Goodbye, Lenin!", "Year": "2003", "Video Type": "Movie"}],
    )
    plan = _preview(tab, _FAV, {"article": {"Goodbye, Lenin!": "Goodbye, Lenin!"}}).tabs[0]
    assert plan.to_create[0].payload["title"] == "Goodbye, Lenin!"
