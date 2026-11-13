# web-api-mcp MCP server. Build context = repo root (-f mcp-servers/web-api-mcp/Dockerfile).
# Outbound-only (TMDB); MUST NOT attach to backend-network (see compose.yaml).
FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 /uv /usr/local/bin/uv
WORKDIR /app
COPY mcp-servers/web-api-mcp/pyproject.toml mcp-servers/web-api-mcp/uv.lock ./
RUN uv sync --frozen --no-dev
COPY mcp-servers/web-api-mcp/src ./src

FROM python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS runtime

# No pip at runtime (GHSA-6q48-6c7w-9gw2): the base's pip vendors a stale certifi that Trivy flags,
# and nothing here uses it — deps arrive as the uv-built /app/.venv. Rationale in full:
# agents/movie-assistant/Dockerfile.
RUN python -m pip uninstall --yes --root-user-action=ignore pip

# Non-root user (defense-in-depth; feature 034). /app (.venv + source) is copied ROOT-owned, so the
# `app` user can read and run it but not modify it (item #604: the comment once claimed this while
# --chown=app:app made it writable). Nothing here writes to disk at runtime.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
CMD ["python", "-m", "src.server"]
