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
    from fastapi import FastAPI

    from src.agui_identity import IdentityAwareAGUIAgent
    from src.runtime_context import SubjectTokenMiddleware, UiSnapshotMiddleware

    app = FastAPI(title="MCM Agent Gateway")
    # Capture the BFF-supplied sanitized UI snapshot (X-UI-Snapshot) per request for
    # context-aware "this" resolution (US3/R15); bridged into config like the subject token.
    app.add_middleware(UiSnapshotMiddleware)
    # Capture the BFF-supplied run-scoped subject token (Authorization: Bearer) per request
    # into a request-local ContextVar for the tool-call path (T024); never checkpointed.
    app.add_middleware(SubjectTokenMiddleware)
    # IdentityAwareAGUIAgent bridges that captured token into config["configurable"] at
    # prepare_stream (request task) so the real nodes receive it task-safely (gateway cut-over).
    # No token (tool-free graph) → a no-op, so SC-005 behaviour is unchanged.
    add_langgraph_fastapi_endpoint(
        app=app,
        agent=IdentityAwareAGUIAgent(
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
    """uvicorn factory entrypoint — mounts the supervisor graph (T020/T046, Slice G).

    GATED (SC-005): `build_runtime_graph` injects the real MCP-backed curator/organizer/
    approval_gate nodes only when production is enabled (both `WEB_API_MCP_URL` +
    `MOVIE_MCP_URL` set — the deploy cut-over). Until then it returns the tool-free graph, so
    the existing assistant E2E/regression are unaffected.

    REMAINING DEPLOY WIRING (lands with the agent deploy / T036): the real nodes read the
    run-scoped subject token + user_id from `config["configurable"]`; the
    `SubjectTokenMiddleware` captures the token into a per-request ContextVar
    (`runtime_context.get_subject_token`), but the ContextVar→`configurable` bridge at graph
    invocation is not wired here yet (it depends on how `ag_ui_langgraph` passes config and is
    only end-to-end testable against the live transport). Enabling production nodes without that
    bridge yields a graceful "no caller identity" on movie-mcp calls — never an unauthenticated
    call (`invoke_tool` fail-closed).
    """
    import logging
    import os

    from src.observability import configure_metrics, configure_otel
    from src.runtime_nodes import build_runtime_graph, production_nodes_enabled

    # Configure the root logger so the gateway's own `logging.getLogger(__name__)` records reach
    # stdout under uvicorn (uvicorn only configures its own `uvicorn.*` loggers, leaving app
    # loggers handler-less → silently dropped). Without this the "MCP-backed vs tool-free" line
    # and any node-level error/warn are invisible in a deployed container. Level via
    # AGENT_LOG_LEVEL (default INFO); never lower httpx/uvicorn.access to DEBUG in prod — that
    # would log Authorization headers (SC-004, see tasks.md T030b carry-over).
    logging.basicConfig(
        level=getattr(logging, os.environ.get("AGENT_LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # OpenTelemetry infra export (T030b) — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
    configure_otel(os.environ)
    configure_metrics(os.environ)
    enabled = production_nodes_enabled(os.environ)
    logging.getLogger(__name__).info(
        "gateway graph: %s nodes", "MCP-backed (production)" if enabled else "tool-free (default)"
    )
    return build_app(build_runtime_graph(os.environ))
