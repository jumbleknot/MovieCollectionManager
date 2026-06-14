"""T020: unit matrix for parser.parse_workbook (US2 spreadsheet-mcp).

Drives the pure parser directly (no MCP transport, no Redis store) against the canonical
fixture docs/test-data/sample-movies.xlsx and small synthetic CSV/xlsx byte payloads.
Structural extraction only — eligibility (FR-008: Title + Year + Content Type) + columns
with sampled values + rows keyed by header (every cell stringified). Rejects empty/corrupt
files with no partial result (FR-022).

Covers: US2-AC1, FR-008, FR-022.
"""

from __future__ import annotations

import io
from pathlib import Path

import openpyxl
import pytest

from src.parser import SpreadsheetParseError, parse_workbook

REPO_ROOT = Path(__file__).resolve().parents[4]
SAMPLE_XLSX = REPO_ROOT / "docs" / "test-data" / "sample-movies.xlsx"


def _sample_bytes() -> bytes:
    return SAMPLE_XLSX.read_bytes()


def _tab(result: dict, name: str) -> dict:
    return next(t for t in result["tabs"] if t["name"] == name)


# ---------------------------------------------------------------------------
# Real fixture
# ---------------------------------------------------------------------------


def test_parses_both_sheets() -> None:
    result = parse_workbook(_sample_bytes(), "sample-movies.xlsx")
    assert {t["name"] for t in result["tabs"]} == {"Sample", "Lists"}


def test_eligibility_data_tab_eligible_helper_tab_ineligible() -> None:
    result = parse_workbook(_sample_bytes(), "sample-movies.xlsx")
    assert _tab(result, "Sample")["eligible"] is True  # has Title, Year, Video Type
    assert _tab(result, "Lists")["eligible"] is False  # lookup lists — no Title/Year/Type


def test_sample_tab_row_count_and_columns() -> None:
    sample = _tab(parse_workbook(_sample_bytes(), "sample-movies.xlsx"), "Sample")
    assert sample["rowCount"] == 204
    assert len(sample["rows"]) == 204
    headers = [c["header"] for c in sample["columns"]]
    assert len(headers) == 27
    for expected in ("Title", "Year", "Video Type", "Genres", "Set", "Outline", "Plot"):
        assert expected in headers


def test_first_row_cells_are_stringified_by_header() -> None:
    sample = _tab(parse_workbook(_sample_bytes(), "sample-movies.xlsx"), "Sample")
    row = sample["rows"][0]
    assert row["Title"] == "9"  # numeric title coerced to string
    assert row["Year"] == "2009"
    assert row["Language"] == "English"
    assert row["Runtime"] == "79"
    assert row["Genres"] == "Drama|Mystery|Sci-Fi|Thriller|Action|Adventure|Animation"
    assert row["Release Date"] == "2009-09-09"  # datetime → ISO date, not "... 00:00:00"


def test_sample_values_are_strings_within_sample_size() -> None:
    sample = _tab(parse_workbook(_sample_bytes(), "sample-movies.xlsx", sample_size=5), "Sample")
    title_col = next(c for c in sample["columns"] if c["header"] == "Title")
    assert 0 < len(title_col["sampleValues"]) <= 5
    assert all(isinstance(v, str) for v in title_col["sampleValues"])


# ---------------------------------------------------------------------------
# CSV (single implicit tab named from the filename)
# ---------------------------------------------------------------------------


def test_csv_single_eligible_tab() -> None:
    data = b"Title,Year,Content Type\nThe Matrix,1999,Movie\nDune,2021,Movie\n"
    result = parse_workbook(data, "my-films.csv")
    assert len(result["tabs"]) == 1
    tab = result["tabs"][0]
    assert tab["name"] == "my-films"  # derived from filename stem
    assert tab["eligible"] is True
    assert tab["rowCount"] == 2
    assert tab["rows"][0]["Title"] == "The Matrix"


def test_csv_without_required_columns_is_ineligible() -> None:
    result = parse_workbook(b"Name,Note\nfoo,bar\n", "lookup.csv")
    assert result["tabs"][0]["eligible"] is False


# ---------------------------------------------------------------------------
# Error handling (FR-022 — no partial result)
# ---------------------------------------------------------------------------


def test_empty_file_rejected() -> None:
    with pytest.raises(SpreadsheetParseError):
        parse_workbook(b"", "empty.xlsx")


def test_corrupt_xlsx_rejected() -> None:
    with pytest.raises(SpreadsheetParseError):
        parse_workbook(b"this is not a real xlsx zip", "broken.xlsx")


def test_formula_guard_apostrophe_stripped_on_import() -> None:
    """The export-side formula guard is reversed so the round-trip is symmetric (SC-004)."""
    data = (
        b"Title,Year,Content Type\n"
        b"'=SUM(A1),2001,Movie\n"  # escaped formula → original text restored
        b"'71,1971,Movie\n"  # legit leading apostrophe (no trigger) preserved
    )
    rows = parse_workbook(data, "guarded.csv")["tabs"][0]["rows"]
    assert rows[0]["Title"] == "=SUM(A1)"
    assert rows[1]["Title"] == "'71"


def test_build_then_parse_preserves_formula_trigger_values() -> None:
    """build_workbook → parse_workbook restores a title that begins with a formula trigger."""
    from src.builder import build_workbook_bytes

    data, _ = build_workbook_bytes(
        [
            {
                "collectionName": "C",
                "columns": ["Title", "Year", "Content Type"],
                "rows": [{"Title": "-The Dash", "Year": "2020", "Content Type": "Movie"}],
            }
        ]
    )
    tab = parse_workbook(data, "C.xlsx")["tabs"][0]
    assert tab["rows"][0]["Title"] == "-The Dash"  # trigger value survives the round-trip


def test_round_trips_a_freshly_built_xlsx() -> None:
    """A minimal in-memory xlsx parses with eligibility + stringified cells."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Films"
    ws.append(["Title", "Year", "Content Type", "Genres"])
    ws.append(["Inception", 2010, "Movie", "Action|Sci-Fi"])
    buf = io.BytesIO()
    wb.save(buf)

    tab = parse_workbook(buf.getvalue(), "films.xlsx")["tabs"][0]
    assert tab["eligible"] is True
    assert tab["rowCount"] == 1
    assert tab["rows"][0]["Year"] == "2010"
    assert tab["rows"][0]["Genres"] == "Action|Sci-Fi"
