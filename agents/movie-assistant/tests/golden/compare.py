"""Pure comparison of a model decision against a golden expectation (T032).

Kept dependency-free and side-effect-free so it is unit-testable without any model call.
"""

from typing import Any


def _norm(value: Any, rule: str) -> Any:
    if rule == "ci" and isinstance(value, str):
        return value.strip().casefold()
    return value


_SUFFIX = " collection"


def _same_collection(expected: Any, actual: Any) -> bool:
    """Case-insensitive, and `X collection` (actual) equals `X` (expected) — spec 093.

    One way only, mirroring the organizer's `_resolve_target`: it drops a trailing "collection"
    from the model's name, never adds one, so an expected `Movie Collection` is not met by `Movie`.
    """
    exp, act = _norm(expected, "ci"), _norm(actual, "ci")
    if exp == act:
        return True
    return (
        isinstance(act, str)
        and isinstance(exp, str)
        and act.endswith(_SUFFIX)
        and act.removesuffix(_SUFFIX).strip() == exp
    )


def compare_decision(
    kind: str,
    expected: Any,
    actual: Any,
    tolerance: dict[str, str] | None,
) -> tuple[bool, str]:
    """Return (matches, reason). `kind` is 'intent' or 'extraction'."""
    if kind == "intent":
        ok = str(actual).strip().lower() == str(expected).strip().lower()
        return ok, ("" if ok else f"intent expected {expected!r}, got {actual!r}")

    if kind == "extraction":
        tol = tolerance or {}
        if not isinstance(actual, dict):
            return False, f"extraction expected an object, got {actual!r}"
        for field_name, exp_value in expected.items():
            rule = tol.get(field_name, "exact")
            act_value = actual.get(field_name)
            if _norm(exp_value, rule) != _norm(act_value, rule):
                return False, f"field {field_name!r} expected {exp_value!r}, got {act_value!r}"
        return True, ""

    if kind == "query-extraction":
        # The US4 query extraction (extract_query): {collection_ref, movie_title, filter}. Flat
        # fields use their tolerance (ci/exact); the nested `filter` compares only the sub-keys the
        # exemplar pins, keyed as "filter.<sub>" in tolerance (e.g. filter.decade exact). Unpinned
        # filter sub-keys (model-phrasing-sensitive) are left to the deterministic unit tests.
        tol = tolerance or {}
        if not isinstance(actual, dict):
            return False, f"query-extraction expected an object, got {actual!r}"
        for field_name, exp_value in expected.items():
            if field_name == "filter":
                act_filter = actual.get("filter")
                if not isinstance(act_filter, dict):
                    return False, f"filter expected an object, got {act_filter!r}"
                for fkey, fexp in (exp_value or {}).items():
                    rule = tol.get(f"filter.{fkey}", "exact")
                    if _norm(fexp, rule) != _norm(act_filter.get(fkey), rule):
                        return False, (
                            f"filter.{fkey} expected {fexp!r}, got {act_filter.get(fkey)!r}"
                        )
                continue
            rule = tol.get(field_name, "exact")
            if _norm(exp_value, rule) != _norm(actual.get(field_name), rule):
                return False, (
                    f"field {field_name!r} expected {exp_value!r}, got {actual.get(field_name)!r}"
                )
        return True, ""

    if kind == "plan":
        # The organize plan decision (plan_operations): the target collection (case-insensitive)
        # plus the SET of (op, title, dest) operations — order-insensitive, since the order is
        # immaterial and code resolves/orders them. A move's destination (`to`) IS gated (ci) —
        # a wrong-destination move is a data-integrity bug worth catching at the gate. An
        # update's `changes` payload is intentionally NOT gated (model-phrasing-sensitive — flag
        # echoing / tag order / casing); it is pinned by the deterministic unit tests instead.
        if not isinstance(actual, dict):
            return False, f"plan expected an object, got {actual!r}"
        if not _same_collection(expected.get("collection"), actual.get("collection")):
            return False, (
                f"collection expected {expected.get('collection')!r}, "
                f"got {actual.get('collection')!r}"
            )
        exp_ops = _op_set(expected.get("operations"))
        # A move destination gets the same one-way suffix rule: an actual `to` of `X collection`
        # is read as `X` only when `X` is a destination the expectation names (spec 093).
        exp_dests = {dest for (_, _, dest) in exp_ops if dest}
        act_ops = {
            (op, title, next((d for d in exp_dests if _same_collection(d, dest)), dest))
            for (op, title, dest) in _op_set(actual.get("operations"))
        }
        if exp_ops != act_ops:
            return False, f"operations expected {sorted(exp_ops)}, got {sorted(act_ops)}"
        return True, ""

    raise ValueError(f"unknown golden kind: {kind!r}")


def _op_set(operations: Any) -> set[tuple[str, str, str]]:
    if not isinstance(operations, list):
        return set()
    return {
        (
            str(o.get("op")).strip().lower(),
            str(o.get("title")).strip().casefold(),
            str(o.get("to") or "").strip().casefold(),  # move destination ("" for non-move ops)
        )
        for o in operations
        if isinstance(o, dict)
    }
