"""Spreadsheet parsing (CSV / .xlsx → structured tabs). Pure structural extraction — NO column
classification or collection matching (that is the orchestration node's job). Implements T021.

Eligibility (FR-008) is the only semantic judgement made here: a tab is importable iff it
carries the three required concepts — Title, Year, and Content Type (the sample fixture spells
content type as "Video Type"). Everything else is verbatim structure: ordered columns with
sampled values, and rows keyed by header with every cell coerced to a string. Empty/corrupt/
unsupported input raises with no partial result (FR-022).
"""

from __future__ import annotations

import csv
import io
import zipfile
from datetime import date, datetime
from pathlib import PurePosixPath
from typing import Any

import openpyxl
from openpyxl.utils.exceptions import InvalidFileException

# Required-concept header aliases (case-insensitive) for the FR-008 eligibility gate. This is a
# minimal structural pre-filter, NOT the column→attribute mapping (that lives in the agent node).
_TITLE_HEADERS = frozenset({"title"})
_YEAR_HEADERS = frozenset({"year"})
_CONTENT_TYPE_HEADERS = frozenset({"content type", "video type", "type"})


class SpreadsheetParseError(Exception):
    """Unreadable/corrupt/empty/unsupported file (FR-022). No partial result on a bad file."""


def parse_workbook(data: bytes, filename: str, sample_size: int = 20) -> dict[str, Any]:
    """Parse raw file bytes into `{ "tabs": [...] }`.

    `filename` only disambiguates CSV vs .xlsx (extension first, content sniff as fallback) and
    names the single implicit CSV tab; it is never trusted for logic.
    """
    if not data:
        raise SpreadsheetParseError("empty file")
    if _detect_kind(filename, data) == "xlsx":
        return _parse_xlsx(data, sample_size)
    return _parse_csv(data, filename, sample_size)


def _detect_kind(filename: str, data: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm")):
        return "xlsx"
    if name.endswith(".csv"):
        return "csv"
    # No usable extension — sniff: every .xlsx is a ZIP container ("PK\x03\x04").
    return "xlsx" if data[:4] == b"PK\x03\x04" else "csv"


def _parse_xlsx(data: bytes, sample_size: int) -> dict[str, Any]:
    try:
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except (InvalidFileException, zipfile.BadZipFile, OSError, ValueError, KeyError) as exc:
        raise SpreadsheetParseError(f"unreadable spreadsheet: {exc}") from exc
    try:
        tabs = [
            _build_tab(ws.title, list(ws.iter_rows(values_only=True)), sample_size)
            for ws in workbook.worksheets
        ]
    finally:
        workbook.close()
    if not tabs:
        raise SpreadsheetParseError("workbook has no sheets")
    return {"tabs": tabs}


def _parse_csv(data: bytes, filename: str, sample_size: int) -> dict[str, Any]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    rows_values: list[tuple[Any, ...]] = [tuple(row) for row in csv.reader(io.StringIO(text))]
    if not rows_values:
        raise SpreadsheetParseError("empty csv")
    name = PurePosixPath(filename or "import.csv").stem or "Sheet1"
    return {"tabs": [_build_tab(name, rows_values, sample_size)]}


def _build_tab(
    name: str, rows_values: list[tuple[Any, ...]], sample_size: int
) -> dict[str, Any]:
    if not rows_values:
        return {"name": name, "eligible": False, "columns": [], "rowCount": 0, "rows": []}

    # First row = headers. Keep only non-empty headers, preserving their source column index.
    indexed = [
        (i, header)
        for i, raw in enumerate(rows_values[0])
        if (header := _cell_to_str(raw).strip())
    ]
    headers = [header for _, header in indexed]
    samples: dict[str, list[str]] = {header: [] for header in headers}

    data_rows: list[dict[str, str]] = []
    for values in rows_values[1:]:
        row: dict[str, str] = {}
        has_value = False
        for index, header in indexed:
            cell = _cell_to_str(values[index] if index < len(values) else None)
            row[header] = cell
            if cell.strip():
                has_value = True
                if len(samples[header]) < sample_size:
                    samples[header].append(cell)
        if has_value:  # drop fully-blank rows
            data_rows.append(row)

    headers_lower = {header.casefold() for header in headers}
    return {
        "name": name,
        "eligible": _is_eligible(headers_lower),
        "columns": [{"header": header, "sampleValues": samples[header]} for header in headers],
        "rowCount": len(data_rows),
        "rows": data_rows,
    }


def _is_eligible(headers_lower: set[str]) -> bool:
    """FR-008: a tab is importable iff it has Title, Year, and Content Type columns."""
    return (
        bool(headers_lower & _TITLE_HEADERS)
        and bool(headers_lower & _YEAR_HEADERS)
        and bool(headers_lower & _CONTENT_TYPE_HEADERS)
    )


def _cell_to_str(value: Any) -> str:
    """Coerce any cell to its raw display string. None → "". Dates → ISO; integral floats → int."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        if (value.hour, value.minute, value.second, value.microsecond) == (0, 0, 0, 0):
            return value.date().isoformat()
        return value.isoformat(sep=" ")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)
