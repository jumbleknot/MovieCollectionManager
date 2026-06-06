"""movie-mcp MCP server entrypoint.

Implements: T021 (read tools), T043/T051 (write tools). Registers the tools from
tools.py and serves MCP over the gateway's shared in-process client connection.
Attaches to backend-network (must reach mc-service).
"""

# TODO(T021): construct the MCP server, register read tools; T043/T051 add write tools.
