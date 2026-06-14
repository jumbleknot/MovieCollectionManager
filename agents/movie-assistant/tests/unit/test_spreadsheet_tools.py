"""T006: unit tests for the agent-side spreadsheet-mcp bindings.

`parse_spreadsheet` / `build_workbook` wrap the `invoke_tool` choke point for the
file-processing MCP server. The file handle is a CODE-supplied argument (from the run input),
never an LLM-chosen one — the tools are not exposed to the planner. spreadsheet-mcp carries no
user token (needs_token=False). Allowlist enforcement still applies per agent.
"""

from __future__ import annotations

from typing import Any

from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.mcp_tools import McpCallResult
from src.tools.spreadsheet_tools import (
    build_workbook,
    parse_spreadsheet,
    spreadsheet_server,
)

SS = spreadsheet_server("http://spreadsheet-mcp:8000/mcp")


def _limiter(max_calls: int = 30) -> AgentToolRateLimiter:
    return AgentToolRateLimiter(max_calls=max_calls, window_seconds=60)


def _recording_call() -> tuple[list[dict[str, Any]], Any]:
    calls: list[dict[str, Any]] = []

    async def call(
        url: str, tool_name: str, arguments: dict[str, Any], token: str | None
    ) -> McpCallResult:
        calls.append(
            {"url": url, "tool": tool_name, "arguments": arguments, "token": token}
        )
        return McpCallResult(is_error=False, data={"tabs": []}, text="")

    return calls, call


def test_spreadsheet_server_is_token_free() -> None:
    assert SS.name == "spreadsheet-mcp"
    assert SS.needs_token is False


async def test_parse_passes_handle_and_filename_as_code_args() -> None:
    calls, call = _recording_call()
    out = await parse_spreadsheet(
        agent="import_collection",
        file_handle="h-abc123",
        filename="movies.xlsx",
        server=SS,
        call=call,
        limiter=_limiter(),
    )
    assert out.ok
    assert len(calls) == 1
    sent = calls[0]
    assert sent["tool"] == "parse_spreadsheet"
    assert sent["arguments"] == {
        "fileHandle": "h-abc123",
        "filename": "movies.xlsx",
        "sampleSize": 20,
    }
    # No user token ever rides a spreadsheet-mcp call.
    assert sent["token"] is None or sent["token"] == ""


async def test_build_workbook_passes_tabs_and_delimiter() -> None:
    calls, call = _recording_call()
    tabs = [{"collectionName": "Sci-Fi", "columns": ["Title"], "rows": [{"Title": "Dune"}]}]
    out = await build_workbook(
        agent="export_collection",
        tabs=tabs,
        server=SS,
        call=call,
        limiter=_limiter(),
    )
    assert out.ok
    sent = calls[0]
    assert sent["tool"] == "build_workbook"
    assert sent["arguments"] == {"tabs": tabs, "multiValueDelimiter": "|"}


async def test_parse_disallowed_for_non_import_agent() -> None:
    """A read-only agent (curator) is not permitted to call parse_spreadsheet — blocked before
    any transport call (deny-by-default allowlist)."""
    calls, call = _recording_call()
    out = await parse_spreadsheet(
        agent="curator",
        file_handle="h",
        filename="x.csv",
        server=SS,
        call=call,
        limiter=_limiter(),
    )
    assert not out.ok
    assert calls == []  # never reached the transport


async def test_build_disallowed_for_import_agent() -> None:
    """import_collection may parse + write movies but NOT build a workbook (export-only tool)."""
    calls, call = _recording_call()
    out = await build_workbook(
        agent="import_collection",
        tabs=[],
        server=SS,
        call=call,
        limiter=_limiter(),
    )
    assert not out.ok
    assert calls == []


async def test_custom_sample_size_forwarded() -> None:
    calls, call = _recording_call()
    await parse_spreadsheet(
        agent="import_collection",
        file_handle="h",
        filename="x.xlsx",
        sample_size=5,
        server=SS,
        call=call,
        limiter=_limiter(),
    )
    assert calls[0]["arguments"]["sampleSize"] == 5
