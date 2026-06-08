"""Production-node factory: assemble the real MCP-backed specialist nodes (US1 Slice G).

The graph STRUCTURE is fixed (src/graph.py); the curator/organizer/approval_gate nodes are
injectable. This module builds the *real* nodes — closures over the Slice-F2 tool choke point
(`tools.mcp_tools.invoke_tool`) and the T024 identity seam (`tools.identity.
acquire_downscoped_token`) — and gateway-injects them when production is enabled.

Design (decided 2026-06-07; see HANDOFF "Key architecture findings" + token refinements):
- **Code-orchestrated tools.** The LLM only extracts entities / phrases replies; code drives
  every MCP call through `invoke_tool` (allowlist → rate-limit → identity → guard).
- **Subject token via `config["configurable"]`**, never checkpointed state (SC-004) and never a
  fragile deep-graph ContextVar (the F2 refinement). The gateway/graph-entry populates
  `configurable.subject_token` + `configurable.user_id` per run/HITL-resume; the organizer and
  approval_gate read them and build per-run token closures.
- **Per-call downscoped token.** `acquire_downscoped_token` is invoked per tool call (its ≤60 s
  cache + re-exchange-on-expiry live in the injected seam) — never once per turn.
- **Curator is token-free** (web-api-mcp is outbound-only); only movie-mcp (organizer reads +
  approval-time writes) carries the downscoped `aud=mc-service` token.

GATING (SC-005): `build_graph()` defaults stay tool-free; `build_runtime_graph` only injects the
real nodes when `production_nodes_enabled(env)` (both MCP URLs set) — so the existing assistant
E2E/regression are unaffected until the deploy cut-over. The real transport/exchange validate
live in T036; the composition + identity routing are unit-tested via `build_runtime_graph(...,
force=True)` with injected `call`/`authorize`/`exchange`.
"""

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from langchain_core.runnables import RunnableConfig

from src.graph import build_graph
from src.nodes.approval_gate import ExecOutcome, build_approval_gate
from src.nodes.curator import ExtractFn, build_curator
from src.nodes.organizer import build_organizer
from src.proposals import Operation
from src.tools import opa
from src.tools.agent_rate_limit import AgentToolRateLimiter, build_default_limiter
from src.tools.identity import (
    MC_SERVICE_AUDIENCE,
    AuthorizeFn,
    DownscopedTokenCache,
    ExchangeFn,
    acquire_downscoped_token,
)
from src.tools.mcp_tools import McpServerConfig, ToolCallFn, call_mcp_tool, invoke_tool
from src.tools.token_exchange import ExchangedToken, reexchange_for_mc_service

# Approved-proposal operation → movie-mcp write tool (contracts/movie-mcp-tools.md).
_OP_TO_TOOL: dict[Operation, str] = {
    Operation.create_collection: "create_collection",
    Operation.add: "add_movie",
    Operation.update: "update_movie",
    Operation.remove: "delete_movie",
}


def production_nodes_enabled(env: Mapping[str, str]) -> bool:
    """Whether the gateway should inject the real MCP-backed nodes (both MCP URLs configured)."""
    return bool(env.get("WEB_API_MCP_URL", "").strip() and env.get("MOVIE_MCP_URL", "").strip())


def _default_extract(messages: Sequence[Any]) -> dict[str, Any]:
    """Model-backed entity extraction: pull {title, year, collection} from the request.

    Runtime-only (keeps import/compile LLM-free). Delegates to `extract_entities` so the
    same decision is exercised by the golden gate (T032).
    """
    import os

    from src.models import build_chat_model, select_model_config
    from src.nodes.curator import extract_entities

    model = build_chat_model(select_model_config("curator", os.environ))
    return extract_entities(model, messages)


@dataclass
class RuntimeNodeConfig:
    """Everything needed to build the real nodes. Injectable so the composition is unit-testable.

    `authorize`/`exchange`/`call`/`extract` default to the live implementations; tests pass
    deterministic stand-ins. `cache`/`limiter` are process-lived (the gateway owns one instance).
    """

    web_api_mcp_url: str
    movie_mcp_url: str
    limiter: AgentToolRateLimiter
    cache: DownscopedTokenCache
    authorize: AuthorizeFn = field(default=opa.authorize_exchange)
    exchange: ExchangeFn = field(default=reexchange_for_mc_service)
    call: ToolCallFn = field(default=call_mcp_tool)
    extract: ExtractFn = field(default=_default_extract)
    audience: str = MC_SERVICE_AUDIENCE

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "RuntimeNodeConfig":
        """Build the live production config from the gateway environment."""

        async def exchange(subject_token: str) -> ExchangedToken:
            return await reexchange_for_mc_service(subject_token, env=env)

        return cls(
            web_api_mcp_url=env["WEB_API_MCP_URL"],
            movie_mcp_url=env["MOVIE_MCP_URL"],
            limiter=build_default_limiter(env),
            cache=DownscopedTokenCache(),
            authorize=opa.authorize_exchange,
            exchange=exchange,
            call=call_mcp_tool,
            extract=_default_extract,
        )


# ── per-run identity helpers (read from config["configurable"], never state) ──────────────


def _configurable(config: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return config.get("configurable", {}) if config else {}


def _subject_token(config: Mapping[str, Any] | None) -> str | None:
    token = _configurable(config).get("subject_token")
    return str(token) if token else None


def _user_id(config: Mapping[str, Any] | None) -> str:
    return str(_configurable(config).get("user_id") or "")


def _make_acquire(cfg: RuntimeNodeConfig, user_id: str) -> Callable[[str, str], Awaitable[str]]:
    async def acquire(subject_token: str, audience: str) -> str:
        return await acquire_downscoped_token(
            subject_token,
            user_id=user_id,
            authorize=cfg.authorize,
            exchange=cfg.exchange,
            cache=cfg.cache,
            audience=audience,
        )

    return acquire


# ── node builders ─────────────────────────────────────────────────────────────────────────


def _build_curator_node(cfg: RuntimeNodeConfig) -> Any:
    """Curator over web-api-mcp (token-free). Enrichment is code-orchestrated; LLM only extracts."""
    web = McpServerConfig(name="web-api-mcp", url=cfg.web_api_mcp_url, needs_token=False)

    async def _no_token(_subject: str, _audience: str) -> str:
        return ""  # web-api-mcp is outbound-only — never carries a user token

    async def search(query: str, year: int | None) -> dict[str, Any]:
        args: dict[str, Any] = {"query": query}
        if year is not None:
            args["year"] = year
        out = await invoke_tool(
            agent="curator", tool_name="search_title", arguments=args, server=web,
            subject_token=None, call=cfg.call, limiter=cfg.limiter, acquire_token=_no_token,
        )
        if not out.ok or not isinstance(out.data, dict):
            return {"matchConfidence": "none", "results": []}  # graceful: "couldn't find it"
        return dict(out.data)

    async def details(source_id: str) -> dict[str, Any]:
        out = await invoke_tool(
            agent="curator", tool_name="get_movie_details", arguments={"sourceId": source_id},
            server=web, subject_token=None, call=cfg.call, limiter=cfg.limiter,
            acquire_token=_no_token,
        )
        if not out.ok or not isinstance(out.data, dict):
            raise RuntimeError("movie details lookup failed")
        return dict(out.data)

    return build_curator(extract=cfg.extract, search=search, details=details)


def _default_plan(messages: Sequence[Any]) -> dict[str, Any]:
    """Model-backed organize-plan extraction (US2). Runtime-only; delegates to
    `plan_operations` so the same decision is exercised by the golden gate (T032)."""
    import os

    from src.models import build_chat_model, select_model_config
    from src.nodes.organizer import plan_operations

    model = build_chat_model(select_model_config("organizer", os.environ))
    return plan_operations(model, messages)


def _build_organizer_node(cfg: RuntimeNodeConfig) -> Any:
    """Organizer reads via movie-mcp using the per-run downscoped token from config.

    US1 add reads `list_collections`; US2 organize also reads `list_movies` (fully paginated)
    and extracts the plan with the model. Code-orchestrated — the model only names the
    collection + titles; CODE resolves ids and builds the idempotent batch.
    """
    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )

    async def organizer(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        acquire = _make_acquire(cfg, user_id)

        async def list_collections() -> list[dict[str, Any]]:
            out = await invoke_tool(
                agent="organizer", tool_name="list_collections", arguments={}, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if not out.ok or not isinstance(out.data, list):
                return []
            return list(out.data)

        async def list_movies(collection_id: str) -> list[dict[str, Any]]:
            # Read ALL movies (paginate mc-service keyset cursor) so organize resolution +
            # re-validation see the whole collection, not just the first page.
            items: list[dict[str, Any]] = []
            cursor: str | None = None
            for _ in range(200):  # safety bound (200 * 50 = 10k movies)
                args: dict[str, Any] = {"collectionId": collection_id}
                if cursor:
                    args["cursor"] = cursor
                out = await invoke_tool(
                    agent="organizer", tool_name="list_movies", arguments=args, server=movie,
                    subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                    acquire_token=acquire, rate_scope=user_id,
                )
                if not out.ok or not isinstance(out.data, dict):
                    break
                items.extend(out.data.get("items", []))
                cursor = out.data.get("nextCursor")
                if not cursor:
                    break
            return items

        return await build_organizer(
            list_collections=list_collections, list_movies=list_movies, plan=_default_plan
        )(state)

    return organizer


def _build_approval_gate_node(cfg: RuntimeNodeConfig) -> Any:
    """Approval gate: HITL interrupt, then apply writes via movie-mcp on approved resume.

    The write executor is rebuilt each invocation so the fresh subject token minted on resume
    (T044) is used; the paused run holds no token (SC-004).
    """
    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )

    async def approval_gate(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        acquire = _make_acquire(cfg, user_id)

        async def execute(
            operation: Operation, args: dict[str, Any], idempotency_key: str
        ) -> ExecOutcome:
            tool = _OP_TO_TOOL[operation]
            arguments = {**args, "idempotencyKey": idempotency_key}
            out = await invoke_tool(
                agent="organizer", tool_name=tool, arguments=arguments, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if out.ok:
                return ExecOutcome(
                    status="applied", data=out.data if isinstance(out.data, dict) else None
                )
            # A 409 means mc-service already holds this movie/collection (per-collection/owner
            # uniqueness) — at-most-once already held; classify it as skipped_duplicate, not a
            # failure (T024a/SC-006/FR-009a). invoke_tool surfaces the upstream status.
            if out.status == 409:
                return ExecOutcome(status="skipped_duplicate")
            # A 404 at apply time means the movie/collection drifted away (deleted since the
            # proposal was built) — skip+report it, don't fail the batch (FR-009a/SC-010).
            if out.status == 404:
                return ExecOutcome(status="skipped_missing")
            return ExecOutcome(status="failed", error=out.error)

        return await build_approval_gate(execute=execute)(state)

    return approval_gate


def build_runtime_nodes(cfg: RuntimeNodeConfig) -> dict[str, Any]:
    """Build the three real specialist nodes from runtime config (gateway-injected)."""
    return {
        "curator": _build_curator_node(cfg),
        "organizer": _build_organizer_node(cfg),
        "approval_gate": _build_approval_gate_node(cfg),
    }


def build_runtime_graph(
    env: Mapping[str, str],
    *,
    config: RuntimeNodeConfig | None = None,
    classifier: Callable[[Sequence[Any]], str] | None = None,
    checkpointer: Any | None = None,
    force: bool = False,
) -> Any:
    """Compile the supervisor graph, injecting the real nodes when production is enabled.

    When disabled (no MCP URLs, not forced) returns the tool-free `build_graph()` — keeping
    pre-US1 behavior so SC-005 holds. `force=True` (tests) builds from the injected `config`.
    """
    if not (force or production_nodes_enabled(env)):
        return build_graph(classifier=classifier, checkpointer=checkpointer)
    cfg = config or RuntimeNodeConfig.from_env(env)
    nodes = build_runtime_nodes(cfg)
    return build_graph(classifier=classifier, checkpointer=checkpointer, **nodes)
