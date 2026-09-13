# web-api-mcp MCP server. Build context = repo root (-f mcp-servers/web-api-mcp/Dockerfile).
# Outbound-only (TMDB); MUST NOT attach to backend-network (see compose.yaml).
FROM python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6 AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 /uv /usr/local/bin/uv
WORKDIR /app
COPY mcp-servers/web-api-mcp/pyproject.toml mcp-servers/web-api-mcp/uv.lock ./
RUN uv sync --frozen --no-dev
COPY mcp-servers/web-api-mcp/src ./src

FROM python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6 AS runtime

# SECURITY PATCH over UPSTREAM LAG — item #436, expedited under the SDD gate (that item is the record).
# The pinned base carries perl-base 5.40.1-6. Debian shipped 5.40.1-6+deb13u1 fixing three CRITICALs:
# CVE-2026-13221, CVE-2026-42496, CVE-2026-8376. Two of those were previously `fix_deferred` with NO
# fixed version — which is exactly why scripts/cd/scan-push.sh's `--ignore-unfixed` skipped them and
# names them in its own comment. The moment Debian published a fix they became BLOCKING and cd-deploy
# stopped at `scan-push` (run 3239, 2026-09-12). The image bytes never changed; Trivy's database did.
#
# NOT solvable by a digest refresh: python:3.14-slim was last rebuilt 2026-09-01 and still resolves to
# the digest above, still carrying 5.40.1-6. There is no newer base to move to.
#
# DELETE THIS BLOCK once the base ships perl-base >= 5.40.1-6+deb13u1. It is upstream lag, not a
# permanent layer. python-base-perl-patch.guard.test.mjs ties the requirement to the digest pinned
# above, so it stops demanding this automatically when Renovate moves the base.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade --no-install-recommends perl-base \
 && rm -rf /var/lib/apt/lists/*
# Non-root user (defense-in-depth; feature 034) — read-only .venv + source at runtime.
RUN groupadd --system app && useradd --system --gid app --no-create-home app
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH"
USER app
CMD ["python", "-m", "src.server"]
