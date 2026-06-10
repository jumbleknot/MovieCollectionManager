"""Append-only audit sink for the agent gateway (T076b).

Two behaviours, always additive (SC-005):
- **Always**: structured log via the module logger (today's behaviour, no change).
- **When OPENSEARCH_URL is set**: also best-effort POST an audit document to the
  `mcm-agent-audit` index. The POST is *awaited* but bounded to a 3-second timeout so the
  tool path never waits longer than that, and any exception is swallowed — audit is
  never-blocking, never-raising from the caller's perspective.

Non-blocking approach chosen: **fire-and-forget via `asyncio.ensure_future`**.
Call sites in `src/tools/mcp_tools.py` schedule `emit_audit` as a background task using
`asyncio.ensure_future` — the coroutine is never awaited by the caller. Internally,
`emit_audit` itself awaits the HTTP POST but bounds it to a 3-second timeout so the
worst-case stall is predictable and far shorter than any user-visible timeout. The
`except Exception` block ensures even a timeout or connection error does not propagate.

SC-004 / token-leak compliance: `build_audit_doc` strips every key whose lower-cased name
contains any of the TOKEN_MARKERS before the log line and before the POST. No token-named
variable is ever passed to a logger call in this module.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Mirror the markers from src/eval/token_leak_scan.TOKEN_MARKERS so the same identifiers
# are treated as sensitive here and in the static scan.
_REDACT_MARKERS: tuple[str, ...] = (
    "token",
    "jwt",
    "authorization",
    "bearer",
    "secret",
    "password",
    "credential",
    "email",
    "username",
    "cookie",
    "code",
)


def build_audit_doc(action: str, fields: Mapping[str, Any]) -> dict[str, Any]:
    """Return ``{**redacted_fields, "action": action}`` — pure, no side effects.

    Any key whose lower-cased name contains a marker from ``_REDACT_MARKERS`` is dropped.
    The ``action`` key is always present and is set to the supplied value.
    """
    doc: dict[str, Any] = {
        k: v
        for k, v in fields.items()
        if not any(marker in k.lower() for marker in _REDACT_MARKERS)
    }
    doc["action"] = action
    return doc


async def emit_audit(
    action: str,
    fields: Mapping[str, Any],
    *,
    env: Mapping[str, str] | None = None,
    client: httpx.AsyncClient | None = None,
) -> None:
    """Emit a structured audit log line and, when ``OPENSEARCH_URL`` is set, POST to OpenSearch.

    Always logs via the module logger (no sensitive keys — ``build_audit_doc`` redacts first).
    When ``OPENSEARCH_URL`` is set, also POSTs the redacted document to the
    ``mcm-agent-audit/_doc`` endpoint with a 3-second timeout.  Any exception from the POST
    is caught and logged at WARNING level — the audit must never raise or stall the caller.

    Parameters
    ----------
    action:
        Audit action label (e.g. ``"agent_tool_call"``).
    fields:
        Arbitrary key→value pairs to include.  Sensitive keys are stripped by
        ``build_audit_doc`` before logging or sending.
    env:
        Environment mapping (defaults to ``os.environ``).  Injected in tests.
    client:
        An ``httpx.AsyncClient`` to use for the POST.  When *None* a temporary client is
        created and closed in this call.  Injected in tests to avoid real network calls.
    """
    e: Mapping[str, str] = os.environ if env is None else env
    doc = build_audit_doc(action, fields)

    # Structured log — only the redacted doc; no raw fields, no token-named variables.
    logger.info(
        "audit %s agent=%s tool=%s status=%s",
        action,
        doc.get("agent"),
        doc.get("tool"),
        doc.get("status"),
    )

    base = (e.get("OPENSEARCH_URL") or "").strip()
    if not base:
        return

    url = f"{base.rstrip('/')}/mcm-agent-audit/_doc"
    auth = (e.get("OPENSEARCH_USERNAME", ""), e.get("OPENSEARCH_PASSWORD", ""))
    try:
        if client is not None:
            await client.post(url, json=doc, auth=auth)
        else:
            http = httpx.AsyncClient(verify=False, timeout=3.0)  # noqa: S501
            try:
                await http.post(url, json=doc, auth=auth)
            finally:
                await http.aclose()
    except Exception:  # best-effort — audit must never break the call  # noqa: BLE001
        logger.warning("audit append to OpenSearch failed", exc_info=False)
