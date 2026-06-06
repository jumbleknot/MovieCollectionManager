"""Gateway boot integration test (T014a server-side / T020 build_app).

Confirms the Agent Gateway FastAPI app boots and mounts the AG-UI endpoint NATIVELY via
ag_ui_langgraph (the constitution's AG-UI-native mandate). No mocking — a real FastAPI app
wrapping a real compiled LangGraph echo graph. The full client transport (CopilotKit web +
Android through the BFF proxy) is validated separately (T028/T029/T033a).
"""

from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from src.gateway import AGENT_PATH, build_app


def _echo_graph():
    def echo(state):
        last = state["messages"][-1].content if state.get("messages") else ""
        return {"messages": [("ai", f"echo: {last}")]}

    g = StateGraph(MessagesState)
    g.add_node("echo", echo)
    g.add_edge(START, "echo")
    g.add_edge("echo", END)
    return g.compile(checkpointer=MemorySaver())


def test_gateway_boots_and_serves_health():
    app = build_app(_echo_graph())
    assert TestClient(app).get("/health").status_code == 200


def test_agui_endpoint_is_mounted_natively():
    app = build_app(_echo_graph())
    paths = {getattr(route, "path", "") for route in app.routes}
    assert any(AGENT_PATH in p for p in paths), sorted(paths)
