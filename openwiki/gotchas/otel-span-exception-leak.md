---
type: Gotcha
title: OTel span exception recording can leak a credential in the URL
description: Why web-api-mcp explicitly disables OpenTelemetry's default exception-recording behavior on its tool spans — the default would embed the TMDB API key (carried as a URL query param) into the exported trace on any upstream HTTP error.
resource: mcp-servers/web-api-mcp/src/observability.py
tags: [opentelemetry, security, mcp, observability]
timestamp: 2026-06-09T08:12:41-04:00
---

# OTel span exception recording can leak a credential in the URL

`web-api-mcp`'s `tool_span()` context manager (`mcp-servers/web-api-mcp/src/observability.py`)
wraps every tool call in a span named `tool.<name>` — deliberately carrying only the tool name,
never arguments, headers, or the TMDB key. OpenTelemetry's `start_as_current_span()` defaults to
recording an uncaught exception as a span event and setting the span's error status from it, and
both of those defaults call `str(exc)` internally.

## Gotchas

- **The TMDB client library's HTTP error stringifies its request URL, including the API key.**
  When an `httpx.HTTPStatusError` (or similar) is raised from a TMDB call, its string
  representation includes the full request URL — and TMDB's auth is a `?api_key=<SECRET>` query
  param, not a header. If OTel's default exception recording were left on, that credential would
  ride straight into the exported trace as a span event or the status description, reaching
  whatever OTLP backend the deployment points at.
- **The fix is two explicit `False` flags on every span, not a global OTel config toggle:**
  `tracer.start_as_current_span(f"tool.{name}", record_exception=False,
  set_status_on_exception=False)`. Both must be disabled — either one alone still leaks the
  credential through the other mechanism (event vs. status description).
- **The error still propagates to the caller unchanged** — disabling exception recording only
  affects what reaches the trace exporter, not the tool's actual error handling or response to the
  agent gateway.
- **Tracing itself is entirely opt-in and a no-op by default.** `configure_otel()` only wires an
  OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the environment; dev/test is
  unaffected either way. But the leak-safety of `tool_span()` must hold regardless, since any
  environment can set that endpoint later.
- **Any new span that wraps credential-bearing I/O anywhere in the codebase must copy this
  pattern explicitly** — OTel's safe-by-default assumption does not hold here, and there is no
  global setting that fixes it once; each span call site is responsible for its own flags.

See [Agent Gateway](/openwiki/projects/agent-gateway.md) for web-api-mcp's role as one of the three
scoped MCP servers the gateway calls, and `docs/runbooks/agent-layer.md` for the broader observability
(Control Tower) integration.
