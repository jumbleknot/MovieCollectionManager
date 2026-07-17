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
from src.nodes.organizer import PlanFn, build_organizer
from src.proposals import Operation
from src.runtime_context import agent_config_scope
from src.tools import opa
from src.tools.agent_rate_limit import AgentToolRateLimiter, build_default_limiter
from src.tools.identity import (
    MC_SERVICE_AUDIENCE,
    AuthorizeFn,
    DownscopedTokenCache,
    ExchangeFn,
    acquire_downscoped_token,
)
from src.tools.mcp_tools import (
    McpServerConfig,
    ToolCallFn,
    call_mcp_tool,
    invoke_tool,
    tmdb_key_scope,
)
from src.tools.token_exchange import ExchangedToken, reexchange_for_mc_service
from src.tools.ui_action_tools import is_ui_action

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


def _runtime_env() -> Mapping[str, str]:
    """The per-run model env: the user's agent config (018 US2) overlaid on `os.environ`.

    Read from the node-task ContextVar (`get_agent_config`) the model-building node wrappers
    re-set from `config["configurable"]["agent_config"]`. None present → `os.environ` unchanged
    (the pre-018 shared-env behaviour, which the BFF gate prevents from reaching a real run).
    """
    import os

    from src.models import runtime_env
    from src.runtime_context import get_agent_config

    return runtime_env(get_agent_config(), os.environ)


def _default_extract(messages: Sequence[Any]) -> dict[str, Any]:
    """Model-backed entity extraction: pull {title, year, collection} from the request.

    Runtime-only (keeps import/compile LLM-free). Delegates to `extract_entities` so the
    same decision is exercised by the golden gate (T032). Sources the provider/base-URL/key
    from the per-run agent config (018 US2) — the pure `select_model_config`/`build_chat_model`
    signatures are unchanged, so the golden harness is unaffected.
    """
    from src.models import build_chat_model, select_model_config
    from src.nodes.curator import extract_entities

    env = _runtime_env()
    model = build_chat_model(select_model_config("curator", env), env)
    return extract_entities(model, messages)


def _default_plan(messages: Sequence[Any]) -> dict[str, Any]:
    """Model-backed organize-plan extraction (US2). Runtime-only; delegates to
    `plan_operations` so the same decision is exercised by the golden gate (T032). Sources the
    model from the per-run agent config (018 US2)."""
    from src.models import build_chat_model, select_model_config
    from src.nodes.organizer import plan_operations

    env = _runtime_env()
    model = build_chat_model(select_model_config("organizer", env), env)
    return plan_operations(model, messages)


def _default_query_extract(messages: Sequence[Any]) -> dict[str, Any]:
    """Model-backed query extraction (US4). Runtime-only; delegates to `extract_query` so the
    same decision is exercised by the golden gate (T071f). Sources the model from the per-run
    agent config (018 US2)."""
    from src.models import build_chat_model, select_model_config
    from src.nodes.query import extract_query

    env = _runtime_env()
    model = build_chat_model(select_model_config("query", env), env)
    return extract_query(model, messages)


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
    # 014 US2/US3 — file-processing MCP (parse/build). Optional: when unset the import/export
    # nodes degrade gracefully (no spreadsheet capability) without disabling the rest of the
    # graph, so production_nodes_enabled does NOT require it.
    spreadsheet_mcp_url: str = ""
    authorize: AuthorizeFn = field(default=opa.authorize_exchange)
    exchange: ExchangeFn = field(default=reexchange_for_mc_service)
    call: ToolCallFn = field(default=call_mcp_tool)
    extract: ExtractFn = field(default=_default_extract)
    plan: PlanFn = field(default=_default_plan)
    query_extract: ExtractFn = field(default=_default_query_extract)
    audience: str = MC_SERVICE_AUDIENCE

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "RuntimeNodeConfig":
        """Build the live production config from the gateway environment."""

        async def exchange(subject_token: str) -> ExchangedToken:
            return await reexchange_for_mc_service(subject_token, env=env)

        return cls(
            web_api_mcp_url=env["WEB_API_MCP_URL"],
            movie_mcp_url=env["MOVIE_MCP_URL"],
            spreadsheet_mcp_url=env.get("SPREADSHEET_MCP_URL", ""),
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


def _agent_config_of(config: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The per-run agent config bridged into config (018 US2), or None when absent."""
    cfg = _configurable(config).get("agent_config")
    return dict(cfg) if isinstance(cfg, Mapping) else None


def _tmdb_key_of(agent_config: Mapping[str, Any] | None) -> str | None:
    """The per-run TMDB key from the agent config (018 US2), or None. Never logged."""
    if not agent_config:
        return None
    return str(agent_config.get("tmdbKey") or "") or None


def _subject_token(config: Mapping[str, Any] | None) -> str | None:
    token = _configurable(config).get("subject_token")
    return str(token) if token else None


def _user_id(config: Mapping[str, Any] | None) -> str:
    return str(_configurable(config).get("user_id") or "")


def _last_human_text(messages: Sequence[Any]) -> str:
    """The most recent human message's text (handles message objects and ('user', text) tuples)."""
    for message in reversed(list(messages or [])):
        if getattr(message, "type", None) == "human":
            return str(getattr(message, "content", "") or "")
        if isinstance(message, (list, tuple)) and len(message) == 2 and message[0] == "user":
            return str(message[1] or "")
    return ""


def _stamp_ui_action_nonce(result: dict[str, Any], nonce: str) -> dict[str, Any]:
    """Stamp a per-emission `nonce` into every UI-action (`navigate_*`/`prefill_*`) tool call.

    The client dedups UI-action dispatch by a module-level set; keying on the target alone
    swallowed a SECOND genuine navigation to a collection already visited this session (013 Inc5
    nav bug). The render callback only gets `{args, status}` — no tool-call id — so the
    discriminator must ride in the args. The nonce is the run's message count (unique per turn,
    stable once the message is checkpointed → a dock re-mount replays the same nonce and stays
    deduped). No-op for a result with no UI-action tool call.
    """
    for message in result.get("messages", []) or []:
        for call in getattr(message, "tool_calls", None) or []:
            if is_ui_action(str(call.get("name", ""))):
                call.setdefault("args", {})["nonce"] = nonce
    return result


def _ui_snapshot(config: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The sanitized UI-state snapshot bridged in via config (US3/R15), or None.

    Carried out-of-band (BFF X-UI-Snapshot header → gateway middleware → config), never the
    run body and never checkpointed. The organizer reads it to resolve "this"/current-screen.
    """
    snapshot = _configurable(config).get("ui_snapshot")
    return dict(snapshot) if isinstance(snapshot, Mapping) else None


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

    node = build_curator(extract=cfg.extract, search=search, details=details)

    async def curator(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        # Bind the per-run agent config (018 US2) so the model-build closure (cfg.extract →
        # _default_extract) and the token-free web-api-mcp call (X-TMDB-Key) source the user's
        # own credentials. The curator only ever calls web-api-mcp, so binding the TMDB key for
        # the whole node carries no risk of leaking it to a user-identity (movie-mcp) server.
        agent_config = _agent_config_of(config)
        with agent_config_scope(agent_config), tmdb_key_scope(_tmdb_key_of(agent_config)):
            return await node(state)

    return curator


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
        # US3: thread the per-run UI snapshot from config into the node state so the pure
        # organizer can resolve "this"/current-screen. Always set (None when absent) so a
        # stale checkpointed snapshot never leaks into a later turn (R15).
        state = {**state, "ui_snapshot": _ui_snapshot(config)}

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

        # Bind the per-run agent config (018 US2) so the plan model build (cfg.plan →
        # _default_plan) sources the user's own provider/key. The organizer only calls movie-mcp
        # (identity-scoped) — no TMDB key is bound here.
        with agent_config_scope(_agent_config_of(config)):
            return await build_organizer(
                list_collections=list_collections, list_movies=list_movies, plan=cfg.plan
            )(state)

    return organizer


def _build_navigator_node(cfg: RuntimeNodeConfig) -> Any:
    """Navigator (US3/T059) reads via movie-mcp using the per-run downscoped token from config.

    Resolution is pure code (no LLM); the reads only ever return the user's OWN collections/
    movies, so an emitted navigate/prefill target is reachable by construction (FR-011/FR-012).
    The BFF `ui-action-authorizer` (T026) is the compensating role gate at the boundary.
    """
    from src.nodes.navigator import build_navigator

    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )

    async def navigator(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        acquire = _make_acquire(cfg, user_id)
        state = {**state, "ui_snapshot": _ui_snapshot(config)}

        async def list_collections() -> list[dict[str, Any]]:
            out = await invoke_tool(
                agent="navigator", tool_name="list_collections", arguments={}, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if not out.ok or not isinstance(out.data, list):
                return []
            return list(out.data)

        async def list_movies(collection_id: str) -> list[dict[str, Any]]:
            items: list[dict[str, Any]] = []
            cursor: str | None = None
            for _ in range(200):  # safety bound (200 * 50 = 10k movies)
                args: dict[str, Any] = {"collectionId": collection_id}
                if cursor:
                    args["cursor"] = cursor
                out = await invoke_tool(
                    agent="navigator", tool_name="list_movies", arguments=args, server=movie,
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

        nonce = str(len(state.get("messages", []) or []))
        result = await build_navigator(
            list_collections=list_collections, list_movies=list_movies
        )(state)
        return _stamp_ui_action_nonce(result, nonce)

    return navigator


def _build_query_node(cfg: RuntimeNodeConfig) -> Any:
    """Query node (US4/T071) reads via movie-mcp using the per-run downscoped token from config.

    Read-only: count / list / find-in-collection. The reads only ever return the user's OWN
    collections/movies, so an answer can never describe a collection the user couldn't reach
    (FR-010/011/012a — DAC parity). The mode + collection/title resolution is pure code; the model
    only extracts `{collection_ref, movie_title, filter}` (golden-gated, T071f).
    """
    from src.nodes.query import build_query_node

    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )

    async def query(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        acquire = _make_acquire(cfg, user_id)
        state = {**state, "ui_snapshot": _ui_snapshot(config)}

        async def list_collections() -> list[dict[str, Any]]:
            out = await invoke_tool(
                agent="query", tool_name="list_collections", arguments={}, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if not out.ok or not isinstance(out.data, list):
                return []
            return list(out.data)

        async def list_movies(
            collection_id: str, filters: dict[str, Any] | None = None
        ) -> dict[str, Any]:
            # Query reads the FIRST page only (count is the total; the page is the preview).
            args: dict[str, Any] = {"collectionId": collection_id}
            if filters:
                args["filter"] = filters
            out = await invoke_tool(
                agent="query", tool_name="list_movies", arguments=args, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if not out.ok or not isinstance(out.data, dict):
                return {"items": [], "nextCursor": None}
            return dict(out.data)

        async def count_movies(
            collection_id: str, filters: dict[str, Any] | None = None
        ) -> int:
            args: dict[str, Any] = {"collectionId": collection_id}
            if filters:
                args["filter"] = filters
            out = await invoke_tool(
                agent="query", tool_name="count_movies", arguments=args, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if not out.ok or not isinstance(out.data, dict):
                return 0
            try:
                return int(out.data.get("count", 0))
            except (TypeError, ValueError):
                return 0

        # Bind the per-run agent config (018 US2) so the query model build (cfg.query_extract →
        # _default_query_extract) sources the user's own provider/key. Query only calls movie-mcp.
        with agent_config_scope(_agent_config_of(config)):
            return await build_query_node(
                list_collections=list_collections,
                list_movies=list_movies,
                count_movies=count_movies,
                extract=cfg.query_extract,
            )(state)

    return query


def _build_search_node(cfg: RuntimeNodeConfig) -> Any:
    """Search node (US7/T066): the unified movie-search workflow.

    Combines movie-mcp reads (the user's OWN collections/movies, per-run downscoped token) with a
    token-free web-api-mcp `search_title` fallback. Resolution + disambiguation are pure code (no
    LLM → no golden churn); the reads only return the user's own data, so a navigate target is
    reachable by construction (FR-030 / DAC parity).
    """
    from src.nodes.search import build_search_node

    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )
    web = McpServerConfig(name="web-api-mcp", url=cfg.web_api_mcp_url, needs_token=False)

    async def _no_token(_subject: str, _audience: str) -> str:
        return ""  # web-api-mcp is outbound-only — never carries a user token

    async def search(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        acquire = _make_acquire(cfg, user_id)
        state = {**state, "ui_snapshot": _ui_snapshot(config)}

        async def list_collections() -> list[dict[str, Any]]:
            out = await invoke_tool(
                agent="search", tool_name="list_collections", arguments={}, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if not out.ok or not isinstance(out.data, list):
                return []
            return list(out.data)

        async def list_movies(collection_id: str, term: str) -> list[dict[str, Any]]:
            # Owned search: the first page of the server-side search is enough — the node
            # post-filters article-insensitively (US8).
            args: dict[str, Any] = {"collectionId": collection_id}
            if term:
                args["filter"] = {"search": term}
            out = await invoke_tool(
                agent="search", tool_name="list_movies", arguments=args, server=movie,
                subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            if not out.ok or not isinstance(out.data, dict):
                return []
            return list(out.data.get("items", []))

        tmdb_key = _tmdb_key_of(_agent_config_of(config))

        async def web_search(query: str, year: int | None) -> dict[str, Any]:
            args: dict[str, Any] = {"query": query}
            if year is not None:
                args["year"] = year
            # Bind the per-run TMDB key (018 US2) ONLY around the web-api-mcp call — search also
            # reads movie-mcp above, which must never receive the user's TMDB key.
            with tmdb_key_scope(tmdb_key):
                out = await invoke_tool(
                    agent="search", tool_name="search_title", arguments=args, server=web,
                    subject_token=None, call=cfg.call, limiter=cfg.limiter, acquire_token=_no_token,
                )
            if not out.ok or not isinstance(out.data, dict):
                return {"results": []}  # graceful: "couldn't find it"
            return dict(out.data)

        nonce = str(len(state.get("messages", []) or []))
        result = await build_search_node(
            list_collections=list_collections, list_movies=list_movies, web_search=web_search
        )(state)
        return _stamp_ui_action_nonce(result, nonce)

    return search


def _build_import_node(cfg: RuntimeNodeConfig) -> Any:
    """Import node (014 US2/US4): parse spreadsheet → guided clarification → HITL proposal batches.

    Code-orchestrated (no LLM — the supervisor already classified `import`). A FRESH turn parses
    via spreadsheet-mcp (token-free, by handle), reads collections via movie-mcp (downscoped
    token), and collects any disambiguations (tab→collection / medium column / uncertain article,
    US4). If anything needs deciding it asks with buttons and persists the parsed context — so a
    button-tap turn resolves the pick in PURE CODE without re-parsing the single-use handle. Once
    everything is resolved it builds the pure ImportPreview + approval-gate Proposal batches; the
    SHARED gate previews + applies the writes (idempotent, FR-020/SC-009). The file handle/filename
    ride config["configurable"] (BFF bridge), never the run body or checkpoint.
    """
    from dataclasses import asdict

    from langchain_core.messages import AIMessage

    from src.graph import _IMPORT_STATE_RESET
    from src.nodes.import_collection import (
        build_import_preview,
        build_import_proposals,
        resolve_tab_collection,
    )
    from src.nodes.import_disambiguation import (
        ImportPrompt,
        apply_import_pick,
        collect_import_disambiguations,
        resolve_import_pick,
        to_selection_options,
    )
    from src.tools.generative_ui_tools import (
        RENDER_SELECTION,
        REQUEST_IMPORT_FILE,
        render_selection,
        request_import_file,
    )
    from src.tools.spreadsheet_tools import (
        fetch_parsed,
        parse_spreadsheet,
        spreadsheet_server,
        stash_parsed,
    )

    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )
    spreadsheet = spreadsheet_server(cfg.spreadsheet_mcp_url)

    async def _import_impl(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        configurable = _configurable(config)
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        thread_id = str(configurable.get("thread_id") or user_id or "import")
        acquire = _make_acquire(cfg, user_id)

        async def list_collections() -> list[dict[str, Any]]:
            out = await invoke_tool(
                agent="import_collection", tool_name="list_collections", arguments={},
                server=movie, subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
                # 040 US2 FR-015: a large import's code-orchestrated dedup reads over a FINITE set
                # (the user's own collections/movies) must not be throttled into a silently partial
                # list — same exemption the import writes already carry.
                skip_rate_limit=True,
            )
            return list(out.data) if out.ok and isinstance(out.data, list) else []

        async def list_movies(collection_id: str) -> list[dict[str, Any]]:
            items: list[dict[str, Any]] = []
            cursor: str | None = None
            for _ in range(200):  # safety bound (200 * 50 = 10k movies)
                args: dict[str, Any] = {"collectionId": collection_id}
                if cursor:
                    args["cursor"] = cursor
                out = await invoke_tool(
                    agent="import_collection", tool_name="list_movies", arguments=args,
                    server=movie, subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                    acquire_token=acquire, rate_scope=user_id,
                    skip_rate_limit=True,  # 040 US2 FR-015 — see list_collections above
                )
                if not out.ok or not isinstance(out.data, dict):
                    break
                items.extend(out.data.get("items", []))
                cursor = out.data.get("nextCursor")
                if not cursor:
                    break
            return items

        def _ask(
            prompt: ImportPrompt,
            carrier: dict[str, Any],
            resolutions: dict[str, Any],
        ) -> dict[str, Any]:
            """Surface one disambiguation prompt as buttons + persist the pointer to the parsed
            data. `carrier` is `{"import_handle": <handle>}` (040 US2 T024 — the parsed dataset
            lives in the spreadsheet-mcp transient store, only the small handle is checkpointed) OR
            `{"import_context": {tabs, collections}}` (the inline legacy fallback used only when a
            stash call fails, so the import never regresses to a silent stop)."""
            return {
                "import_stage": "awaiting_import_choice",
                "import_prompt": asdict(prompt),
                "import_resolutions": resolutions,
                **carrier,
                "messages": [
                    AIMessage(
                        content=prompt.question,
                        tool_calls=[
                            {
                                "name": RENDER_SELECTION,
                                "args": render_selection(to_selection_options(prompt)),
                                "id": f"import-pick-{prompt.kind}-{prompt.key[:24]}",
                            }
                        ],
                    )
                ],
            }

        async def _finalize(
            tabs: list[dict[str, Any]],
            collections: list[dict[str, Any]],
            resolutions: dict[str, Any],
        ) -> dict[str, Any]:
            """All disambiguations resolved → fetch existing movies for targeted collections, build
            the preview + proposal batches, and clear the import context."""
            collection_res = resolutions.get("collection") or {}
            by_id = {str(c.get("collectionId")): c for c in collections}
            existing_by_collection: dict[str, list[dict[str, Any]]] = {}
            for tab in tabs:
                if not tab.get("eligible"):
                    continue
                name = str(tab.get("name", ""))
                if name in collection_res:
                    target = by_id.get(str(collection_res[name]))
                else:
                    target, _options = resolve_tab_collection(name, collections)
                if target is not None:
                    cid = str(target["collectionId"])
                    if cid not in existing_by_collection:
                        existing_by_collection[cid] = await list_movies(cid)

            preview = build_import_preview(
                tabs=tabs, collections=collections,
                existing_by_collection=existing_by_collection, thread_id=thread_id,
                resolutions=resolutions,
            )
            proposals = build_import_proposals(preview, thread_id)
            if not proposals:
                return {
                    **_IMPORT_STATE_RESET,
                    "messages": [
                        AIMessage(content="I didn't find any movies to import from that file.")
                    ],
                }
            first, rest = proposals[0], proposals[1:]
            return {
                **_IMPORT_STATE_RESET,
                "pending_proposal": first, "pending_batches": rest,
                "status": "awaiting_approval",
            }

        # ── Continuation turn: resolve the user's button tap (no re-parse) ──────────────────
        if str(state.get("import_stage") or "") == "awaiting_import_choice":
            # Re-materialise the parsed dataset. Preferred: fetch it from the transient store by the
            # checkpointed handle (T024 — the store refreshes the TTL on read so the session never
            # expires mid-import, FR-016). Fallbacks preserve reliability: a legacy inline
            # `import_context` checkpoint (in-flight across a deploy), and a graceful "please
            # re-upload" if the handle is gone (never a silent stop — FR-014).
            handle = str(state.get("import_handle") or "")
            context: dict[str, Any] = {}
            carrier: dict[str, Any] = {}
            if handle:
                fetched = await fetch_parsed(
                    agent="import_collection", parsed_handle=handle, server=spreadsheet,
                    call=cfg.call, limiter=cfg.limiter, rate_scope=user_id,
                )
                if fetched.ok and isinstance(fetched.data, dict):
                    context = fetched.data
                    carrier = {"import_handle": handle}
            if not context:
                context = dict(state.get("import_context") or {})
                carrier = {"import_context": context} if context else {}
            if not context:
                return {
                    **_IMPORT_STATE_RESET,
                    "messages": [
                        AIMessage(
                            content="That import session expired — please re-upload the "
                            "spreadsheet to continue."
                        )
                    ],
                }
            tabs = list(context.get("tabs") or [])
            collections = list(context.get("collections") or [])
            resolutions = dict(state.get("import_resolutions") or {})
            prompt_d = state.get("import_prompt") or {}
            prompt = ImportPrompt(
                kind=str(prompt_d.get("kind", "")), key=str(prompt_d.get("key", "")),
                question=str(prompt_d.get("question", "")),
                options=list(prompt_d.get("options") or []),
            )
            text = _last_human_text(state.get("messages", []))
            chosen = resolve_import_pick(text, prompt)
            if chosen is None:
                return _ask(prompt, carrier, resolutions)  # re-ask the same question
            resolutions = apply_import_pick(resolutions, prompt, chosen)
            remaining = collect_import_disambiguations(tabs, collections, resolutions)
            if remaining:
                return _ask(remaining[0], carrier, resolutions)
            return await _finalize(tabs, collections, resolutions)

        # ── Fresh turn: parse + collect disambiguations ────────────────────────────────────
        file_handle = str(configurable.get("file_handle") or "")
        filename = str(configurable.get("filename") or "upload.xlsx")
        if not cfg.spreadsheet_mcp_url:
            return {
                "messages": [AIMessage(content="Spreadsheet import isn't available right now.")]
            }
        if not file_handle:
            # No file staged yet (the user typed an import request) — ask for one with a
            # Choose-file / Cancel affordance instead of an always-on upload button (014 UX fix).
            return {
                "messages": [
                    AIMessage(
                        content="Sure — choose the spreadsheet you'd like to import.",
                        tool_calls=[
                            {
                                "name": REQUEST_IMPORT_FILE,
                                "args": request_import_file(),
                                "id": "request-import-file",
                            }
                        ],
                    )
                ]
            }

        parsed = await parse_spreadsheet(
            agent="import_collection", file_handle=file_handle, filename=filename,
            server=spreadsheet, call=cfg.call, limiter=cfg.limiter, rate_scope=user_id,
        )
        if not parsed.ok or not isinstance(parsed.data, dict):
            return {
                "messages": [
                    AIMessage(content="I couldn't read that file — please upload a valid CSV or "
                              "Excel spreadsheet.")
                ]
            }
        tabs = list(parsed.data.get("tabs", []))
        collections = await list_collections()
        prompts = collect_import_disambiguations(tabs, collections, {})
        if prompts:
            # Stash the parsed dataset ONCE and checkpoint only its handle across every
            # clarification turn (T024). If the stash fails, fall back to the inline context so the
            # import still completes (FR-014) — just without the checkpoint-size win this session.
            stashed = await stash_parsed(
                agent="import_collection",
                parsed={"tabs": tabs, "collections": collections},
                server=spreadsheet, call=cfg.call, limiter=cfg.limiter, rate_scope=user_id,
            )
            if stashed.ok and isinstance(stashed.data, dict) and stashed.data.get("parsedHandle"):
                carrier = {"import_handle": str(stashed.data["parsedHandle"])}
            else:
                carrier = {"import_context": {"tabs": tabs, "collections": collections}}
            return _ask(prompts[0], carrier, {})
        return await _finalize(tabs, collections, {})

    async def import_collection(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        # 040 US2 FR-014: the import node must ALWAYS surface an outcome. The body has no internal
        # try/except and a non-transient tool error re-raises out of it — which ends the run with
        # NO user-facing reply (a blank "it just stopped"). Wrap it so any failure degrades to a
        # clear message instead of a silent stop (mirrors the supervisor's _degrade_node). The
        # reason is intentionally generic — never echo raw exception text (may carry internals).
        try:
            return await _import_impl(state, config)
        except Exception:  # noqa: BLE001 — any import failure degrades to a visible message
            return {
                **_IMPORT_STATE_RESET,
                "messages": [
                    AIMessage(
                        content="Sorry — the import failed and couldn't be completed. "
                        "Please try again."
                    )
                ],
            }

    return import_collection


def _build_export_node(cfg: RuntimeNodeConfig) -> Any:
    """Export node (014 US3): build a multi-tab `.xlsx` from the user's collections → download.

    Read-only and fully code-orchestrated (the supervisor already classified `export`): read the
    selected collections + their movies via movie-mcp (downscoped token), shape them into pure
    `build_workbook` tabs, build the workbook via spreadsheet-mcp (token-free, by handle), and
    emit a `download_export` UI-action carrying the transient download handle. No write gate — the
    only side effect is the short-TTL export blob the BFF download route streams. The selected
    collection ids ride config["configurable"] (BFF bridge); empty selection ⇒ all collections.
    """
    from langchain_core.messages import AIMessage

    from src.nodes.export_collection import build_export_tabs, select_export_collections
    from src.tools.spreadsheet_tools import build_workbook, spreadsheet_server
    from src.tools.ui_action_tools import DOWNLOAD_EXPORT, download_export

    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )
    spreadsheet = spreadsheet_server(cfg.spreadsheet_mcp_url)

    async def export_collection(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        configurable = _configurable(config)
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        acquire = _make_acquire(cfg, user_id)
        requested = list(configurable.get("export_collection_ids") or [])

        if not cfg.spreadsheet_mcp_url:
            return {"messages": [AIMessage(content="Export isn't available right now.")]}

        async def list_collections() -> list[dict[str, Any]]:
            out = await invoke_tool(
                agent="export_collection", tool_name="list_collections", arguments={},
                server=movie, subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                acquire_token=acquire, rate_scope=user_id,
            )
            return list(out.data) if out.ok and isinstance(out.data, list) else []

        async def list_movies(collection_id: str) -> list[dict[str, Any]]:
            items: list[dict[str, Any]] = []
            cursor: str | None = None
            for _ in range(200):  # safety bound (200 * 50 = 10k movies)
                args: dict[str, Any] = {"collectionId": collection_id}
                if cursor:
                    args["cursor"] = cursor
                out = await invoke_tool(
                    agent="export_collection", tool_name="list_movies", arguments=args,
                    server=movie, subject_token=subject_token, call=cfg.call, limiter=cfg.limiter,
                    acquire_token=acquire, rate_scope=user_id,
                )
                if not out.ok or not isinstance(out.data, dict):
                    break
                items.extend(out.data.get("items", []))
                cursor = out.data.get("nextCursor")
                if not cursor:
                    break
            return items

        collections = await list_collections()
        chosen = select_export_collections(requested, collections)
        if not chosen:
            return {
                "messages": [
                    AIMessage(content="You don't have any collections to export yet.")
                ]
            }

        tab_data = [
            {
                "collectionName": str(c.get("name") or ""),
                "movies": await list_movies(cid),
            }
            # Defensive: a malformed collection record (no id) is skipped rather than KeyError —
            # the empty-request branch of select_export_collections returns records verbatim.
            for c in chosen
            if (cid := str(c.get("collectionId") or ""))
        ]
        tabs = build_export_tabs(tab_data)

        built = await build_workbook(
            agent="export_collection", tabs=tabs, server=spreadsheet, call=cfg.call,
            limiter=cfg.limiter, rate_scope=user_id,
        )
        if not built.ok or not isinstance(built.data, dict):
            return {
                "messages": [
                    AIMessage(content="Sorry — I couldn't build that export. Please try again.")
                ]
            }
        handle = str(built.data.get("downloadHandle") or "")
        filename = str(built.data.get("filename") or "movie-collections-export.xlsx")
        names = ", ".join(str(c.get("name") or "") for c in chosen)
        nonce = str(len(state.get("messages", []) or []))
        result = {
            "messages": [
                AIMessage(
                    content=f"Your export of {names} is ready to download.",
                    tool_calls=[
                        {
                            "name": DOWNLOAD_EXPORT,
                            "args": download_export(handle, filename),
                            "id": f"export-{handle[:16]}",
                        }
                    ],
                )
            ]
        }
        return _stamp_ui_action_nonce(result, nonce)

    return export_collection


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
                # HITL-approved, code-orchestrated, bounded writes are not a runaway loop — don't
                # let the per-agent tool-call limiter throttle a large approved import/organize
                # (014: a 200-row import was capped at 30, failing the other 170).
                skip_rate_limit=True,
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
            # Surface the upstream status in the failure reason so the import report is actionable
            # (the user can see, e.g., a 401/timeout vs a validation error) — the status code is
            # non-sensitive (no token/PII).
            reason = out.error or "failed"
            if out.status:
                reason = f"{reason} (mc-service {out.status})"
            return ExecOutcome(status="failed", error=reason)

        return await build_approval_gate(execute=execute)(state)

    return approval_gate


def build_runtime_nodes(cfg: RuntimeNodeConfig) -> dict[str, Any]:
    """Build the three real specialist nodes from runtime config (gateway-injected)."""
    return {
        "curator": _build_curator_node(cfg),
        "organizer": _build_organizer_node(cfg),
        "navigator": _build_navigator_node(cfg),
        "query": _build_query_node(cfg),
        "search": _build_search_node(cfg),
        "import_collection": _build_import_node(cfg),
        "export_collection": _build_export_node(cfg),
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
    # Process-global error-rate circuit breaker (T030): created once with the graph so its
    # rolling window persists across runs for the gateway's lifetime.
    from src.circuit_breaker import ErrorRateBreaker

    circuit = ErrorRateBreaker.from_env(env)
    if not (force or production_nodes_enabled(env)):
        return build_graph(classifier=classifier, checkpointer=checkpointer, circuit=circuit)
    cfg = config or RuntimeNodeConfig.from_env(env)
    nodes = build_runtime_nodes(cfg)
    return build_graph(
        classifier=classifier, checkpointer=checkpointer, circuit=circuit, **nodes
    )
