"""Workbook building (per-collection movie data → one multi-tab .xlsx). Implements T042.

Pure structural assembly — the export node selects the attribute set (FR-026) and decides which
cells are multi-valued; this layer only lays out sheets. One sheet per tab, header row from the
ordered `columns`, each row written in column order (a missing attribute → a blank cell), and a
collection with zero movies yields a header-only sheet. Multi-value cells (lists) are joined with
the delimiter (default `|`, FR-027); a pre-joined string passes through untouched. Sheet names are
made Excel-safe (forbidden chars stripped, ≤31 chars) and de-duplicated.
"""

from __future__ import annotations

import io
from typing import Any

import openpyxl

# Excel forbids these in a sheet name, and caps the name at 31 chars.
_FORBIDDEN_SHEET_CHARS = set(r"[]:*?/\\")
_MAX_SHEET_NAME = 31

EXPORT_FILENAME = "movie-collections-export.xlsx"

# A cell whose text begins with one of these is interpreted as a live formula by Excel/Sheets
# (CSV/formula injection). Movie/collection text is user-supplied and untrusted, so a leading
# trigger is escaped with an apostrophe. The import parser strips exactly this guard apostrophe
# (parser._cell_to_str) so an export→import round-trip is symmetric (SC-004). Keep the two sets
# in sync.
_FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")


class WorkbookBuildError(Exception):
    """Empty tabs / write failure."""


def build_workbook_bytes(
    tabs: list[dict[str, Any]], multi_value_delimiter: str = "|"
) -> tuple[bytes, str]:
    """Build a multi-tab `.xlsx` → `(bytes, filename)`.

    Each `tabs[]` entry is `{ collectionName, columns: [str], rows: [{attr: str|list}] }`.
    """
    if not tabs:
        raise WorkbookBuildError("cannot build a workbook with no tabs")

    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)  # drop the implicit default sheet
    used_names: set[str] = set()

    for tab in tabs:
        sheet = workbook.create_sheet(
            _unique_sheet_name(tab.get("collectionName", ""), used_names)
        )
        columns = list(tab.get("columns", []))
        sheet.append(columns)
        for row in tab.get("rows", []):
            sheet.append([_cell(row.get(col), multi_value_delimiter) for col in columns])

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue(), EXPORT_FILENAME


def _cell(value: Any, delimiter: str) -> str:
    """Render a cell: list → delimiter-joined; None → ""; everything else → str.

    A leading formula-trigger character is escaped with an apostrophe so untrusted text can never
    execute as a formula when the workbook is opened. The import parser reverses this (symmetric).
    """
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        rendered = delimiter.join(str(v) for v in value)
    else:
        rendered = str(value)
    if rendered[:1] and rendered[0] in _FORMULA_TRIGGERS:
        return "'" + rendered
    return rendered


def _unique_sheet_name(raw: str, used: set[str]) -> str:
    """Excel-safe (forbidden chars stripped, ≤31 chars) + unique within the workbook."""
    base = "".join(c for c in (raw or "") if c not in _FORBIDDEN_SHEET_CHARS).strip()
    base = base[:_MAX_SHEET_NAME] or "Sheet"
    if base not in used:
        used.add(base)
        return base
    # Collision — append " (n)", trimming the base so the whole name still fits in 31 chars.
    for n in range(2, 1000):
        suffix = f" ({n})"
        candidate = base[: _MAX_SHEET_NAME - len(suffix)].rstrip() + suffix
        if candidate not in used:
            used.add(candidate)
            return candidate
    raise WorkbookBuildError(f"cannot de-duplicate sheet name: {raw!r}")
