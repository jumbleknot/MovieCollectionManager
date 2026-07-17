"""Agent-side bindings for the spreadsheet-mcp tools (014 US2/US3).

`parse_spreadsheet` / `build_workbook` wrap the `invoke_tool` choke point for the
file-processing MCP server. Two invariants distinguish them from the domain (movie-mcp) tools:

  * **handle, not content** — the file is referenced by an opaque transient-store handle that
    the import/export NODE supplies in pure code (from the run input). The handle is never an
    LLM-chosen argument and the spreadsheet tools are not exposed to the planner.
  * **no user token** — spreadsheet-mcp is a scoped-capability file processor with no backend/
    domain access, so it carries no JWT (`needs_token=False`); the acquire-token seam is a no-op.

Allowlist enforcement still applies (import_collection → parse only; export_collection → build
only), composed inside `invoke_tool`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.mcp_tools import McpServerConfig, ToolCallFn, ToolOutcome, invoke_tool


async def _no_token(_subject: str, _audience: str) -> str:
    """spreadsheet-mcp is token-free — it never receives a user JWT."""
    return ""


def spreadsheet_server(url: str) -> McpServerConfig:
    """The spreadsheet-mcp server config (token-free file processor)."""
    return McpServerConfig(name="spreadsheet-mcp", url=url, needs_token=False)


async def parse_spreadsheet(
    *,
    agent: str,
    file_handle: str,
    filename: str = "upload.xlsx",
    sample_size: int = 20,
    server: McpServerConfig,
    call: ToolCallFn,
    limiter: AgentToolRateLimiter,
    rate_scope: str = "",
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> ToolOutcome:
    """Parse the uploaded file (referenced by `file_handle`) into structured tabs.

    `file_handle` + `filename` are code-supplied (never LLM args). Returns a `ToolOutcome` —
    on success `.data` is `{ "tabs": [...] }`; on failure (corrupt/expired handle, FR-022) the
    node surfaces a user-facing "couldn't read the file" message.
    """
    return await invoke_tool(
        agent=agent,
        tool_name="parse_spreadsheet",
        arguments={"fileHandle": file_handle, "filename": filename, "sampleSize": sample_size},
        server=server,
        subject_token=None,
        call=call,
        limiter=limiter,
        acquire_token=_no_token,
        rate_scope=rate_scope,
        sleep=sleep,
    )


async def build_workbook(
    *,
    agent: str,
    tabs: list[dict[str, Any]],
    multi_value_delimiter: str = "|",
    server: McpServerConfig,
    call: ToolCallFn,
    limiter: AgentToolRateLimiter,
    rate_scope: str = "",
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> ToolOutcome:
    """Build a multi-tab `.xlsx` from per-collection rows; store it for download.

    Returns a `ToolOutcome` — on success `.data` is `{ "downloadHandle", "filename" }` for the
    BFF download route to stream.
    """
    return await invoke_tool(
        agent=agent,
        tool_name="build_workbook",
        arguments={"tabs": tabs, "multiValueDelimiter": multi_value_delimiter},
        server=server,
        subject_token=None,
        call=call,
        limiter=limiter,
        acquire_token=_no_token,
        rate_scope=rate_scope,
        sleep=sleep,
    )


async def stash_parsed(
    *,
    agent: str,
    parsed: dict[str, Any],
    server: McpServerConfig,
    call: ToolCallFn,
    limiter: AgentToolRateLimiter,
    rate_scope: str = "",
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> ToolOutcome:
    """Stash a parsed-import context (`{tabs, collections}`) in the transient store; get a handle.

    040 US2 T024: the import node checkpoints only this small handle across clarification turns —
    never the whole parsed dataset (checkpoint-bloat fix). On success `.data` is `{ parsedHandle }`.
    """
    return await invoke_tool(
        agent=agent,
        tool_name="stash_parsed",
        arguments={"parsed": parsed},
        server=server,
        subject_token=None,
        call=call,
        limiter=limiter,
        acquire_token=_no_token,
        rate_scope=rate_scope,
        sleep=sleep,
        # A finite, code-orchestrated per-import call (like the import dedup reads) — must not be
        # throttled into a silent failure that would strand the parsed dataset (FR-015/FR-016).
        skip_rate_limit=True,
    )


async def fetch_parsed(
    *,
    agent: str,
    parsed_handle: str,
    server: McpServerConfig,
    call: ToolCallFn,
    limiter: AgentToolRateLimiter,
    rate_scope: str = "",
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> ToolOutcome:
    """Fetch the stashed parsed-import context by handle (server refreshes its TTL — FR-016).

    On success `.data` is the `{ tabs, collections }` dict. On failure (unknown/expired handle) the
    import node degrades gracefully — asks the user to re-upload rather than silently stopping.
    """
    return await invoke_tool(
        agent=agent,
        tool_name="fetch_parsed",
        arguments={"parsedHandle": parsed_handle},
        server=server,
        subject_token=None,
        call=call,
        limiter=limiter,
        acquire_token=_no_token,
        rate_scope=rate_scope,
        sleep=sleep,
        skip_rate_limit=True,
    )
