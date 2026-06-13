"""T029: dedup + compose-then-replace unit tests for spreadsheet import (US2).

Drives the pure-code import resolvers directly against the shared adversarial catalogue
(tests/fixtures/adversarial.py):
  * `match_existing_movie` — article-insensitive (title, year) match against stored movies.
  * `compose_import_payload` — full-replacement payload that overlays only supplied
    attributes and NEVER blanks the ones an import row omits (reuses 013 compose_movie_payload).
  * `dedup_import_rows` — within-import dedup by (normalized title, year), first wins.

Covers: US2-AC6, US2-AC7, FR-017/018/019.
"""

from __future__ import annotations

from src.nodes.import_resolvers import (
    compose_import_payload,
    dedup_import_rows,
    match_existing_movie,
)
from tests.fixtures.adversarial import IMPORT_DUPLICATE_ROWS, IMPORT_EXISTING_MOVIES

# ---------------------------------------------------------------------------
# match_existing_movie
# ---------------------------------------------------------------------------


def test_match_by_exact_title_and_year() -> None:
    movie = match_existing_movie("The Matrix", 1999, IMPORT_EXISTING_MOVIES)
    assert movie is not None
    assert movie["movieId"] == "m-matrix"


def test_match_is_article_insensitive() -> None:
    """A bare 'Matrix' import row matches the stored 'The Matrix' (same year)."""
    movie = match_existing_movie("Matrix", 1999, IMPORT_EXISTING_MOVIES)
    assert movie is not None
    assert movie["movieId"] == "m-matrix"


def test_match_disambiguates_same_title_by_year() -> None:
    assert match_existing_movie("Dune", 1984, IMPORT_EXISTING_MOVIES)["movieId"] == "m-dune-1984"
    assert match_existing_movie("Dune", 2021, IMPORT_EXISTING_MOVIES)["movieId"] == "m-dune-2021"


def test_no_match_means_create() -> None:
    assert match_existing_movie("Coherence", 2013, IMPORT_EXISTING_MOVIES) is None


def test_year_mismatch_is_no_match() -> None:
    """A 'The Matrix' with the wrong year is a different film → no match (would create)."""
    assert match_existing_movie("The Matrix", 2003, IMPORT_EXISTING_MOVIES) is None


def test_ambiguous_same_title_without_year_is_no_match() -> None:
    """No year + two stored Dunes → ambiguous → refuse to guess."""
    assert match_existing_movie("Dune", None, IMPORT_EXISTING_MOVIES) is None


def test_blank_title_never_matches() -> None:
    assert match_existing_movie("", 1999, IMPORT_EXISTING_MOVIES) is None


# ---------------------------------------------------------------------------
# compose_import_payload (update: never blank unsupplied attributes)
# ---------------------------------------------------------------------------


def test_update_overlays_supplied_and_preserves_the_rest() -> None:
    existing = IMPORT_EXISTING_MOVIES[0]  # The Matrix, with plot + directors + genres
    supplied = {"owned": True, "genres": ["Action", "Cyberpunk"]}
    payload = compose_import_payload(existing, supplied)

    # Supplied attributes overlaid:
    assert payload["owned"] is True
    assert payload["genres"] == ["Action", "Cyberpunk"]
    # Unsupplied attributes preserved (never blanked):
    assert payload["plot"] == existing["plot"]
    assert payload["directors"] == existing["directors"]
    assert payload["title"] == "The Matrix"
    assert payload["year"] == 1999
    # Server-assigned ids stripped (full-replacement payload):
    assert "movieId" not in payload
    assert "collectionId" not in payload


def test_update_skips_blank_supplied_values() -> None:
    """An empty supplied value must NOT blank an existing attribute (FR-019)."""
    existing = IMPORT_EXISTING_MOVIES[0]
    supplied = {"plot": "", "genres": [], "directors": None, "owned": True}
    payload = compose_import_payload(existing, supplied)

    assert payload["plot"] == existing["plot"]
    assert payload["genres"] == existing["genres"]
    assert payload["directors"] == existing["directors"]
    assert payload["owned"] is True  # real supplied value still applied


def test_update_applies_false_boolean() -> None:
    """`owned=False` is a real value, not a blank — it must overlay."""
    existing = IMPORT_EXISTING_MOVIES[1]  # Dune 1984, owned=True
    payload = compose_import_payload(existing, {"owned": False})
    assert payload["owned"] is False


def test_create_payload_is_the_supplied_row() -> None:
    supplied = {"title": "Coherence", "year": 2013, "contentType": "movie", "genres": ["Sci-Fi"]}
    payload = compose_import_payload(None, supplied)
    assert payload == supplied
    # A copy — never the caller's dict, so later mutation can't leak back.
    payload["title"] = "mutated"
    assert supplied["title"] == "Coherence"


def test_compose_does_not_mutate_existing_doc() -> None:
    existing = IMPORT_EXISTING_MOVIES[0]
    before = dict(existing)
    compose_import_payload(existing, {"owned": True, "genres": ["X"]})
    assert existing == before


# ---------------------------------------------------------------------------
# dedup_import_rows (within-import duplicates)
# ---------------------------------------------------------------------------


def test_within_import_dedup_collapses_article_variants() -> None:
    unique, duplicates = dedup_import_rows(IMPORT_DUPLICATE_ROWS)
    titles = [(r["title"], r["year"]) for r in unique]
    # 'The Matrix' (1999) kept once; the bare 'Matrix' (1999) is the duplicate.
    assert titles.count(("The Matrix", 1999)) == 1
    assert ("Matrix", 1999) not in titles
    assert any(r["title"] == "Matrix" for r in duplicates)


def test_within_import_dedup_keeps_same_title_different_year() -> None:
    unique, _ = dedup_import_rows(IMPORT_DUPLICATE_ROWS)
    dunes = [r for r in unique if r["title"] == "Dune"]
    assert len(dunes) == 2  # 1984 and 2021 are distinct films


def test_dedup_first_occurrence_wins() -> None:
    unique, duplicates = dedup_import_rows(IMPORT_DUPLICATE_ROWS)
    matrix = next(r for r in unique if r["year"] == 1999)
    assert matrix["title"] == "The Matrix"  # the first of the two 1999 rows
    assert matrix["genres"] == ["Action"]


def test_dedup_empty_input() -> None:
    assert dedup_import_rows([]) == ([], [])
