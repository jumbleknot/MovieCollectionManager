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

    raise ValueError(f"unknown golden kind: {kind!r}")
