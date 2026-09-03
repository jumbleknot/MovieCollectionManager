"""A provider failure terminates the stream — it never leaves the caller waiting (065 US2, #325).

WHAT THIS PINS. `ag_ui_langgraph`'s `_handle_stream_events` RE-RAISES a hard exception "for the
existing run-level error handling". There is no run-level error handling: `endpoint.py` hands the
generator to a `StreamingResponse` whose 200 and headers are already flushed, so the exception has
nowhere to go and the connection is aborted MID-CHUNK with no terminal AG-UI event.

Measured against this exact harness before the fix: HTTP 200, 4 SSE lines, then
`RemoteProtocolError: peer closed connection without sending complete message body`. A caller
waiting on a terminal event — rather than on the socket — waits for its full timeout. That is the
hang item #325 describes.

WHY A REAL SERVER AND NOT `TestClient`. The defect is in how an exception raised mid-body interacts
with a chunked response that has already begun. `TestClient` drives the ASGI app in-process, where
that interaction is not the one production has. This binds loopback and speaks real HTTP.

NO MODEL, NO KEY, NO NETWORK, NO MARKER. The failure is raised locally from the real
`anthropic.BadRequestError` shape, so this runs in the ordinary gate. An error-path guarantee gated
behind a live-model marker is a guarantee that stops running the moment that tier is skipped.
"""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import httpx
import uvicorn
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from src.gateway import AGENT_PATH, build_app

# Item #325 criterion 2 is FAIL FAST, so the assertion has to be a latency bound — a test that
# only checks "an error appeared" passes against the very hang it exists to catch.
#
# 10 s against the 150 s Playwright timeout that made run 2450 undiagnosable: a 15x margin, loose
# enough not to flake on a loaded CI runner and tight enough that a regression to the hang fails it
# outright. Measured today: ~0.35 s. A BOUND, never an equality.
FAIL_FAST_BOUND_S = 10.0
UI_TIMEOUT_S = 150.0

CREDIT_MESSAGE = "Your credit balance is too low to access the Anthropic API."


def _credit_exhausted_400() -> Exception:
    """The genuine SDK refusal an exhausted Anthropic balance returns (measured 2026-08-31).

    Built from a real `httpx.Response`, so `status_code` and `error.type` are read from the true
    attribute shape rather than a stand-in the fix could accidentally have been written against.
    """
    import anthropic

    body = {"type": "error", "error": {"type": "invalid_request_error", "message": CREDIT_MESSAGE}}
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.BadRequestError(
        CREDIT_MESSAGE, response=httpx.Response(400, request=request, json=body), body=body
    )


def _graph(node: Any):
    builder = StateGraph(MessagesState)
    builder.add_node("node", node)
    builder.add_edge(START, "node")
    builder.add_edge("node", END)
    return builder.compile(checkpointer=MemorySaver())


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@contextmanager
def _serving(graph: Any) -> Iterator[str]:
    """Run the REAL gateway app under a REAL uvicorn server on a loopback port."""
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(build_app(graph), host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 30
        while not server.started:
            if time.monotonic() > deadline:  # pragma: no cover - harness guard
                raise RuntimeError("uvicorn did not start within 30s")
            time.sleep(0.05)
        yield f"http://127.0.0.1:{port}{AGENT_PATH}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


async def _run_turn(url: str, thread_id: str) -> dict[str, Any]:
    """Stream one turn and report what the CALLER saw — events, outcome and elapsed time."""
    payload = {
        "thread_id": thread_id,
        "run_id": f"run-{thread_id}",
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": "import my movies"}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    lines: list[str] = []
    started = time.monotonic()
    outcome = "closed"
    # Deliberately just above the fail-fast bound: a regression to the hang must surface as a
    # timeout here rather than stalling the suite for the full 150 s UI timeout.
    async with httpx.AsyncClient(timeout=FAIL_FAST_BOUND_S + 5) as client:
        try:
            async with client.stream(
                "POST", url, json=payload, headers={"accept": "text/event-stream"}
            ) as response:
                status = response.status_code
                async for line in response.aiter_lines():
                    if line.strip():
                        lines.append(line)
        except httpx.ReadTimeout:
            status, outcome = None, "hung"
        except httpx.RemoteProtocolError:
            status, outcome = None, "aborted"
    return {
        "status": status,
        "lines": lines,
        "outcome": outcome,
        "elapsed": time.monotonic() - started,
    }


# ── FR-006: a provider failure becomes a terminal event, not an aborted socket ──────────────────


async def test_a_provider_400_terminates_the_stream_with_run_error() -> None:
    """Item #325 criterion 2. Before the fix this aborts with `RemoteProtocolError`."""

    def node(_state: Any) -> dict[str, Any]:
        raise _credit_exhausted_400()

    with _serving(_graph(node)) as url:
        result = await _run_turn(url, "provider-400")

    assert result["outcome"] == "closed", (
        f"the stream did not close cleanly ({result['outcome']}) — a caller waiting on a terminal "
        f"event waits for its full timeout. Lines seen: {result['lines']}"
    )
    assert any("RUN_ERROR" in line for line in result["lines"]), result["lines"]


async def test_the_terminal_error_arrives_fast_enough_to_be_diagnosable() -> None:
    """SC-002 — the assertion item #325 asks to be settled deliberately, not improvised.

    A bound, against the 150 s UI timeout that turned an out-of-credit account into two tests
    reporting "waiting for [data-testid=…]".
    """

    def node(_state: Any) -> dict[str, Any]:
        raise _credit_exhausted_400()

    with _serving(_graph(node)) as url:
        result = await _run_turn(url, "provider-400-fast")

    assert any("RUN_ERROR" in line for line in result["lines"]), result["lines"]
    assert result["elapsed"] < FAIL_FAST_BOUND_S, (
        f"terminal error took {result['elapsed']:.2f}s (bound {FAIL_FAST_BOUND_S}s, UI timeout "
        f"{UI_TIMEOUT_S}s) — 'fails fast' must mean fast, not merely eventual"
    )


async def test_a_non_provider_bug_also_terminates_the_stream() -> None:
    """FR-003/FR-006 — the guarantee is about the stream boundary, not about Anthropic. A defect
    of ours must not hang a caller either."""

    def node(_state: Any) -> dict[str, Any]:
        raise ValueError("a bug of ours")

    with _serving(_graph(node)) as url:
        result = await _run_turn(url, "our-bug")

    assert result["outcome"] == "closed", result
    assert any("RUN_ERROR" in line for line in result["lines"]), result["lines"]


# ── FR-009: the success path is not made lossy to fix the error path ────────────────────────────


async def test_a_successful_run_still_finishes_and_emits_no_run_error() -> None:
    def node(state: Any) -> dict[str, Any]:
        last = state["messages"][-1].content if state.get("messages") else ""
        return {"messages": [("ai", f"echo: {last}")]}

    with _serving(_graph(node)) as url:
        result = await _run_turn(url, "happy-path")

    assert result["status"] == 200
    assert result["outcome"] == "closed"
    assert any("RUN_FINISHED" in line for line in result["lines"]), result["lines"]
    assert not any("RUN_ERROR" in line for line in result["lines"]), result["lines"]


# ── FR-010: the terminal event crosses the network — it must carry no member text ───────────────


async def test_the_terminal_error_message_leaks_no_member_text() -> None:
    """The RUN_ERROR message reaches a client. A provider echoes request content in some error
    messages, so `str(exc)` must not be forwarded unfiltered."""

    def node(_state: Any) -> dict[str, Any]:
        import anthropic

        leaked = "rejected: add Nosferatu to my Horror collection"
        body = {"type": "error", "error": {"type": "invalid_request_error", "message": leaked}}
        request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
        raise anthropic.BadRequestError(
            leaked, response=httpx.Response(400, request=request, json=body), body=body
        )

    with _serving(_graph(node)) as url:
        result = await _run_turn(url, "no-leak")

    stream = " ".join(result["lines"])
    assert any("RUN_ERROR" in line for line in result["lines"]), result["lines"]
    assert "Nosferatu" not in stream
    assert "Horror" not in stream
