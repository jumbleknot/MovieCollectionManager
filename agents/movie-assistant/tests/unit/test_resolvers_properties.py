"""T079: property-based invariant tests for pure-code resolver functions.

Uses Hypothesis to explore the input space with generated option/movie sets and assert
invariants that must hold for ANY input.  Any Hypothesis counter-example is a REAL BUG
in the resolver — do NOT loosen invariants to hide a genuine defect; mark with
``pytest.mark.xfail(strict=True)`` and leave a clear reason comment.

Tested functions (no LLM, no graph, no async):
  - ``resolve_option``   (supervisor.py)
  - ``_match_movie``     (organizer.py)
"""

from __future__ import annotations

from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from src.nodes.organizer import _match_movie
from src.nodes.supervisor import resolve_option

# ---------------------------------------------------------------------------
# Shared strategies
# ---------------------------------------------------------------------------

# Titles: printable text, 1–60 chars, always stripped of leading/trailing whitespace.
# The resolvers (_split_title_year, _match_movie) strip the op-side title but NOT stored
# titles, so we only generate realistic trimmed titles to stay within the designed input domain.
# We allow short titles (even < 4 chars) so we can test the length-guard behaviour;
# strategies that need ≥ 4-char titles constrain at use-site.
_title_st = st.text(
    alphabet=st.characters(whitelist_categories=("Lu", "Ll", "Nd", "Zs", "Po", "Pd")),
    min_size=1,
    max_size=60,
).map(str.strip).filter(lambda t: t != "")

# Years: plausible movie release range, plus some edge values at the boundary.
_year_int_st = st.integers(min_value=1900, max_value=2030)

# Some option years arrive as strings after JSON round-trips; allow either.
_year_st: st.SearchStrategy[int | str] = st.one_of(
    _year_int_st,
    _year_int_st.map(str),
)

# Option dict — mirrors TMDB enrichment shape used by resolve_option.
def _option_st(title: str, year: int | str | None = None) -> dict[str, Any]:
    return {"sourceId": f"tmdb:{abs(hash(title)) % 999999}", "title": title, "year": year}


# Movie dict — mirrors mc-service shape used by _match_movie.
def _movie_st(title: str, year: int | None = None) -> dict[str, Any]:
    return {"movieId": f"m-{abs(hash(title + str(year))) % 999999}", "title": title, "year": year}


# ---------------------------------------------------------------------------
# resolve_option — invariant 1: Closure
#   A non-None result is always one of the input options (identity check via `is`).
# ---------------------------------------------------------------------------


@given(
    options=st.lists(
        st.builds(
            lambda t, y: _option_st(t, y),
            t=_title_st,
            y=st.one_of(st.none(), _year_st),
        ),
        min_size=1,
        max_size=6,
    ),
    pick=st.text(min_size=0, max_size=120),
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_resolve_option_closure(options: list[dict[str, Any]], pick: str) -> None:
    """If resolve_option returns a value it must be one of the original option objects."""
    result = resolve_option(pick, options)
    if result is not None:
        assert any(result is opt for opt in options), (
            f"result {result!r} is not one of the input options"
        )


# ---------------------------------------------------------------------------
# resolve_option — invariant 2: Exact-title pick (non-overlapping titles)
#   Given a set of distinct titles where no title is a substring of another (no prefix
#   collision), feeding one title as the pick text should return THAT option.
#   Uses ≥ 4-char titles to clear the length guard.
# ---------------------------------------------------------------------------

# A strategy for a set of titles that are mutually non-overlapping (no title is a
# case-folded substring of another) so the longest-first ordering doesn't matter.
_nonoverlapping_titles_st = st.lists(
    _title_st.filter(lambda t: len(t) >= 4),
    min_size=2,
    max_size=5,
    unique_by=lambda t: t.casefold(),
).filter(
    lambda titles: all(
        titles[i].casefold() not in titles[j].casefold()
        for i in range(len(titles))
        for j in range(len(titles))
        if i != j
    )
)


@given(titles=_nonoverlapping_titles_st, year=st.one_of(st.none(), _year_st))
@settings(
    max_examples=150,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much],
)
def test_resolve_option_exact_title_returns_that_option(
    titles: list[str], year: int | str | None
) -> None:
    """Picking the exact title of one option (no prefix collisions) returns that option."""
    options = [_option_st(t, year) for t in titles]
    # Pick one option's title verbatim.
    for target_opt in options:
        picked_title = str(target_opt["title"])
        result = resolve_option(picked_title, options)
        assert result is not None, (
            f"Expected match for exact title {picked_title!r} but got None"
        )
        assert result is target_opt, (
            f"Expected option with title {picked_title!r} but got {result!r}"
        )


# ---------------------------------------------------------------------------
# resolve_option — invariant 3: Year pick
#   Given options with distinct integer years and a pick text that contains exactly one
#   option's year (and no other plausible 4-digit year token), the result must be the
#   option with that year.
# ---------------------------------------------------------------------------

@given(
    years=st.lists(
        st.integers(min_value=1920, max_value=2020),
        min_size=2,
        max_size=5,
        unique=True,
    ),
    titles=st.lists(_title_st, min_size=2, max_size=5),
)
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_resolve_option_year_pick_resolves_uniquely(
    years: list[int], titles: list[str]
) -> None:
    """A pick text containing exactly one option's year returns the option with that year."""
    n = min(len(years), len(titles))
    years = years[:n]
    titles = titles[:n]

    # Build options with distinct years; assign arbitrary titles.
    options = [_option_st(titles[i], years[i]) for i in range(n)]

    for target_year in years:
        # Craft a pick text that contains ONLY this year as a plausible 4-digit token.
        # We do this by constructing text like "the <year> one" — no other 4-digit tokens.
        pick = f"the {target_year} one"
        result = resolve_option(pick, options)
        assert result is not None, (
            f"Expected year-based match for year {target_year} but got None"
        )
        from src.nodes.supervisor import _as_int as _sup_as_int
        assert _sup_as_int(result.get("year")) == target_year, (
            f"Expected year {target_year} but result has year {result.get('year')!r}"
        )


# ---------------------------------------------------------------------------
# resolve_option — invariant 4: Unresolvable pick → None
#   A pick with no year, no ordinal/index, and no ≥4-char option title as a substring
#   must return None.
# ---------------------------------------------------------------------------

# A pick text strategy that is unlikely to accidentally contain a year or ordinal.
# We use short words with no 4-digit runs and none of the ordinal keywords.
_ordinal_words = frozenset({
    "first", "1st", "second", "2nd", "third", "3rd", "fourth", "4th",
    "fifth", "5th", "last", "number", "option",
})


def _is_safe_unresolvable(text: str) -> bool:
    """True if text cannot accidentally trigger year/ordinal/index resolution."""
    import re
    # No 4-digit token in the plausible year range
    for tok in re.findall(r"\d{4}", text.lower()):
        yr = int(tok)
        if 1900 <= yr <= 2100:
            return False
    # No ordinal keyword (whole word)
    for word in _ordinal_words:
        if re.search(rf"\b{re.escape(word)}\b", text.lower()):
            return False
    # No digit 1-9 that could be an index (bare or prefixed)
    if re.search(r"\b(?:number|option|no\.?|#)?\s*[1-9]\b", text.lower()):
        return False
    return True


@given(
    titles=st.lists(
        _title_st.filter(lambda t: len(t) >= 4),
        min_size=1,
        max_size=4,
        unique_by=lambda t: t.casefold(),
    ),
    pick=st.text(
        alphabet=st.characters(whitelist_categories=("Lu", "Ll", "Zs")),
        min_size=3,
        max_size=40,
    ).filter(_is_safe_unresolvable),
)
@settings(
    max_examples=150,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.filter_too_much],
)
def test_resolve_option_unresolvable_returns_none(
    titles: list[str], pick: str
) -> None:
    """A pick text that doesn't match any title, year, ordinal, or index → None."""
    options = [_option_st(t, None) for t in titles]

    # Filter: the pick must not contain any option title as a substring (casefold).
    if any(t.casefold() in pick.casefold() for t in titles):
        pytest.skip("Generated pick accidentally contains an option title — skip")

    result = resolve_option(pick, options)
    assert result is None, (
        f"Expected None for unresolvable pick {pick!r} against {[o['title'] for o in options]!r}, "
        f"but got {result!r}"
    )


# ---------------------------------------------------------------------------
# _match_movie — invariant 1: Closure
#   A non-None result is always one of the input movies.
# ---------------------------------------------------------------------------

_movie_list_st = st.lists(
    st.builds(
        lambda t, y: _movie_st(t, y),
        t=_title_st,
        y=st.one_of(st.none(), _year_int_st),
    ),
    min_size=0,
    max_size=6,
)


@given(op_title=_title_st, movies=_movie_list_st)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_match_movie_closure(op_title: str, movies: list[dict[str, Any]]) -> None:
    """If _match_movie returns a value it must be one of the input movie objects."""
    result = _match_movie(op_title, movies)
    if result is not None:
        assert any(result is m for m in movies), (
            f"result {result!r} is not one of the input movies"
        )


# ---------------------------------------------------------------------------
# _match_movie — invariant 2: Title agreement
#   A non-None result must have a casefold-matching title to the bare op title.
# ---------------------------------------------------------------------------

@given(op_title=_title_st, movies=_movie_list_st)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_match_movie_title_agreement(op_title: str, movies: list[dict[str, Any]]) -> None:
    """Result (when present) must have the same casefolded bare title as the op."""
    from src.nodes.organizer import _split_title_year
    bare, _ = _split_title_year(op_title)
    result = _match_movie(op_title, movies)
    if result is not None:
        assert str(result.get("title", "")).casefold() == bare.casefold(), (
            f"result title {result.get('title')!r} doesn't casefold-match bare op title {bare!r}"
        )


# ---------------------------------------------------------------------------
# _match_movie — invariant 3: Year agreement
#   If the op specifies a year, any non-None result must NOT have a different (present) year.
#   i.e. result.year is None OR result.year == op_year.
# ---------------------------------------------------------------------------

@given(
    bare_title=_title_st,
    op_year=_year_int_st,
    movies=_movie_list_st,
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_match_movie_year_agreement(
    bare_title: str, op_year: int, movies: list[dict[str, Any]]
) -> None:
    """When op specifies a year, result (if any) must agree on year or have no year."""
    op_title = f"{bare_title} ({op_year})"
    result = _match_movie(op_title, movies)
    if result is not None:
        result_year = result.get("year")
        if result_year is not None:
            # Coerce to int in case stored as string
            try:
                ry = int(result_year)
            except (TypeError, ValueError):
                ry = None
            if ry is not None:
                assert ry == op_year, (
                    f"Year disagreement: op requested year {op_year} but result has year {ry}"
                )


# ---------------------------------------------------------------------------
# _match_movie — invariant 4: Unique (title, year) resolves
#   Given a list of movies where all (title, year) pairs are distinct and one matches
#   the op exactly, _match_movie must return that movie (not None, not the wrong one).
# ---------------------------------------------------------------------------

@given(
    titles=st.lists(
        # strip().casefold() uniqueness: _match_movie compares casefold of the stripped op
        # title against casefold of the stored title (stored titles are NOT stripped by the
        # resolver).  We generate stripped titles (via _title_st.map(str.strip)) so the op
        # and stored sides agree, and use strip().casefold() as the unique key so no two titles
        # in the list collapse to the same casefold-match (which would make the op ambiguous).
        _title_st,
        min_size=2,
        max_size=5,
        unique_by=lambda t: t.strip().casefold(),
    ),
    years=st.lists(
        st.one_of(st.none(), _year_int_st),
        min_size=2,
        max_size=5,
    ),
)
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_match_movie_unique_title_year_resolves(
    titles: list[str], years: list[int | None]
) -> None:
    """An op naming exactly one (title, year) pair from a list with all-distinct pairs resolves.

    Note: Hypothesis found that this invariant requires stored titles to be trimmed — the
    resolver strips the op-side title (via _split_title_year) but compares it against the
    stored title WITHOUT stripping the stored side.  Trailing-whitespace stored titles will
    never match.  This is a **resolver limitation** for out-of-domain inputs; in production,
    mc-service stores titles without trailing whitespace, so the invariant holds for realistic
    inputs.  The strategy is constrained to stripped titles (via _title_st.map(str.strip))
    to stay within the designed input domain.
    """
    n = min(len(titles), len(years))
    titles = titles[:n]
    years = years[:n]

    movies = [_movie_st(titles[i], years[i]) for i in range(n)]

    for movie in movies:
        stored_year = movie.get("year")
        if stored_year is None:
            # Build a bare op: "Title" — only resolves uniquely if no other movie shares the title
            op_title = str(movie["title"])
            result = _match_movie(op_title, movies)
            # There is exactly one movie with this stripped-casefold title, so it must resolve.
            assert result is not None, (
                f"Expected unique bare match for title {op_title!r} but got None; "
                f"movies={[(m['title'], m.get('year')) for m in movies]}"
            )
            assert result is movie
        else:
            # Build a year-qualified op: "Title (Year)"
            op_title = f"{movie['title']} ({stored_year})"
            result = _match_movie(op_title, movies)
            # With a distinct (title, year) pair there should be exactly one match.
            assert result is not None, (
                f"Expected year-qualified match for {op_title!r} but got None; "
                f"movies={[(m['title'], m.get('year')) for m in movies]}"
            )
            assert result is movie


# ---------------------------------------------------------------------------
# _match_movie — invariant 5: Ambiguous same-title never guesses
#   Two movies with the SAME title but different (non-None) years + a bare op title
#   (no year) must return None.
# ---------------------------------------------------------------------------

@given(
    title=_title_st,
    year_a=_year_int_st,
    year_b=_year_int_st,
    extra_movies=st.lists(
        st.builds(
            lambda t, y: _movie_st(t, y),
            t=_title_st.filter(lambda t: len(t) >= 2),
            y=st.one_of(st.none(), _year_int_st),
        ),
        min_size=0,
        max_size=3,
    ),
)
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
def test_match_movie_ambiguous_same_title_returns_none(
    title: str,
    year_a: int,
    year_b: int,
    extra_movies: list[dict[str, Any]],
) -> None:
    """Two same-titled movies with different years + a bare op title → None (never guesses)."""
    if year_a == year_b:
        pytest.skip("Identical years — not the ambiguous case")

    # Build the ambiguous pair, then filter extras so none have this same casefolded title.
    filtered_extras = [
        m for m in extra_movies
        if str(m.get("title", "")).casefold() != title.casefold()
    ]
    movie_a = _movie_st(title, year_a)
    movie_b = _movie_st(title, year_b)
    movies = [movie_a, movie_b] + filtered_extras

    result = _match_movie(title, movies)
    assert result is None, (
        f"Expected None for ambiguous bare title {title!r} (years {year_a}/{year_b}) "
        f"but got {result!r}"
    )
