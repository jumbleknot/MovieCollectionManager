"""Pure golden-pair comparison logic (T032)."""

from tests.golden.compare import compare_decision


def test_intent_exact_match():
    ok, _ = compare_decision("intent", "add", "add", None)
    assert ok


def test_intent_mismatch():
    ok, reason = compare_decision("intent", "add", "enrich", None)
    assert not ok
    assert "add" in reason and "enrich" in reason


def test_extraction_case_insensitive_title_and_collection():
    expected = {"title": "Coherence", "year": 2013, "collection": "Watchlist"}
    actual = {"title": "coherence", "year": 2013, "collection": "watchlist"}
    tol = {"title": "ci", "year": "exact", "collection": "ci"}
    ok, _ = compare_decision("extraction", expected, actual, tol)
    assert ok


def test_extraction_year_must_match_exactly():
    expected = {"title": "Dune", "year": None, "collection": "Sci-Fi"}
    actual = {"title": "Dune", "year": 2021, "collection": "Sci-Fi"}
    tol = {"title": "ci", "year": "exact", "collection": "ci"}
    ok, reason = compare_decision("extraction", expected, actual, tol)
    assert not ok
    assert "year" in reason


def test_extraction_ignores_extra_actual_keys():
    expected = {"title": "Dune", "year": None, "collection": "Sci-Fi"}
    actual = {"title": "Dune", "year": None, "collection": "Sci-Fi", "confidence": "high"}
    tol = {"title": "ci", "year": "exact", "collection": "ci"}
    ok, _ = compare_decision("extraction", expected, actual, tol)
    assert ok
