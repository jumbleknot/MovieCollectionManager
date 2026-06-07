"""Agent Gateway — FastAPI app emitting AG-UI natively (T020/T014a).

The orchestration runtime is a FastAPI app that mounts the compiled LangGraph supervisor
graph as an AG-UI endpoint via `ag_ui_langgraph.add_langgraph_fastapi_endpoint` +
`copilotkit.LangGraphAGUIAgent`. This is what satisfies the constitution's AG-UI-NATIVE
mandate (the runtime emits AG-UI; the BFF only proxies — no event translation).

`build_app(graph)` is the seam: given any compiled graph it returns the AG-UI app, so the
T014a transport spike can mount a trivial echo graph and the real run mounts the supervisor
graph from `src.graph`. Private network only — no auth here (the BFF is the security boundary).
"""

from typing import Any

AGENT_PATH = "/agent/movie-assistant"


def build_app(graph: Any) -> Any:
    """Return a FastAPI app exposing `graph` over AG-UI at AGENT_PATH, plus /health."""
    from ag_ui_langgraph import add_langgraph_fastapi_endpoint  # type: ignore[import-untyped]
    from copilotkit import LangGraphAGUIAgent
    from fastapi import FastAPI

    app = FastAPI(title="MCM Agent Gateway")
    add_langgraph_fastapi_endpoint(
        app=app,
        agent=LangGraphAGUIAgent(
            name="movie_assistant",
            description="MCM conversational assistant (discover, enrich, organize — HITL-gated).",
            graph=graph,
        ),
        path=AGENT_PATH,
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def create_app() -> Any:
    """uvicorn factory entrypoint — mounts the real supervisor graph (T020)."""
    from src.graph import graph

    if graph is None:
        raise RuntimeError("supervisor graph not yet compiled (T020)")
    return build_app(graph)
