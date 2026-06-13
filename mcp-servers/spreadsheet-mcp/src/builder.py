"""Workbook building (per-collection movie data → one multi-tab .xlsx). Implemented in T042;
this is the T001 skeleton.
"""

from __future__ import annotations

from typing import Any


class WorkbookBuildError(Exception):
    """Empty tabs / write failure."""


def build_workbook_bytes(
    tabs: list[dict[str, Any]], multi_value_delimiter: str = "|"
) -> tuple[bytes, str]:
    """Build a multi-tab `.xlsx` → `(bytes, filename)`. Implemented in T042."""
    raise NotImplementedError("build_workbook_bytes is implemented in T042 (US3)")
