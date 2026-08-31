# web-api-mcp MCP server. Build context = repo root (-f mcp-servers/web-api-mcp/Dockerfile).
# Outbound-only (TMDB); MUST NOT attach to backend-network (see compose.yaml).
FROM python:3.13-slim@sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945 /uv /usr/local/bin/uv
WORKDIR /app
COPY mcp-servers/web-api-mcp/pyproject.toml mcp-servers/web-api-mcp/uv.lock ./
RUN uv sync --frozen --no-dev
COPY mcp-servers/web-api-mcp/src ./src

FROM python:3.13-slim@sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f AS runtime
# Non-root user (defense-in-depth; feature 034) — read-only .venv + source at runtime.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
CMD ["python", "-m", "src.server"]
