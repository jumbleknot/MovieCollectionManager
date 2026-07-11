# web-api-mcp MCP server. Build context = repo root (-f mcp-servers/web-api-mcp/Dockerfile).
# Outbound-only (TMDB); MUST NOT attach to backend-network (see compose.yaml).
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY mcp-servers/web-api-mcp/pyproject.toml mcp-servers/web-api-mcp/uv.lock ./
RUN uv sync --frozen --no-dev
COPY mcp-servers/web-api-mcp/src ./src

FROM python:3.13-slim AS runtime
# Non-root user (defense-in-depth; feature 034) — read-only .venv + source at runtime.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
CMD ["python", "-m", "src.server"]
