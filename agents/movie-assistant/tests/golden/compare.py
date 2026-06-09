"""Pure comparison of a model decision against a golden expectation (T032).

Kept dependency-free and side-effect-free so it is unit-testable without any model call.
"""

from typing import Any


def _norm(value: Any, rule: str) -> Any:
    if rule == "ci" and isinstance(value, str):
        return value.strip().casefold()
    return value


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

    if kind == "plan":
        # The organize plan decision (plan_operations): the target collection (case-insensitive)
        # plus the SET of (op, title, dest) operations — order-insensitive, since the order is
        # immaterial and code resolves/orders them. A move's destination (`to`) IS gated (ci) —
        # a wrong-destination move is a data-integrity bug worth catching at the gate. An
        # update's `changes` payload is intentionally NOT gated (model-phrasing-sensitive — flag
        # echoing / tag order / casing); it is pinned by the deterministic unit tests instead.
        if not isinstance(actual, dict):
            return False, f"plan expected an object, got {actual!r}"
        if _norm(expected.get("collection"), "ci") != _norm(actual.get("collection"), "ci"):
            return False, (
                f"collection expected {expected.get('collection')!r}, "
                f"got {actual.get('collection')!r}"
            )
        exp_ops = _op_set(expected.get("operations"))
        act_ops = _op_set(actual.get("operations"))
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
