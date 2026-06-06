"""MCP tools: shared in-process MCP client + per-agent allowlists + write resilience.

Implements: T018 (per-agent allowlists — below), T024 (gateway-side RFC 8693 re-exchange
to aud=mc-service + OPA authz), T024a (write retry/backoff + dead-letter -> user-facing
failure). Curator -> read-only; organizer -> read + write; supervisor -> none.

The allowlist logic is PURE (no MCP/network) so it is unit-testable. The shared MCP
client + token re-exchange + write resilience (which import the `mcp` SDK and the
gateway runtime) are added lazily when the graph wiring (T020/T024) requires them.
"""

# Tool categories — names match contracts/movie-mcp-tools.md + web-api-mcp-tools.md.
_READ_TOOLS = frozenset(
    {"get_collection", "list_movies", "list_collections", "search_title", "get_movie_details"}
)
_WRITE_TOOLS = frozenset({"add_movie", "update_movie", "delete_movie", "create_collection"})

# Per-agent allowlists (least privilege, deny-by-default). Enforced by configuration.
_AGENT_ALLOWLISTS: dict[str, frozenset[str]] = {
    "supervisor": frozenset(),  # routes only — no domain tools
    "curator": _READ_TOOLS,  # discovery/enrichment — read-only
    "organizer": _READ_TOOLS | _WRITE_TOOLS,  # reorganization — reads + (HITL-gated) writes
}


def is_tool_allowed(agent: str, tool: str) -> bool:
    """Whether `agent` may call the MCP `tool`. Deny-by-default for unknown agent/tool."""
    return tool in _AGENT_ALLOWLISTS.get(agent, frozenset())
