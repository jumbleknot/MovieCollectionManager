# spreadsheet-mcp MCP server. Build context = repo root (-f mcp-servers/spreadsheet-mcp/Dockerfile).
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 /uv /usr/local/bin/uv
WORKDIR /app
COPY mcp-servers/spreadsheet-mcp/pyproject.toml mcp-servers/spreadsheet-mcp/uv.lock ./
RUN uv sync --frozen --no-dev
COPY mcp-servers/spreadsheet-mcp/src ./src

FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS runtime

# No pip at runtime (GHSA-6q48-6c7w-9gw2): the base's pip vendors a stale certifi that Trivy flags,
# and nothing here uses it — deps arrive as the uv-built /app/.venv. Rationale in full:
# agents/movie-assistant/Dockerfile.
RUN python -m pip uninstall --yes --root-user-action=ignore pip

# Non-root user (defense-in-depth; feature 034) — read-only .venv + source at runtime.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
CMD ["python", "-m", "src.server"]
