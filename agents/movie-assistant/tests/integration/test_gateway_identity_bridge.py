"""Gateway subject-token bridge (gateway cut-over, US1 Slice G) — full ASGI path.

Proves the end-to-end bridge through the REAL gateway app: an AG-UI request carrying
`Authorization: Bearer <subject token>` → `SubjectTokenMiddleware` (ContextVar) →
`IdentityAwareAGUIAgent.prepare_stream` → `config["configurable"]` → the graph node. No external
stack needed (no Keycloak/mc-service) — the token is any JWT-shaped string; the node records what
`config["configurable"]` carried. This is the wiring that lets the real US1 nodes act on the
user's identity once production nodes are enabled.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from src.gateway import AGENT_PATH, build_app


def _jwt(sub: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"sub": sub}).encode()).rstrip(b"=").decode()
    return f"header.{payload}.signature"


def _recording_graph(seen: dict[str, Any]) -> Any:
    async def record(state: dict[str, Any], config: RunnableConfig) -> dict[str, Any]:
        configurable = (config or {}).get("configurable", {})
        seen["subject_token"] = configurable.get("subject_token")
        seen["user_id"] = configurable.get("user_id")
        return {"messages": [AIMessage(content="ok")]}

    g = StateGraph(MessagesState)
    g.add_node("record", record)
    g.add_edge(START, "record")
    g.add_edge("record", END)
    return g.compile(checkpointer=MemorySaver())


def _run_input(thread_id: str) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "runId": f"run-{thread_id}",
        "state": {},
        "messages": [{"id": "m1", "role": "user", "content": "add The Matrix to Sci-Fi"}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def test_gateway_bridges_subject_token_from_header_into_config() -> None:
    seen: dict[str, Any] = {}
    client = TestClient(build_app(_recording_graph(seen)))
    token = _jwt("user-99")

    resp = client.post(
        AGENT_PATH, json=_run_input("bridge-1"), headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    # The node saw the run-scoped subject token + decoded user_id via config["configurable"].
    assert seen.get("subject_token") == token
    assert seen.get("user_id") == "user-99"


def test_gateway_runs_without_a_token_no_identity_injected() -> None:
    # SC-005: no Authorization header (e.g. tool-free graph / unconfigured) → no injection,
    # behaviour unchanged. The node simply sees no subject_token.
    seen: dict[str, Any] = {}
    client = TestClient(build_app(_recording_graph(seen)))

    resp = client.post(AGENT_PATH, json=_run_input("bridge-2"))
    assert resp.status_code == 200
    assert seen.get("subject_token") is None
