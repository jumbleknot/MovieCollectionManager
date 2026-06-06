# Agent Gateway (langgraph-api) image for the MCM conversational assistant.
# Build context is the repo root (constitution: build from root with -f).
# Multi-stage: install deps with uv, then run the langgraph-api server hosting the graph.
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY agents/movie-assistant/pyproject.toml agents/movie-assistant/uv.lock ./
RUN uv sync --frozen --no-dev
COPY agents/movie-assistant/src ./src
COPY agents/movie-assistant/langgraph.json ./

FROM python:3.13-slim AS runtime
WORKDIR /app
COPY --from=build /app /app
ENV PATH="/app/.venv/bin:$PATH"
# Private network only — no published port in container/prod compose (see compose.yaml).
EXPOSE 8000
# FastAPI app emitting AG-UI natively (ag-ui-langgraph). create_app() mounts the
# supervisor graph (T020). Served by uvicorn on the private network.
CMD ["uvicorn", "src.gateway:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
