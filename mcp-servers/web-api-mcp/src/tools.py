"""web-api-mcp tools — TMDB lookups via httpx (read-only).

Contract: specs/012-multi-agent-mvp/contracts/web-api-mcp-tools.md.
- search_title(query, year?) -> typed matchConfidence (exact | ambiguous | none); never fabricate.
- get_movie_details(source_id) -> EnrichedMovieCandidate shaped to the mc-service add-movie payload.
TMDB_API_KEY from the environment (Vault-injected in prod). Read-only; no idempotency key.
"""

# TODO(T022): implement search_title / get_movie_details against the TMDB REST API.
