# movie-mcp MCP server. Build context = repo root (-f mcp-servers/movie-mcp/Dockerfile).
FROM python:3.13-slim@sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.9@sha256:8b940d3a9d65bed080436972241af2e21c84b5e8c9193f7014ed71479ee795ff /uv /usr/local/bin/uv
WORKDIR /app
COPY mcp-servers/movie-mcp/pyproject.toml mcp-servers/movie-mcp/uv.lock ./
RUN uv sync --frozen --no-dev
COPY mcp-servers/movie-mcp/src ./src

FROM python:3.13-slim@sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f AS runtime
# Non-root user (defense-in-depth; feature 034) — read-only .venv + source at runtime.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
CMD ["python", "-m", "src.server"]
