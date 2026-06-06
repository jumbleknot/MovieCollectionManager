"""Curator node: discover + enrich movie metadata; propose additions.

Implements: T039. Tool allowlist: web-api-mcp (read-only) + movie-mcp reads.
Builds EnrichedMovieCandidate previews and emits render_movie_card; never writes.
"""

# TODO(T039): enrich via web-api-mcp, assemble candidate + proposal, render inline.
