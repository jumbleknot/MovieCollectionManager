"""web-api-mcp MCP server entrypoint.

Implements: T022. Registers the TMDB tools from tools.py. Outbound-only: no
internal-network access; egress to TMDB only. API key injected from Vault at runtime.
"""

# TODO(T022): construct the MCP server and register search_title / get_movie_details.
