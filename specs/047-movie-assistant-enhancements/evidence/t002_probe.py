"""RQ-2 / T002 probe — what event types does the gateway ACTUALLY put on the wire?

Drives the real AG-UI HTTP endpoint in-process (FastAPI TestClient) with a tool-free graph whose
one node writes to graph state, and records every SSE event type. Answers, with evidence rather
than inference: does a LangGraph state write reach the client as STATE_SNAPSHOT / STATE_DELTA?
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver

from src.gateway import AGENT_PATH, build_app
from src.graph import build_graph


async def _progress_node(state: dict[str, Any]) -> dict[str, Any]:
    """US3's real shape: ONE node that applies many items and reports progress AS IT GOES.

    Super-step snapshots fire per NODE, so a loop inside one node would emit nothing until it
    finished. `manually_emit_state` is the mid-run hook the gateway turns into a STATE_SNAPSHOT.
    """
    from langchain_core.callbacks.manager import adispatch_custom_event

    for applied in (500, 1300, 2300):
        await adispatch_custom_event(
            "manually_emit_state", {"import_decisions_remaining": applied}
        )
    return _final_state(state)


def _final_state(state: dict[str, Any]) -> dict[str, Any]:
    """Write a couple of counters into graph state — the shape FR-014a's progress line needs."""
    return {
        # `import_decisions_remaining` IS declared on GraphState; `import_applied` is NOT (RQ-3
        # proposes adding it). Writing both in one turn shows whether the snapshot carries only
        # declared keys.
        "import_decisions_remaining": 7,
        "import_applied": 1300,
        "messages": [AIMessage(content="working…")],
    }


def _run_body(thread_id: str, text: str) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "runId": f"run-{uuid.uuid4().hex[:8]}",
        "state": {},
        "messages": [{"id": f"m-{uuid.uuid4().hex[:8]}", "role": "user", "content": text}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def main() -> None:
    graph = build_graph(
        classifier=lambda _m: "query",
        query=_progress_node,
        checkpointer=MemorySaver(),
    )
    client = TestClient(build_app(graph))

    thread = f"rq2-{uuid.uuid4().hex[:8]}"
    with client.stream("POST", AGENT_PATH, json=_run_body(thread, "how many movies")) as resp:
        print(f"HTTP {resp.status_code}  content-type={resp.headers.get('content-type')}\n")
        types: list[str] = []
        state_payloads: list[Any] = []
        for line in resp.iter_lines():
            if not line or not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            etype = event.get("type", "?")
            types.append(etype)
            if "STATE" in str(etype).upper():
                state_payloads.append(event)

    print("EVENT TYPES IN ORDER:")
    for t in types:
        print(f"  {t}")

    print("\nSTATE EVENTS SEEN:", len(state_payloads))
    for ev in state_payloads:
        snap = ev.get("snapshot") or ev.get("delta")
        keys = sorted(snap.keys()) if isinstance(snap, dict) else snap
        print(f"  type={ev.get('type')}  payload_keys={keys}")
        if isinstance(snap, dict):
            for k in ("import_decisions_remaining", "import_applied"):
                if k in snap:
                    print(f"      {k} = {snap[k]}   <-- reached the wire")


if __name__ == "__main__":
    main()
