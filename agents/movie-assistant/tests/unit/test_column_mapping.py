"""T025: adversarial unit matrix for the pure-code column-mapping resolver (US2).

Drives `resolve_column` / `resolve_columns` (src/nodes/import_resolvers.py) directly — no
graph, no LLM. The alias table is the canonical spreadsheet-header → movie-attribute map
(data-model.md §4), verified here against the real `MovieDto` camelCase field set in
backend/mc-service/src/application/dtos/movie_dto.rs. Confidence drives the flow:
high→auto, medium→ask (FR-012), low→ignore (FR-013).

Covers: US2-AC3, FR-011/012/013.
"""

from __future__ import annotations

import pytest

from src.nodes.import_resolvers import ColumnMapping, resolve_column, resolve_columns

# The real movie attributes (camelCase) a column may map to — mirrors MovieDto /
# CreateMovieDto in backend/mc-service/src/application/dtos/movie_dto.rs. Any `attribute`
# a mapping resolves to MUST be a member of this set (no invented fields like `overview`).
MOVIE_ATTRIBUTES = frozenset(
    {
        "title",
        "year",
        "contentType",
        "language",
        "owned",
        "ripped",
        "childrens",
        "originalTitle",
        "releaseDate",
        "outline",
        "plot",
        "runtime",
        "rated",
        "directors",
        "actors",
        "movieSet",
        "tags",
        "genres",
        "ownedMedia",
        "ripQuality",
        "externalIds",
    }
)

# (header, expected attribute) — the canonical high-confidence alias seeds (data-model.md §4).
HIGH_CONFIDENCE_ALIASES: list[tuple[str, str]] = [
    ("Title", "title"),
    ("Year", "year"),
    ("Video Type", "contentType"),
    ("Children's", "childrens"),
    ("Owned", "owned"),
    ("Media", "ownedMedia"),
    ("Ripped", "ripped"),
    ("Rip Quality", "ripQuality"),
    ("MPAA", "rated"),
    ("Language", "language"),
    ("Directors", "directors"),
    ("Actors", "actors"),
    ("Genres", "genres"),
    ("Tags", "tags"),
    ("Original Title", "originalTitle"),
    ("Release Date", "releaseDate"),
    ("Outline", "outline"),
    ("Plot", "plot"),
    ("Runtime", "runtime"),
    ("Set", "movieSet"),
    ("IMDB Id", "externalIds"),
    ("IMDB URL", "externalIds"),
    ("TMDB Id", "externalIds"),
]

# Multi-value attributes split on `|` (data-model.md §1 / FR-016).
MULTI_VALUE_ATTRIBUTES = frozenset(
    {"genres", "directors", "actors", "tags", "ownedMedia", "ripQuality", "externalIds"}
)


@pytest.mark.parametrize("header,expected_attr", HIGH_CONFIDENCE_ALIASES)
def test_high_confidence_alias_maps_directly(header: str, expected_attr: str) -> None:
    mapping = resolve_column(header)
    assert mapping.attribute == expected_attr
    assert mapping.confidence == "high"
    assert mapping.resolved_by == "code"


@pytest.mark.parametrize("header,expected_attr", HIGH_CONFIDENCE_ALIASES)
def test_every_resolved_attribute_is_a_real_movie_field(header: str, expected_attr: str) -> None:
    """Guards against drift from the mc-service DTO — no invented attributes."""
    mapping = resolve_column(header)
    assert mapping.attribute in MOVIE_ATTRIBUTES


@pytest.mark.parametrize(
    "header,expected_multi",
    [
        ("Genres", True),
        ("Directors", True),
        ("Actors", True),
        ("Tags", True),
        ("Media", True),
        ("Rip Quality", True),
        ("IMDB Id", True),
        ("Title", False),
        ("Year", False),
        ("Owned", False),
        ("Language", False),
        ("Outline", False),
    ],
)
def test_multi_value_flag(header: str, expected_multi: bool) -> None:
    mapping = resolve_column(header)
    assert mapping.multi_value is expected_multi


def test_aliases_are_case_and_whitespace_insensitive() -> None:
    for header in ("title", "  TITLE  ", "Title"):
        mapping = resolve_column(header)
        assert mapping.attribute == "title"
        assert mapping.confidence == "high"


@pytest.mark.parametrize("header", ["Pick", "Top", "Tagline"])
def test_no_target_columns_are_low_ignore(header: str) -> None:
    """Columns with no movie attribute → low confidence, ignored (FR-013)."""
    mapping = resolve_column(header)
    assert mapping.attribute is None
    assert mapping.confidence == "low"


def test_unknown_header_is_low_ignore() -> None:
    mapping = resolve_column("Some Random Column")
    assert mapping.attribute is None
    assert mapping.confidence == "low"


def test_generic_rating_header_without_samples_is_medium_ask() -> None:
    """A bare ambiguous `Rating`/`Score` header → medium (ask), not auto-mapped (FR-012)."""
    for header in ("Rating", "Score", "My Rating"):
        mapping = resolve_column(header)
        assert mapping.confidence == "medium"
        assert mapping.attribute is None
        # The medium prompt offers candidate attributes for the user to confirm.
        assert "rated" in mapping.candidates


def test_rating_header_with_mpaa_samples_resolves_high_to_rated() -> None:
    """Value-shape heuristic: MPAA-like sample values disambiguate `Rating` → rated (high)."""
    mapping = resolve_column("Rating", sample_values=["PG-13", "R", "PG"])
    assert mapping.attribute == "rated"
    assert mapping.confidence == "high"


def test_rating_header_with_numeric_samples_is_low_ignore() -> None:
    """Value-shape heuristic: numeric personal-rating values have no model field → ignore."""
    mapping = resolve_column("Rating", sample_values=["8.5", "7", "9.2"])
    assert mapping.attribute is None
    assert mapping.confidence == "low"


def test_resolve_columns_maps_a_full_tab_header_set() -> None:
    columns = [
        {"header": "Title", "sampleValues": ["The Matrix"]},
        {"header": "Year", "sampleValues": ["1999"]},
        {"header": "Genres", "sampleValues": ["Action|Sci-Fi"]},
        {"header": "Pick", "sampleValues": ["x"]},
        {"header": "Rating", "sampleValues": ["8.5"]},
    ]
    mappings = resolve_columns(columns)
    by_header = {m.header: m for m in mappings}
    assert by_header["Title"].attribute == "title"
    assert by_header["Genres"].multi_value is True
    assert by_header["Pick"].confidence == "low"
    assert by_header["Rating"].confidence == "low"  # numeric samples → ignore
    assert len(mappings) == len(columns)


def test_column_mapping_is_immutable() -> None:
    mapping = resolve_column("Title")
    with pytest.raises((AttributeError, TypeError)):
        mapping.attribute = "year"  # type: ignore[misc]
    assert isinstance(mapping, ColumnMapping)
