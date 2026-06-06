"""Integration test: the gateway mounts the REAL compiled supervisor graph (T020).

Once `src.graph.graph` is a compiled graph (not None), `create_app()` must build the
AG-UI FastAPI app around it. No mocking — real graph + real FastAPI/ag_ui_langgraph.
"""

from fastapi.testclient import TestClient

from src.gateway import AGENT_PATH, create_app


def test_create_app_mounts_the_real_graph():
    app = create_app()
    client = TestClient(app)
    assert client.get("/health").status_code == 200
    paths = {getattr(route, "path", "") for route in app.routes}
    assert any(AGENT_PATH in p for p in paths), sorted(paths)
