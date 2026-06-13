"""Spreadsheet parsing (CSV / .xlsx → structured tabs). Pure structural extraction — NO column
classification or collection matching (that is the orchestration node's job). Implemented in
T021; this is the T001 skeleton.
"""

from __future__ import annotations

from typing import Any

# A tab is eligible for import only if it has at least these (case-insensitive) header concepts.
ELIGIBILITY_HEADERS = ("title", "year")


class SpreadsheetParseError(Exception):
    """Unreadable/corrupt/empty/unsupported file (FR-022). No partial result on a bad file."""


def parse_workbook(data: bytes, filename: str, sample_size: int = 20) -> dict[str, Any]:
    """Parse raw file bytes into `{ "tabs": [...] }`. Implemented in T021."""
    raise NotImplementedError("parse_workbook is implemented in T021 (US2)")
