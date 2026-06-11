# movie-mcp MCP server. Build context = repo root (-f mcp-servers/movie-mcp/Dockerfile).
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY mcp-servers/movie-mcp/pyproject.toml mcp-servers/movie-mcp/uv.lock ./
RUN uv sync --frozen --no-dev
COPY mcp-servers/movie-mcp/src ./src

FROM python:3.13-slim AS runtime
WORKDIR /app
COPY --from=build /app /app
ENV PATH="/app/.venv/bin:$PATH"
CMD ["python", "-m", "src.server"]
