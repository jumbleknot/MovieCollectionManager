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
    expected = {"title": "Coherence", "year": 2013, "collection": "Favorites"}
    actual = {"title": "coherence", "year": 2013, "collection": "favorites"}
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


# ── plan (organize) — collection (ci) + order-insensitive (op, title) set ──────

def _plan(collection, *ops):
    return {"collection": collection, "operations": [{"op": o, "title": t} for o, t in ops]}


def test_plan_matches_regardless_of_operation_order():
    expected = _plan("Sci-Fi", ("remove", "The Matrix"), ("remove", "Inception"))
    actual = _plan("sci-fi", ("remove", "inception"), ("remove", "the matrix"))
    ok, _ = compare_decision("plan", expected, actual, None)
    assert ok


def test_plan_mismatch_on_missing_operation():
    expected = _plan("Sci-Fi", ("remove", "The Matrix"), ("remove", "Inception"))
    actual = _plan("Sci-Fi", ("remove", "The Matrix"))
    ok, reason = compare_decision("plan", expected, actual, None)
    assert not ok and "operations" in reason


def test_plan_mismatch_on_wrong_collection():
    ok, reason = compare_decision(
        "plan", _plan("Sci-Fi", ("remove", "Dune")), _plan("Favorites", ("remove", "Dune")), None
    )
    assert not ok and "collection" in reason


# ── plan: move destination is gated (ci), update `changes` is not (T070) ───────

def _move_plan(collection, title, to):
    return {"collection": collection, "operations": [{"op": "move", "title": title, "to": to}]}


def test_plan_move_matches_destination_case_insensitively():
    expected = _move_plan("Sci-Fi", "Inception", "Favorites")
    actual = _move_plan("Sci-Fi", "inception", "favorites")
    ok, _ = compare_decision("plan", expected, actual, None)
    assert ok


def test_plan_move_mismatch_on_wrong_destination():
    expected = _move_plan("Sci-Fi", "Inception", "Favorites")
    actual = _move_plan("Sci-Fi", "Inception", "Wishlist")
    ok, reason = compare_decision("plan", expected, actual, None)
    assert not ok and "operations" in reason


def test_plan_update_ignores_changes_dict():
    # The `changes` payload is intentionally NOT gated (model-phrasing-sensitive); only (op,
    # title) match. A differing `changes` must still compare equal.
    expected = {
        "collection": "Sci-Fi",
        "operations": [{"op": "update", "title": "Inception", "changes": {"owned": True}}],
    }
    actual = {
        "collection": "Sci-Fi",
        "operations": [
            {"op": "update", "title": "Inception", "changes": {"owned": True, "ripped": False}}
        ],
    }
    ok, _ = compare_decision("plan", expected, actual, None)
    assert ok
