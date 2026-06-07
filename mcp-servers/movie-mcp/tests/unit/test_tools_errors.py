"""Unit tests for movie-mcp's mc-service error mapping (T024a).

The write tool handlers (server.py) catch mc-service's httpx 4xx/5xx and re-raise a
status-bearing `McServiceToolError`. FastMCP stringifies it into the MCP tool error text, so
the gateway's `invoke_tool` can classify the outcome (e.g. 409 -> skipped_duplicate) from the
stable `mc-service-status:<code>` sentinel — without parsing mc-service's body (no token/PII).
"""

from __future__ import annotations

import httpx

from src.tools import McServiceToolError, tool_error_from_http_status


def _http_status_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://mc-service:3001/api/v1/collections/c1/movies")
    response = httpx.Response(status_code, request=request, json={"title": "Duplicate movie"})
    return httpx.HTTPStatusError("error", request=request, response=response)


def test_tool_error_from_http_status_carries_the_status_sentinel() -> None:
    err = tool_error_from_http_status(_http_status_error(409))
    assert isinstance(err, McServiceToolError)
    assert err.status_code == 409
    assert str(err).startswith("mc-service-status:409")


def test_tool_error_does_not_leak_mc_service_body() -> None:
    # SC-004 / FR-022: only the status travels — no body, token, or PII.
    err = tool_error_from_http_status(_http_status_error(404))
    assert str(err) == "mc-service-status:404"
