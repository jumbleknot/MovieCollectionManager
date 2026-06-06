"""movie-mcp tools — thin wrappers over mc-service REST (no domain logic).

Contract: specs/012-multi-agent-mvp/contracts/movie-mcp-tools.md.
Reads (T021): get_collection, list_movies, list_collections.
Writes (T043: add_movie, create_collection; T051: update_movie, delete_movie) — carry
an idempotency key, executed only on the approved-resume path. Every call forwards the
gateway-exchanged downscoped (aud=mc-service) JWT; mc-service enforces RBAC + DAC
unchanged (unauthorized -> 404, mirroring the direct API).
"""

# TODO(T021/T043/T051): implement the typed tool functions against /api/v1/...
