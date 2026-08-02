"""T027: adversarial unit tests for the title-article normalizer + multi-value splitter (US2).

`normalize_title_article` converts the trailing-article sort convention ("Matrix, The")
into the leading form ("The Matrix") for English The/A/An only; an ambiguous trailing
comma-word ("Goodbye, Lenin!") sets needs_confirm rather than guessing (clarification Q4).
`split_multi_value` splits a `|`-delimited cell into trimmed, non-empty values (FR-016).

Covers: US2-AC4, US2-AC5, FR-014/015/016.
"""

from __future__ import annotations

import pytest

from src.nodes.import_resolvers import (
    TitleNormalization,
    normalize_title_article,
    split_multi_value,
)

# ---------------------------------------------------------------------------
# Article normalization
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "original,expected_normalized,expected_article",
    [
        ("Matrix, The", "The Matrix", "The"),
        ("Terminator, The", "The Terminator", "The"),
        ("Bug's Life, A", "A Bug's Life", "A"),
        ("American Werewolf in London, An", "An American Werewolf in London", "An"),
        # Case-insensitive detection, canonical-cased output article.
        ("matrix, the", "The matrix", "The"),
        ("HISTORY OF VIOLENCE, A", "A HISTORY OF VIOLENCE", "A"),
        # Surrounding whitespace tolerated.
        ("  Matrix , The  ", "The Matrix", "The"),
    ],
)
def test_trailing_article_moves_to_front(
    original: str, expected_normalized: str, expected_article: str
) -> None:
    result = normalize_title_article(original)
    assert result.normalized == expected_normalized
    assert result.article == expected_article
    assert result.needs_confirm is False
    assert result.original == original


@pytest.mark.parametrize(
    "title",
    [
        "The Matrix",  # already leading
        "Inception",  # no article
        "Crouching Tiger, Hidden Dragon",  # real comma, multi-word suffix
        "Sex, Lies, and Videotape",  # internal commas, multi-word suffix
    ],
)
def test_non_article_titles_pass_through(title: str) -> None:
    result = normalize_title_article(title)
    assert result.normalized == title.strip()
    assert result.article is None
    assert result.needs_confirm is False


@pytest.mark.parametrize(
    "title",
    [
        "Goodbye, Lenin!",  # trailing single comma-word, not an article
        "Amelie, Le",  # a non-English article → ask, do not move
        "Closer, To",  # plausible-looking but not The/A/An
    ],
)
def test_ambiguous_trailing_comma_word_needs_confirm(title: str) -> None:
    result = normalize_title_article(title)
    assert result.needs_confirm is True
    assert result.article is None
    # Nothing reordered until the user confirms.
    assert result.normalized == title.strip()


def test_empty_title_is_safe() -> None:
    result = normalize_title_article("")
    assert result.normalized == ""
    assert result.article is None
    assert result.needs_confirm is False


def test_title_normalization_is_immutable() -> None:
    result = normalize_title_article("Matrix, The")
    assert isinstance(result, TitleNormalization)
    with pytest.raises((AttributeError, TypeError)):
        result.normalized = "x"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Multi-value splitting
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cell,expected",
    [
        ("Action|Sci-Fi", ["Action", "Sci-Fi"]),
        ("Action", ["Action"]),
        ("", []),
        ("   ", []),
        ("  Action |  | Drama ", ["Action", "Drama"]),  # trims + drops empties
        ("A|B|C", ["A", "B", "C"]),
        ("Spielberg, Steven|Lucas, George", ["Spielberg, Steven", "Lucas, George"]),
    ],
)
def test_multi_value_split(cell: str, expected: list[str]) -> None:
    assert split_multi_value(cell) == expected


def test_multi_value_split_custom_delimiter() -> None:
    assert split_multi_value("Action;Drama", delimiter=";") == ["Action", "Drama"]


def test_multi_value_split_none_is_empty() -> None:
    assert split_multi_value(None) == []  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# 047 T031/T032 (FR-012): a multi-word comma suffix raises NO sorting question
#
# NOTE ON THE TASK PREMISE. T032 is phrased "confirm/repair" and the confirm branch is
# what applies: `normalize_title_article` already returns needs_confirm=False when the
# final comma-chunk contains a space, and "Crouching Tiger, Hidden Dragon" is already a
# parametrized case in test_non_article_titles_pass_through above. No repair was needed
# and no failing test could honestly be written for that behaviour.
#
# What was NOT covered, and is covered here, is the interaction 047 actually introduces:
# a multi-word comma suffix carrying SURROUNDING WHITESPACE. That combination is new —
# the trailing space is what broke the single-word case (US2), so it must be pinned that
# it does not push a genuine title comma into the question path.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "title,expected",
    [
        ("  Crouching Tiger, Hidden Dragon  ", "Crouching Tiger, Hidden Dragon"),
        ("Crouching Tiger, Hidden Dragon ", "Crouching Tiger, Hidden Dragon"),
        (" Sex, Lies, and Videotape", "Sex, Lies, and Videotape"),
        # Trailing whitespace INSIDE the final chunk must not make it look single-word.
        ("Cinema Paradiso, Nuovo Cinema  ", "Cinema Paradiso, Nuovo Cinema"),
    ],
)
def test_multi_word_suffix_with_whitespace_needs_no_confirm(title: str, expected: str) -> None:
    """FR-012: a real title comma stays a real title comma, whitespace or not."""
    result = normalize_title_article(title)
    assert result.needs_confirm is False, f"{title!r} was wrongly treated as a sorting article"
    assert result.article is None
    assert result.normalized == expected
    assert result.normalized == result.normalized.strip()


@pytest.mark.parametrize(
    "title",
    [
        "Three Billboards Outside Ebbing, Missouri ",  # single word → still asks
        "Goodbye, Lenin! ",
        "  Amelie, Le  ",
    ],
)
def test_single_word_suffix_with_whitespace_still_needs_confirm(title: str) -> None:
    """The contrast case: whitespace must not SUPPRESS a question that should be asked."""
    result = normalize_title_article(title)
    assert result.needs_confirm is True
    assert result.normalized == title.strip()
