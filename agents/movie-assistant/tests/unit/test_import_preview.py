"""T032 (preview builder): pure tab→collection resolution + ImportPreview assembly.

`resolve_tab_collection` implements FR-009 (exact single-name match → target) / FR-010 (0 or
>1 matches → prompt the user). `build_import_preview` walks the eligible tabs, transforms rows,
dedups within-import, matches each against the chosen collection's existing movies, and emits a
TabPlan of toCreate / toUpdate / skipped — with idempotency keys and NO writes (FR-020). Pure
code (no LLM, no IO): readers are passed in.

Covers: US2-AC1/6/7/8, FR-009/010/017/018/019/020.
"""

from __future__ import annotations

from src.nodes.import_collection import (
    ImportPreview,
    build_import_preview,
    resolve_tab_collection,
)

COLLECTIONS = [
    {"collectionId": "c-scifi", "name": "Sci-Fi"},
    {"collectionId": "c-horror", "name": "Horror"},
    {"collectionId": "c-fav", "name": "Favorites"},
]

# A minimal eligible parsed tab (parse_workbook shape) targeting "Sci-Fi" by name.
HEADERS = ["Title", "Year", "Video Type", "Genres", "Owned"]


def _row(title: str, year: str, *, genres: str = "Sci-Fi", owned: str = "Yes") -> dict:
    return {"Title": title, "Year": year, "Video Type": "Movie", "Genres": genres, "Owned": owned}


def _tab(name: str, rows: list[dict], eligible: bool = True) -> dict:
    columns = [{"header": h, "sampleValues": []} for h in HEADERS]
    return {"name": name, "eligible": eligible, "columns": columns,
            "rowCount": len(rows), "rows": rows}


# ---------------------------------------------------------------------------
# resolve_tab_collection (FR-009 / FR-010)
# ---------------------------------------------------------------------------


def test_exact_single_name_match_targets_without_prompt() -> None:
    target, options = resolve_tab_collection("Sci-Fi", COLLECTIONS)
    assert target is not None
    assert target["collectionId"] == "c-scifi"
    assert options == []


def test_match_is_case_insensitive() -> None:
    target, _ = resolve_tab_collection("  sci-fi ", COLLECTIONS)
    assert target is not None and target["collectionId"] == "c-scifi"


def test_zero_match_requires_prompt() -> None:
    target, options = resolve_tab_collection("Westerns", COLLECTIONS)
    assert target is None
    assert {o["collectionId"] for o in options} == {"c-scifi", "c-horror", "c-fav"}


def test_more_than_one_match_requires_prompt() -> None:
    dup = [*COLLECTIONS, {"collectionId": "c-scifi-2", "name": "Sci-Fi"}]
    target, options = resolve_tab_collection("Sci-Fi", dup)
    assert target is None
    assert len(options) == 2  # the two same-named collections offered


# ---------------------------------------------------------------------------
# build_import_preview
# ---------------------------------------------------------------------------


def test_exact_match_tab_creates_new_movies() -> None:
    tab = _tab("Sci-Fi", [_row("Dune", "2021"), _row("The Matrix", "1999")])
    preview = build_import_preview(
        tabs=[tab], collections=COLLECTIONS, existing_by_collection={}, thread_id="t1"
    )
    assert isinstance(preview, ImportPreview)
    plan = preview.tabs[0]
    assert plan.target_collection_id == "c-scifi"
    assert {item.title for item in plan.to_create} == {"Dune", "The Matrix"}
    assert plan.to_update == []
    assert all(item.movie_id is None for item in plan.to_create)
    assert all(item.idempotency_key for item in plan.to_create)


def test_existing_movie_becomes_update_without_blanking() -> None:
    existing = [{"movieId": "m1", "title": "Dune", "year": 2021, "genres": ["Sci-Fi"],
                 "plot": "keep me", "owned": False}]
    tab = _tab("Sci-Fi", [_row("Dune", "2021", genres="Sci-Fi|Adventure", owned="Yes")])
    preview = build_import_preview(
        tabs=[tab], collections=COLLECTIONS,
        existing_by_collection={"c-scifi": existing}, thread_id="t1"
    )
    plan = preview.tabs[0]
    assert plan.to_create == []
    assert len(plan.to_update) == 1
    upd = plan.to_update[0]
    assert upd.movie_id == "m1"
    assert upd.payload["genres"] == ["Sci-Fi", "Adventure"]  # supplied overlay
    assert upd.payload["owned"] is True
    assert upd.payload["plot"] == "keep me"  # unsupplied preserved (FR-019)
    assert "movieId" not in upd.payload


def test_create_payload_has_required_defaults() -> None:
    tab = _tab("Sci-Fi", [_row("Primer", "2004", genres="")])
    preview = build_import_preview(
        tabs=[tab], collections=COLLECTIONS, existing_by_collection={}, thread_id="t1"
    )
    item = preview.tabs[0].to_create[0]
    assert item.payload["ripped"] is False
    assert item.payload["genres"] == []
    assert item.payload["externalIds"] == []


def test_row_missing_required_field_is_skipped() -> None:
    tab = _tab("Sci-Fi", [_row("", "2021"), _row("Dune", "")])  # blank title; blank year
    preview = build_import_preview(
        tabs=[tab], collections=COLLECTIONS, existing_by_collection={}, thread_id="t1"
    )
    plan = preview.tabs[0]
    assert plan.to_create == []
    assert len(plan.skipped) == 2


def test_skip_reason_distinguishes_invalid_from_missing_required(  ) -> None:
    """Enhancement 3: a present-but-unparseable required cell reads 'invalid X'; an absent one
    'missing X' — so the import report can tell the user precisely why each row was skipped."""
    tab = _tab("Sci-Fi", [_row("Bad Year", "nope"), _row("No Year", "")])
    preview = build_import_preview(
        tabs=[tab], collections=COLLECTIONS, existing_by_collection={}, thread_id="t1"
    )
    reasons = {s["title"]: s["reason"] for s in preview.tabs[0].skipped}
    assert reasons["Bad Year"] == "invalid Year"  # "nope" present but won't parse
    assert reasons["No Year"] == "missing Year"  # cell empty


def test_within_import_duplicate_is_skipped_once() -> None:
    tab = _tab("Sci-Fi", [_row("Dune", "2021"), _row("Dune", "2021")])
    preview = build_import_preview(
        tabs=[tab], collections=COLLECTIONS, existing_by_collection={}, thread_id="t1"
    )
    plan = preview.tabs[0]
    assert len(plan.to_create) == 1
    assert len(plan.skipped) == 1


def test_unmatched_tab_name_defers_to_collection_choice() -> None:
    tab = _tab("My Watchlist", [_row("Dune", "2021")])
    preview = build_import_preview(
        tabs=[tab], collections=COLLECTIONS, existing_by_collection={}, thread_id="t1"
    )
    plan = preview.tabs[0]
    assert plan.needs_collection_choice is True
    assert plan.target_collection_id is None
    assert {o["collectionId"] for o in plan.collection_options} >= {"c-scifi", "c-fav"}
    # No create/update committed until the user picks a collection.
    assert plan.to_create == [] and plan.to_update == []


def test_ineligible_tabs_are_not_planned() -> None:
    eligible = _tab("Sci-Fi", [_row("Dune", "2021")])
    helper = _tab("Lists", [], eligible=False)
    preview = build_import_preview(
        tabs=[eligible, helper], collections=COLLECTIONS, existing_by_collection={},
        thread_id="t1"
    )
    assert [p.tab_name for p in preview.tabs] == ["Sci-Fi"]
    assert "Lists" in preview.ignored_tabs


def test_idempotency_keys_are_deterministic_and_unique_per_item() -> None:
    tab = _tab("Sci-Fi", [_row("Dune", "2021"), _row("The Matrix", "1999")])
    a = build_import_preview(tabs=[tab], collections=COLLECTIONS, existing_by_collection={},
                             thread_id="t1").tabs[0]
    b = build_import_preview(tabs=[tab], collections=COLLECTIONS, existing_by_collection={},
                             thread_id="t1").tabs[0]
    keys_a = [i.idempotency_key for i in a.to_create]
    keys_b = [i.idempotency_key for i in b.to_create]
    assert keys_a == keys_b  # deterministic across runs (same thread)
    assert len(set(keys_a)) == 2  # unique per item
