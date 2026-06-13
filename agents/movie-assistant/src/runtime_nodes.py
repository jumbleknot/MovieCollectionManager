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


def _default_plan(messages: Sequence[Any]) -> dict[str, Any]:
    """Model-backed organize-plan extraction (US2). Runtime-only; delegates to
    `plan_operations` so the same decision is exercised by the golden gate (T032)."""
    import os

    from src.models import build_chat_model, select_model_config
    from src.nodes.organizer import plan_operations

    model = build_chat_model(select_model_config("organizer", os.environ))
    return plan_operations(model, messages)


def _default_query_extract(messages: Sequence[Any]) -> dict[str, Any]:
    """Model-backed query extraction (US4). Runtime-only; delegates to `extract_query` so the
    same decision is exercised by the golden gate (T071f)."""
    import os

    from src.models import build_chat_model, select_model_config
    from src.nodes.query import extract_query

    model = build_chat_model(select_model_config("query", os.environ))
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


def _subject_token(config: Mapping[str, Any] | None) -> str | None:
    token = _configurable(config).get("subject_token")
    return str(token) if token else None


def _user_id(config: Mapping[str, Any] | None) -> str:
    return str(_configurable(config).get("user_id") or "")


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

    return build_curator(extract=cfg.extract, search=search, details=details)


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

        async def web_search(query: str, year: int | None) -> dict[str, Any]:
            args: dict[str, Any] = {"query": query}
            if year is not None:
                args["year"] = year
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
    """Import node (014 US2): parse an uploaded spreadsheet → preview → HITL proposal batches.

    Fully code-orchestrated (no LLM in the node — the supervisor already classified `import`):
    parse via spreadsheet-mcp (token-free, by file handle), read collections + each targeted
    collection's movies via movie-mcp (downscoped token), build the pure ImportPreview, then the
    approval-gate Proposal batches. Sets pending_proposal/pending_batches so the SHARED gate
    previews + applies the writes (reusing the organizer's executor + idempotency). The file
    handle/filename ride config["configurable"] (BFF bridge), never the run body or checkpoint.
    """
    from langchain_core.messages import AIMessage

    from src.nodes.import_collection import (
        build_import_preview,
        build_import_proposals,
        resolve_tab_collection,
    )
    from src.tools.spreadsheet_tools import parse_spreadsheet, spreadsheet_server

    movie = McpServerConfig(
        name="movie-mcp", url=cfg.movie_mcp_url, needs_token=True, audience=cfg.audience
    )
    spreadsheet = spreadsheet_server(cfg.spreadsheet_mcp_url)

    async def import_collection(state: dict[str, Any], config: RunnableConfig | None = None) -> Any:
        configurable = _configurable(config)
        subject_token = _subject_token(config)
        user_id = _user_id(config)
        file_handle = str(configurable.get("file_handle") or "")
        filename = str(configurable.get("filename") or "upload.xlsx")
        thread_id = str(configurable.get("thread_id") or user_id or "import")
        acquire = _make_acquire(cfg, user_id)

        if not file_handle or not cfg.spreadsheet_mcp_url:
            return {"messages": [AIMessage(content="Please attach a spreadsheet file to import.")]}

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

        async def list_collections() -> list[dict[str, Any]]:
            out = await invoke_tool(
                agent="import_collection", tool_name="list_collections", arguments={},
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
                    agent="import_collection", tool_name="list_movies", arguments=args,
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
        existing_by_collection: dict[str, list[dict[str, Any]]] = {}
        for tab in tabs:
            if not tab.get("eligible"):
                continue
            target, _options = resolve_tab_collection(str(tab.get("name", "")), collections)
            if target is not None:
                cid = str(target["collectionId"])
                if cid not in existing_by_collection:
                    existing_by_collection[cid] = await list_movies(cid)

        preview = build_import_preview(
            tabs=tabs, collections=collections,
            existing_by_collection=existing_by_collection, thread_id=thread_id,
        )
        proposals = build_import_proposals(preview, thread_id)
        if not proposals:
            return {
                "messages": [
                    AIMessage(content="I didn't find any movies to import from that file.")
                ]
            }
        first, rest = proposals[0], proposals[1:]
        return {"pending_proposal": first, "pending_batches": rest, "status": "awaiting_approval"}

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
                "movies": await list_movies(str(c["collectionId"])),
            }
            for c in chosen
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
