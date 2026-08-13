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


def install_stack_dump_signal() -> None:
    """Make a wedged gateway able to say what it is doing (feature 055, item #179).

    MEASURED three times on 2026-08-12: this process wedged at 100% CPU on one core with memory at
    1%, /health timing out and its log 40 minutes stale, while Docker reported `status=running
    ExitCode=0 RestartCount=0`. 100% CPU is the discriminator — a deadlock or a blocked await waits
    near 0% — so something was executing a tight loop. The gateway is one uvicorn process and
    asyncio
    is single-threaded, so a spin in the event loop starves every other coroutine on it, which is
    exactly why /health could not be answered while the process stayed alive.

    Which loop was never established, because capturing it requires acting on the LIVE process and
    nobody was watching. After this, anyone can ask it:

        docker kill -s USR1 movie-assistant-gateway
        docker logs --tail 100 movie-assistant-gateway

    `faulthandler` writes from the C signal handler, which is what makes it work HERE specifically:
    it does not need the interpreter to reach a safe point in Python-level scheduling, and a busy
    loop is precisely what denies that to anything scheduled on the event loop. A handler written in
    Python would be starved by the condition it exists to diagnose.

    Frames only — no locals, no environment — so it is safe to leave enabled permanently and cannot
    carry credential material into a log (055 FR-008).

    SIGUSR1 because uvicorn already assigns SIGTERM/SIGINT (shutdown) and SIGHUP (reload); USR1 is
    unclaimed. Best-effort: a platform without it must not stop the gateway from starting.
    """
    import faulthandler
    import logging
    import signal
    import sys

    if not hasattr(signal, "SIGUSR1"):  # pragma: no cover - platform guard
        return
    try:
        faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True, chain=False)
    except Exception as exc:  # pragma: no cover - never block startup over a diagnostic
        logging.getLogger(__name__).warning("stack-dump signal unavailable: %s", exc)
        return
    logging.getLogger(__name__).info(
        "stack-dump signal armed: `docker kill -s USR1 movie-assistant-gateway` "
        "dumps all thread stacks"
    )


def build_app(graph: Any) -> Any:
    """Return a FastAPI app exposing `graph` over AG-UI at AGENT_PATH, plus /health."""
    from ag_ui_langgraph import add_langgraph_fastapi_endpoint  # type: ignore[import-untyped]
    from fastapi import FastAPI

    from src.agui_identity import IdentityAwareAGUIAgent
    from src.runtime_context import (
        AgentConfigMiddleware,
        ImportFileMiddleware,
        SubjectTokenMiddleware,
        UiSnapshotMiddleware,
    )

    app = FastAPI(title="MCM Agent Gateway")
    # Capture the BFF-supplied per-user agent config (X-Agent-Config) per request (018 US2);
    # bridged into config["configurable"]["agent_config"] so model build uses per-run credentials.
    app.add_middleware(AgentConfigMiddleware)
    # Capture the BFF-supplied import-file reference (X-Import-File) per request for the import
    # flow (014 US2); bridged into config["configurable"] (file_handle/filename) like the snapshot.
    app.add_middleware(ImportFileMiddleware)
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

    # AFTER basicConfig, deliberately: this logs the one line that tells an operator the dump signal
    # is available, and a logger configured later would swallow it. Measured — the first version
    # armed the handler correctly and said nothing, so the capability was invisible to the
    # person who would need it.
    install_stack_dump_signal()

    # OpenTelemetry infra export (T030b) — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
    configure_otel(os.environ)
    configure_metrics(os.environ)
    enabled = production_nodes_enabled(os.environ)
    logging.getLogger(__name__).info(
        "gateway graph: %s nodes", "MCP-backed (production)" if enabled else "tool-free (default)"
    )
    return build_app(build_runtime_graph(os.environ))
