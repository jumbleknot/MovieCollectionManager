"""T078: adversarial direct unit-test matrices over the pure-code resolver functions.

Tests import the shared adversarial fixture catalogue (tests/fixtures/adversarial.py) and
drive resolve_option / _match_movie / _split_title_year / _resolve_target /
references_current_screen directly — no graph compilation, no LLM stub, no async overhead.
Parametrized so each case is independently reported; assertions reflect CORRECT behavior so
genuine new bugs surface as failures (or xfail when noted).
"""

from __future__ import annotations

from typing import Any

import pytest

from src.nodes.organizer import (
    _match_movie,
    _resolve_target,
    _split_title_year,
    references_current_screen,
)
from src.nodes.supervisor import resolve_option
from tests.fixtures.adversarial import (
    BARE_TITLE_MOVIES,
    COLLECTIONS,
    COLLECTIONS_NO_DEFAULT,
    PREFIX_COLLISION_OPTIONS,
    SAME_TITLE_DIFFERENT_YEAR_MOVIES,
    STRING_YEAR_OPTIONS,
)

# ============================================================================
# resolve_option — prefix-collision / title-substring ordering
# ============================================================================


def test_resolve_option_long_title_beats_short_prefix() -> None:
    """'Avatar: The Way of Water' must resolve to the 2022 film, NOT bare Avatar."""
    result = resolve_option("Avatar: The Way of Water", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result["year"] == 2022
    assert "Way of Water" in result["title"]


def test_resolve_option_long_title_with_year_beats_prefix() -> None:
    """'Avatar: Fire and Ash (2025)' resolves via year to the 2025 film."""
    result = resolve_option("Avatar: Fire and Ash (2025)", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result["year"] == 2025
    assert "Fire and Ash" in result["title"]


def test_resolve_option_bare_avatar_resolves_to_bare_avatar_option() -> None:
    """A bare 'avatar' reply (no year, no qualifier) should resolve to the bare Avatar (2009).

    The bare title 'avatar' is contained in several longer titles (Capturing Avatar, etc.)
    but the longest-first sort ensures the longest matching title wins when the text is an
    exact substring of the title — 'avatar' is contained in 'Capturing Avatar' as a suffix
    substring but also IS the bare Avatar title exactly.  This tests the chosen behavior:
    the bare input matches the longest option whose title is contained in the text, which is
    actually the bare "Avatar" (≥4 chars, "avatar" in "avatar" → match); longer titles
    like "Avatar: The Way of Water" are checked first but "avatar: the way of water" is NOT
    in "avatar" — so the bare title wins over longer ones.
    """
    result = resolve_option("avatar", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result["title"] == "Avatar"
    assert result["year"] == 2009


def test_resolve_option_year_coercion_int_years() -> None:
    """Year pick 'the 2022 one' works when option years are ints."""
    result = resolve_option("the 2022 one", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result["year"] == 2022


def test_resolve_option_year_coercion_string_years() -> None:
    """Year pick 'the 2022 one' works even when option years are strings (JSON round-trip)."""
    result = resolve_option("the 2022 one", STRING_YEAR_OPTIONS)
    assert result is not None
    assert str(result["year"]) == "2022"


def test_resolve_option_year_string_2009() -> None:
    """Year 2009 resolves correctly against string-year options."""
    result = resolve_option("the 2009 film", STRING_YEAR_OPTIONS)
    assert result is not None
    assert result["title"] == "Avatar"


@pytest.mark.parametrize(
    "text,expected_idx",
    [
        ("the first one", 0),
        ("the 1st one", 0),
        ("the second one", 1),
        ("the 2nd one", 1),
        ("the third one", 2),
        ("the last one", -1),  # last → options[-1]
    ],
)
def test_resolve_option_ordinals(text: str, expected_idx: int) -> None:
    result = resolve_option(text, PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result == PREFIX_COLLISION_OPTIONS[expected_idx]


@pytest.mark.parametrize(
    "text,expected_idx",
    [
        ("number 2", 1),
        ("#3", 2),
        ("option 1", 0),
        ("2", 1),   # bare single digit
    ],
)
def test_resolve_option_1based_index(text: str, expected_idx: int) -> None:
    result = resolve_option(text, PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result == PREFIX_COLLISION_OPTIONS[expected_idx]


@pytest.mark.parametrize(
    "text",
    [
        "the green one",
        "the big one",
        "something completely different",
        "maybe",
    ],
)
def test_resolve_option_unresolvable_returns_none(text: str) -> None:
    result = resolve_option(text, PREFIX_COLLISION_OPTIONS)
    assert result is None


def test_resolve_option_empty_options_returns_none() -> None:
    result = resolve_option("the first one", [])
    assert result is None


def test_resolve_option_capturing_avatar_not_matched_by_bare_avatar() -> None:
    """'avatar' must not incorrectly land on 'Capturing Avatar' (prefix inside longer title)."""
    result = resolve_option("avatar", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    # If we land on 'Capturing Avatar' that would be wrong — 'avatar' is not the full title
    assert result["title"] != "Capturing Avatar"


# ============================================================================
# _split_title_year
# ============================================================================


@pytest.mark.parametrize(
    "text,expected_bare,expected_year",
    [
        ("Avatar (2009)", "Avatar", 2009),
        ("Avatar: The Way of Water (2022)", "Avatar: The Way of Water", 2022),
        ("Dune (2021)", "Dune", 2021),
        ("Avatar", "Avatar", None),
        ("Dune", "Dune", None),
        # Extra whitespace around the year annotation
        ("Inception  (2010)  ", "Inception", 2010),
        # A mid-title paren that is NOT a trailing year must NOT be stripped
        ("The (Real) Deal", "The (Real) Deal", None),
        # A mid-title paren followed by a trailing year — only the trailing year is stripped
        ("Some (Special) Film (2020)", "Some (Special) Film", 2020),
    ],
)
def test_split_title_year(text: str, expected_bare: str, expected_year: int | None) -> None:
    bare, year = _split_title_year(text)
    assert bare == expected_bare
    assert year == expected_year


# ============================================================================
# _match_movie — year-based disambiguation
# ============================================================================


def test_match_movie_disambiguates_dune_2021() -> None:
    """'Dune (2021)' must resolve to the 2021 Dune, not 1984."""
    result = _match_movie("Dune (2021)", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-dune-2021"


def test_match_movie_disambiguates_dune_1984() -> None:
    """'Dune (1984)' must resolve to the 1984 Dune."""
    result = _match_movie("Dune (1984)", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-dune-1984"


def test_match_movie_bare_dune_is_ambiguous() -> None:
    """Bare 'Dune' against two same-titled films must return None (never guessed)."""
    result = _match_movie("Dune", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is None


def test_match_movie_year_disagrees_returns_none() -> None:
    """'Avatar (2022)' against only a stored Avatar (2009) — year disagrees → None."""
    only_2009 = [{"movieId": "m-avatar-2009", "title": "Avatar", "year": 2009}]
    result = _match_movie("Avatar (2022)", only_2009)
    assert result is None


def test_match_movie_year_agrees_with_stored() -> None:
    """'Avatar (2009)' against a stored Avatar (2009) — year agrees → match."""
    only_2009 = [{"movieId": "m-avatar-2009", "title": "Avatar", "year": 2009}]
    result = _match_movie("Avatar (2009)", only_2009)
    assert result is not None
    assert result["movieId"] == "m-avatar-2009"


def test_match_movie_lenient_when_stored_has_no_year() -> None:
    """'Avatar (2009)' against a stored Avatar with NO year field → matches (lenient)."""
    result = _match_movie("Avatar (2009)", BARE_TITLE_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-avatar-bare"


def test_match_movie_lenient_when_op_has_no_year() -> None:
    """Bare 'Avatar' against a stored Avatar with no year → unique title match wins."""
    result = _match_movie("Avatar", BARE_TITLE_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-avatar-bare"


def test_match_movie_exact_title_unique() -> None:
    """Coherence appears once → clean exact match."""
    result = _match_movie("Coherence", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-coherence"


def test_match_movie_case_insensitive() -> None:
    """Title matching is case-insensitive (casefolded)."""
    result = _match_movie("coherence", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-coherence"


def test_match_movie_whitespace_stripped() -> None:
    """Leading/trailing whitespace on the op title is handled gracefully."""
    result = _match_movie("  Coherence  ", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-coherence"


def test_match_movie_all_caps() -> None:
    result = _match_movie("COHERENCE", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-coherence"


def test_match_movie_colon_title_bare() -> None:
    """A colon-containing bare title without year matches correctly."""
    result = _match_movie("Star Wars: A New Hope", BARE_TITLE_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-sw4"


def test_match_movie_mid_title_paren_not_stripped() -> None:
    """'The (Real) Deal' — mid-title parens are NOT treated as a trailing year."""
    result = _match_movie("The (Real) Deal", BARE_TITLE_MOVIES)
    assert result is not None
    assert result["movieId"] == "m-brackets"


def test_match_movie_no_match_returns_none() -> None:
    result = _match_movie("The Nonexistent Film", SAME_TITLE_DIFFERENT_YEAR_MOVIES)
    assert result is None


# ============================================================================
# _resolve_target
# ============================================================================


def test_resolve_target_exact_name_existing() -> None:
    """An exactly-matching name (case-insensitive) resolves to the existing collection."""
    ref, needs_clarify = _resolve_target("Sci-Fi", COLLECTIONS)
    assert not needs_clarify
    assert ref.collection_id == "c-scifi"
    assert ref.create_if_missing is False


def test_resolve_target_exact_name_case_insensitive() -> None:
    ref, needs_clarify = _resolve_target("sci-fi", COLLECTIONS)
    assert not needs_clarify
    assert ref.collection_id == "c-scifi"


def test_resolve_target_exact_name_all_caps() -> None:
    ref, needs_clarify = _resolve_target("SCI-FI", COLLECTIONS)
    assert not needs_clarify
    assert ref.collection_id == "c-scifi"


def test_resolve_target_generic_empty_with_default() -> None:
    """An empty name with a default collection → resolves to the default."""
    ref, needs_clarify = _resolve_target("", COLLECTIONS)
    assert not needs_clarify
    assert ref.collection_id == "c-default"
    assert ref.create_if_missing is False


@pytest.mark.parametrize(
    "generic_name",
    [
        "my collection",
        "my collections",
        "my list",
        "my movies",
        "default",
        "default collection",
        "the collection",
        "a collection",
        "my default collection",
    ],
)
def test_resolve_target_generic_names_with_default(generic_name: str) -> None:
    """All generic target names resolve to the default collection when one exists."""
    ref, needs_clarify = _resolve_target(generic_name, COLLECTIONS)
    assert not needs_clarify
    assert ref.collection_id == "c-default"


def test_resolve_target_generic_no_default_needs_clarify() -> None:
    """An empty/generic name with NO default collection → needs_clarify=True."""
    ref, needs_clarify = _resolve_target("", COLLECTIONS_NO_DEFAULT)
    assert needs_clarify
    assert ref.collection_id is None


def test_resolve_target_specific_new_name_creates_if_missing() -> None:
    """A specifically-named collection not in the list → create_if_missing=True."""
    ref, needs_clarify = _resolve_target("Brand New Collection", COLLECTIONS)
    assert not needs_clarify
    assert ref.create_if_missing is True
    assert ref.name == "Brand New Collection"
    assert ref.collection_id is None


def test_resolve_target_my_collection_no_default_needs_clarify() -> None:
    """'my collection' (generic) with no default → clarify, never auto-create."""
    ref, needs_clarify = _resolve_target("my collection", COLLECTIONS_NO_DEFAULT)
    assert needs_clarify


# ============================================================================
# references_current_screen
# ============================================================================


@pytest.mark.parametrize(
    "text",
    [
        "add Dune to this",
        "add Dune to this collection",
        "add it to the current collection",
        "put it here",
        "add to here",
        "This one",
        "CURRENT collection",
        "HERE",
    ],
)
def test_references_current_screen_true(text: str) -> None:
    assert references_current_screen(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "where is my collection",     # 'where' does NOT contain 'here' as a whole word
        "somewhere nice",             # 'where' substring inside 'somewhere'
        "there it is",                # 'there' should NOT match 'here'
        "theory of everything",       # 'here' inside 'theory' — must NOT match
        "another collection",         # no keyword
        "add Dune to Sci-Fi",         # explicit named collection
        "",                           # empty string
        "therapeutic",                # 'here' inside 'therapeutic' — must NOT match
    ],
)
def test_references_current_screen_false(text: str) -> None:
    assert references_current_screen(text) is False


def test_references_current_screen_word_boundary_there() -> None:
    """'there' must not match as 'here' — verify word-boundary enforcement."""
    assert references_current_screen("there") is False


def test_references_current_screen_word_boundary_where() -> None:
    """'where' must not match as 'here' — verify word-boundary enforcement."""
    assert references_current_screen("where") is False


def test_references_current_screen_word_boundary_theory() -> None:
    """'theory' contains 'here' as a substring but must NOT match."""
    assert references_current_screen("theory") is False


# ============================================================================
# Additional edge-case coverage for resolve_option
# ============================================================================


def test_resolve_option_uppercase_title_match() -> None:
    """Uppercase version of a subtitle still resolves (case-folded comparison)."""
    result = resolve_option("AVATAR: THE WAY OF WATER", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result["year"] == 2022


def test_resolve_option_whitespace_padded_title() -> None:
    """Extra whitespace around a title still resolves via substring match."""
    result = resolve_option("  Avatar: Fire and Ash  ", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result["year"] == 2025


def test_resolve_option_short_title_min_length_guard() -> None:
    """Titles shorter than 4 chars cannot false-match via substring (length guard).

    The option list here uses a 2-char title ('Up') which should NOT match via the
    substring path against an unrelated reply, but should still be reachable via year/ordinal.
    """
    short_options: list[dict[str, Any]] = [
        {"sourceId": "tmdb:14160", "title": "Up", "year": 2009},
        {"sourceId": "tmdb:12345", "title": "Up and Away", "year": 2010},
    ]
    # 'Up' (2 chars) is below the 4-char threshold, so a reply containing 'up' as part of
    # another word should NOT resolve via substring.
    result = resolve_option("what's up with option 2", short_options)
    # 'option 2' → 1-based index 2 → short_options[1]
    assert result is not None
    assert result["title"] == "Up and Away"


def test_resolve_option_year_takes_priority_over_title() -> None:
    """Year match should fire before the title-substring step (ordering invariant)."""
    # 'Avatar: The Way of Water' contains the substring 'avatar' which matches bare Avatar,
    # but a year-specific reply should use the year path.
    result = resolve_option("the 2025 avatar film", PREFIX_COLLISION_OPTIONS)
    assert result is not None
    assert result["year"] == 2025
