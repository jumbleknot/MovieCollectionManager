# Agent Gateway (langgraph-api) image for the MCM conversational assistant.
# Build context is the repo root (constitution: build from root with -f).
# Multi-stage: install deps with uv, then run the langgraph-api server hosting the graph.
FROM python:3.13-slim@sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 /uv /usr/local/bin/uv
# A C/C++ toolchain is required: nemoguardrails pulls `annoy`, which has no cp313 wheel
# and compiles from source (needs g++). build-essential lives only in this build stage;
# the runtime stage gets just the compiled .venv.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY agents/movie-assistant/pyproject.toml agents/movie-assistant/uv.lock ./
RUN uv sync --frozen --no-dev
COPY agents/movie-assistant/src ./src
COPY agents/movie-assistant/langgraph.json ./

FROM python:3.13-slim@sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f AS runtime
# Non-root user (defense-in-depth; feature 034). The .venv on PATH and the source
# are read-only at runtime — uvicorn binds a port and reads code, no writable state.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
# Private network only — no published port in container/prod compose (see compose.yaml).
EXPOSE 8000

# Feature 055 (item #179) — a process that is RUNNING is not a process that is SERVING.
#
# MEASURED three times on 2026-08-12: this gateway wedged at 100% CPU on one core with memory at 1%,
# /health timing out and its log 40 minutes stale, while `docker inspect` reported
# `status=running OOMKilled=false ExitCode=0 RestartCount=0`. `restart: always` is set on the service
# and is irrelevant to that — the process never exits, so Docker never sees a failure to restart from.
# With no healthcheck, `docker ps` printed a bare `Up` throughout, and two full E2E suites were
# measured against the dead process before anything noticed.
#
# In the DOCKERFILE rather than in compose, deliberately: the local stack is started by
# `scripts/agent-stack.mjs` with `docker run`, and prod composes the same image. A compose-only
# healthcheck would have covered neither of the two places this actually wedged.
#
# `python -c` rather than curl/wget: this is a slim image and has neither. Adding a package to run a
# probe would grow the runtime image and its CVE surface for a health check.
#
# 30s/3 retries detects a wedge inside ~90s — far inside the ~7-minute suite it needs to catch —
# while staying cheap enough not to become the perturbation it is measuring on a single-threaded
# event loop under load.
#
# It does NOT recover the container, and that is the point: a wedged gateway must stay wedged and
# visible. Docker does not restart a merely-unhealthy container, so `unhealthy` is a report, not a
# remedy. Silently restarting it would erase both the evidence and the incidence rate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]
# FastAPI app emitting AG-UI natively (ag-ui-langgraph). create_app() mounts the
# supervisor graph (T020). Served by uvicorn on the private network.
CMD ["uvicorn", "src.gateway:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
