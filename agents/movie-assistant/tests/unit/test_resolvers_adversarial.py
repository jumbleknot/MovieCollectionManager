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

from src.nodes.curator import _unique_exact_match
from src.nodes.organizer import (
    _match_movie,
    _resolve_op_movie,
    _resolve_target,
    _split_title_year,
    references_current_screen,
    resolve_multi_select,
)
from src.nodes.supervisor import resolve_option
from tests.fixtures.adversarial import (
    BARE_TITLE_MOVIES,
    COLLECTIONS,
    COLLECTIONS_NO_DEFAULT,
    MEDIA_FORMAT_OPTIONS,
    MIXED_CASE_LABEL_OPTIONS,
    MULTI_SELECT_EMPTY_REPLIES,
    MULTI_SELECT_REPLIES,
    MULTI_SELECT_UNRESOLVABLE_REPLIES,
    PARTIAL_NAME_MOVIES,
    PREFIX_COLLISION_OPTIONS,
    SAME_TITLE_DIFFERENT_YEAR_MOVIES,
    STRING_YEAR_OPTIONS,
    SUBSET_SUPERSET_SAME_YEAR,
    TRAILING_SPACE_TITLE,
    WHITESPACE_LABEL_OPTIONS,
    WHITESPACE_PICK_CASES,
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
# resolve_option — whitespace/case normalization (047 T008)
#
# The shared failure mode behind 047 US2 (the import sorting loop) and 047 US4 (the
# multi-select reply): a reply that differs from an option label ONLY by surrounding
# whitespace or case resolves to nothing.  The substring step cannot save it — a label
# carrying a trailing space is LONGER than the trimmed reply, so `title in low` is false
# by construction.  Fixed once, in the shared resolver.
# ============================================================================


@pytest.mark.parametrize(
    ("reply", "options", "expected_id"),
    [pytest.param(*case, id=case[2] + "-" + repr(case[0])) for case in WHITESPACE_PICK_CASES],
)
def test_resolve_option_normalizes_whitespace_and_case(
    reply: str, options: list[dict[str, Any]], expected_id: str
) -> None:
    """A reply equal to an option label after trim+casefold resolves to THAT option."""
    result = resolve_option(reply, options)
    assert result is not None, f"reply {reply!r} resolved to nothing"
    assert result["id"] == expected_id


def test_resolve_option_normalizes_the_reported_trailing_space_title() -> None:
    """The exact 047 US2 defect: the option label carries a trailing space, the reply does not.

    The label is LONGER than the reply, so the substring step (`title in low`) can never
    match — nothing resolves, nothing is recorded, and the question re-fires forever.
    """
    assert TRAILING_SPACE_TITLE.endswith(" "), "fixture lost its significant trailing space"
    result = resolve_option(TRAILING_SPACE_TITLE.strip(), WHITESPACE_LABEL_OPTIONS)
    assert result is not None
    assert result["id"] == "keep"


def test_resolve_option_normalized_equality_beats_a_longer_substring_match() -> None:
    """An exact (normalized) label wins over a longer label that merely contains the reply.

    Without the normalized-equality step the longest-first substring scan would hand back
    the longer option, silently recording a choice the member did not make.
    """
    options: list[dict[str, Any]] = [
        {"id": "exact", "title": "Blu-Ray"},
        {"id": "longer", "title": "Blu-Ray 3D Collector's Edition"},
    ]
    result = resolve_option("  blu-ray  ", options)
    assert result is not None
    assert result["id"] == "exact"


def test_resolve_option_normalization_does_not_rescue_a_genuine_non_match() -> None:
    """Normalization must not make the resolver guess — an unrelated reply still returns None."""
    assert resolve_option("something else entirely", MIXED_CASE_LABEL_OPTIONS) is None


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


# ============================================================================
# _resolve_op_movie — organize partial-title resolution (013 Inc5 new bug 1)
# ============================================================================


def test_resolve_op_movie_exact_title_year_resolves() -> None:
    kind, payload = _resolve_op_movie("Coherence", PARTIAL_NAME_MOVIES)
    assert kind == "one" and payload["movieId"] == "coherence"


@pytest.mark.parametrize("title", ["coherenc", "COHERENCE", "  coherence  "])
def test_resolve_op_movie_partial_unique_resolves(title: str) -> None:
    """A unique partial/substring name resolves (the reported single-Harry-Potter case)."""
    kind, payload = _resolve_op_movie(title, PARTIAL_NAME_MOVIES)
    assert kind == "one" and payload["movieId"] == "coherence"


def test_resolve_op_movie_partial_multiple_is_ambiguous() -> None:
    kind, payload = _resolve_op_movie("harry potter", PARTIAL_NAME_MOVIES)
    assert kind == "many"
    assert {m["movieId"] for m in payload} == {"hp-phoenix", "hp-goblet"}


def test_resolve_op_movie_partial_with_year_disambiguates() -> None:
    kind, payload = _resolve_op_movie("harry potter (2005)", PARTIAL_NAME_MOVIES)
    assert kind == "one" and payload["movieId"] == "hp-goblet"


def test_resolve_op_movie_sentence_like_title_resolves_by_title() -> None:
    """A real title containing "this" must resolve by title, not be treated as a pronoun."""
    kind, payload = _resolve_op_movie("I really want this movie", PARTIAL_NAME_MOVIES)
    assert kind == "one" and payload["movieId"] == "sentence"


def test_resolve_op_movie_no_year_title_resolves() -> None:
    kind, payload = _resolve_op_movie("Primer", PARTIAL_NAME_MOVIES)
    assert kind == "one" and payload["movieId"] == "primer"


def test_resolve_op_movie_named_year_absent_is_no_match() -> None:
    """A named year that no candidate has is a miss — never grab a different-year film."""
    kind, payload = _resolve_op_movie("Coherence (2099)", PARTIAL_NAME_MOVIES)
    assert kind == "none" and payload is None


@pytest.mark.parametrize("title", ["a", "I", "  "])
def test_resolve_op_movie_too_short_partial_does_not_match_everything(title: str) -> None:
    kind, _ = _resolve_op_movie(title, PARTIAL_NAME_MOVIES)
    assert kind == "none"


# ============================================================================
# _unique_exact_match — curator exact-match over ambiguous TMDB results (new bug 3)
# ============================================================================


def test_unique_exact_match_subset_superset_same_year_resolves_exact() -> None:
    """"Back to the Future (1985)" resolves the exact film, not the superset same-year title."""
    match = _unique_exact_match("Back to the Future", 1985, SUBSET_SUPERSET_SAME_YEAR)
    assert match is not None and match["sourceId"] == "tmdb:105"


def test_unique_exact_match_subset_superset_no_year_resolves_exact() -> None:
    # Even without a year, only "Back to the Future" exactly matches the title (the longer one
    # does not), so it resolves.
    match = _unique_exact_match("back to the future", None, SUBSET_SUPERSET_SAME_YEAR)
    assert match is not None and match["sourceId"] == "tmdb:105"


def test_unique_exact_match_superset_query_against_subset_is_none() -> None:
    # Querying the SUPERSET title against a set that has the subset only would not exact-match the
    # subset — only the exact title resolves; an unrelated query is None.
    match = _unique_exact_match("Forward to the Past", 1985, SUBSET_SUPERSET_SAME_YEAR)
    assert match is None


def test_unique_exact_match_exact_title_wrong_year_is_none() -> None:
    match = _unique_exact_match("Back to the Future", 1999, SUBSET_SUPERSET_SAME_YEAR)
    assert match is None


def test_unique_exact_match_multiple_exact_titles_is_none() -> None:
    # Two results with the SAME exact title (different years) + no year given → ambiguous → None.
    dupes = [
        {"sourceId": "tmdb:1", "title": "Dune", "year": 1984},
        {"sourceId": "tmdb:2", "title": "Dune", "year": 2021},
    ]
    assert _unique_exact_match("Dune", None, dupes) is None
    # …but a year disambiguates to one.
    one = _unique_exact_match("Dune", 2021, dupes)
    assert one is not None and one["sourceId"] == "tmdb:2"


@pytest.mark.parametrize("query", ["", "   "])
def test_unique_exact_match_empty_query_is_none(query: str) -> None:
    assert _unique_exact_match(query, 1985, SUBSET_SUPERSET_SAME_YEAR) is None


# ============================================================================
# 047 US4 (T071): the multi-select reply resolver
#
# The confirm action posts ONE message ("Selected: DVD, Blu-Ray") through the same send path
# the dock input uses, and the organizer resolves it in pure code against the options it
# offered. FR-036 requires a typed reply to reach the same result as tapping — no step of the
# ownership flow may be reachable only by tapping.
#
# Registered in the shared catalogue the moment it was written (013 Inc5 lesson: a resolver
# not in the catalogue is not covered by the harness).
# ============================================================================


@pytest.mark.parametrize(("reply", "expected"), MULTI_SELECT_REPLIES)
def test_multi_select_resolver_resolves_offered_values(reply: str, expected: list[str]) -> None:
    assert resolve_multi_select(reply, MEDIA_FORMAT_OPTIONS) == expected


@pytest.mark.parametrize("reply", MULTI_SELECT_EMPTY_REPLIES)
def test_multi_select_resolver_treats_none_as_an_empty_selection(reply: str) -> None:
    """FR-028: confirming zero selections is a valid ANSWER, not a failure to answer."""
    assert resolve_multi_select(reply, MEDIA_FORMAT_OPTIONS) == []


@pytest.mark.parametrize("reply", MULTI_SELECT_UNRESOLVABLE_REPLIES)
def test_multi_select_resolver_returns_none_when_nothing_is_named(reply: str) -> None:
    """An unrelated reply must re-ask, NOT record "I own it on nothing".

    This is the distinction that matters most in the resolver: `[]` and `None` are different
    answers, and collapsing them would silently store an empty ownership the member never gave.
    """
    assert resolve_multi_select(reply, MEDIA_FORMAT_OPTIONS) is None


def test_multi_select_resolver_never_invents_a_value_not_on_offer() -> None:
    """Closure: every returned value is offered — never a guessed domain value."""
    result = resolve_multi_select("dvd, betamax, laserdisc", MEDIA_FORMAT_OPTIONS)
    assert result is not None
    assert set(result) <= set(MEDIA_FORMAT_OPTIONS)
    assert result == ["DVD"]


def test_multi_select_resolver_returns_canonical_casing_not_the_typed_casing() -> None:
    """The stored value must be the DOMAIN's spelling, whatever the member typed."""
    assert resolve_multi_select("uhd blu-ray", MEDIA_FORMAT_OPTIONS) == ["UHD Blu-Ray"]


def test_multi_select_resolver_deduplicates_a_repeated_value() -> None:
    assert resolve_multi_select("DVD, dvd, DVD", MEDIA_FORMAT_OPTIONS) == ["DVD"]


def test_multi_select_resolver_prefers_the_longest_matching_option() -> None:
    """"Blu-Ray 3D" must not be shadowed by the shorter "Blu-Ray" it contains."""
    assert resolve_multi_select("Blu-Ray 3D", MEDIA_FORMAT_OPTIONS) == ["Blu-Ray 3D"]
    assert resolve_multi_select("Selected: Blu-Ray 3D", MEDIA_FORMAT_OPTIONS) == ["Blu-Ray 3D"]


def test_multi_select_resolver_with_no_options_offered_returns_none() -> None:
    assert resolve_multi_select("DVD", []) is None


# ── navigator movie resolution (047 US1 / T016) ──────────────────────────────────────────────────

import pytest as _pytest  # noqa: E402

from src.nodes.navigator import _match_movie as _nav_match_movie  # noqa: E402
from src.nodes.navigator import _mentions_a_movie, _movie_term  # noqa: E402
from tests.fixtures.adversarial import (  # noqa: E402
    NAV_FILLER_WORD_TITLES,
    NAV_PREFIX_COLLISION_MOVIES,
    NAV_SAME_TITLE_DIFFERENT_YEARS,
    NAV_SHORT_TITLE_MOVIES,
)


def test_nav_short_titles_never_match_from_a_substring() -> None:
    """"Up"/"It"/"Pi" appear inside ordinary words — the 4-char guard must hold."""
    for text in ("open it up in my list", "take me to pi", "show it"):
        assert _nav_match_movie(text, NAV_SHORT_TITLE_MOVIES) is None


def test_nav_prefix_collision_resolves_the_specific_title() -> None:
    """A bare prefix must not shadow the longer, more specific film."""
    assert _nav_match_movie("open Coherence", NAV_PREFIX_COLLISION_MOVIES)["title"] == "Coherence"
    # Both titles are substrings of this text, so it is ambiguous → ask, never guess.
    assert _nav_match_movie("open Coherence: Resurgence", NAV_PREFIX_COLLISION_MOVIES) is None


def test_nav_same_title_different_years_is_ambiguous() -> None:
    assert _nav_match_movie("open The Thing", NAV_SAME_TITLE_DIFFERENT_YEARS) is None


@_pytest.mark.parametrize("movie", NAV_FILLER_WORD_TITLES)
def test_nav_filler_worded_titles_still_trigger_a_read(movie: dict) -> None:
    """A title made only of navigation words must not be erased by term extraction.

    Regression guard for 047 US1: stripping "open"/"the"/"collection" left an EMPTY term, so the
    navigator decided the request named no movie and never looked — a member asking to open "The
    Collection" was asked which collection they meant.
    """
    text = f"open {movie['title']}"
    assert _movie_term(text), f"term extraction erased {movie['title']!r} entirely"
    assert _mentions_a_movie(text, ""), f"{movie['title']!r} would not trigger a movie read"
    assert _nav_match_movie(text, NAV_FILLER_WORD_TITLES) == movie
