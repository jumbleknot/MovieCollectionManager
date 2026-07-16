"""spreadsheet-mcp MCP server: registers the parse + build tools over streamable-HTTP.

Scoped-capability server (014 R11): file processing only. NO backend/domain network calls — it
reads/writes only the transient upload/download store (Redis) via an opaque handle. It never
sees a user JWT and never persists files beyond the short-TTL store. Added to the gateway tool
allowlist for the import/export nodes only.

Stateless streamable-HTTP. `enable_dns_rebinding_protection=False` — the MCP SDK otherwise
421-rejects a Docker service-name `Host` (the durable 012 gotcha); this server is reachable only
on the private agent network with the Agent Gateway as the sole caller.
"""

from __future__ import annotations

import json
import os
from typing import Any, cast

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from src import builder, parser, store
from src.observability import configure_otel, tool_span

mcp = FastMCP(
    "spreadsheet-mcp",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@mcp.tool()
async def parse_spreadsheet(
    fileHandle: str,  # noqa: N803 (MCP arg name)
    filename: str = "upload.xlsx",
    sampleSize: int = 20,  # noqa: N803 (MCP arg name)
) -> dict[str, Any]:
    """Parse an uploaded CSV/.xlsx (fetched from the transient store by handle) into tabs.

    Pure structural extraction — does NOT classify columns or match collections.
    """
    with tool_span("parse_spreadsheet"):
        data = await store.read_upload(fileHandle)
        return parser.parse_workbook(data, filename, sample_size=sampleSize)


@mcp.tool()
async def build_workbook(
    tabs: list[dict[str, Any]],
    multiValueDelimiter: str = "|",  # noqa: N803 (MCP arg name)
) -> dict[str, Any]:
    """Build a single multi-tab .xlsx from per-collection rows; store it for download.

    Returns `{ downloadHandle, filename }` — the BFF download route streams the bytes.
    """
    with tool_span("build_workbook"):
        data, filename = builder.build_workbook_bytes(
            tabs, multi_value_delimiter=multiValueDelimiter
        )
        handle = await store.write_export(data, filename)
        return {"downloadHandle": handle, "filename": filename}


@mcp.tool()
async def stash_parsed(parsed: dict[str, Any]) -> dict[str, Any]:
    """Stash a parsed-import context (`{tabs, collections}`) in the store; return a handle.

    Lets the import node checkpoint a small opaque handle instead of re-serializing the whole parsed
    dataset into LangGraph state on every clarification turn (040 US2 T024 — the checkpoint-bloat /
    "it timed out" fix). The handle's TTL is session-scale and refreshed on each `fetch_parsed`.
    """
    with tool_span("stash_parsed"):
        handle = await store.write_parsed(json.dumps(parsed).encode("utf-8"))
        return {"parsedHandle": handle}


@mcp.tool()
async def fetch_parsed(parsedHandle: str) -> dict[str, Any]:  # noqa: N803 (MCP arg name)
    """Fetch a previously stashed parsed-import context by handle, refreshing its TTL so a
    multi-turn import never expires mid-session (FR-016). Raises if the handle is unknown/expired.
    """
    with tool_span("fetch_parsed"):
        data = await store.read_parsed(parsedHandle)
        return cast(dict[str, Any], json.loads(data.decode("utf-8")))


def build_app() -> Any:
    """Streamable-HTTP ASGI app (no token-capture middleware — this server takes no JWT)."""
    configure_otel()  # OTel infra tracing — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT set
    return mcp.streamable_http_app()


def main() -> None:
    """Container entrypoint — serve the streamable-HTTP app on the private agent network."""
    import uvicorn

    host = os.environ.get("SPREADSHEET_MCP_HOST", "0.0.0.0")  # noqa: S104 (container bind)
    port = int(os.environ.get("SPREADSHEET_MCP_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)


if __name__ == "__main__":
    main()
