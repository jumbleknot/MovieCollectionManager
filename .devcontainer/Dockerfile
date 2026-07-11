# .devcontainer/Dockerfile — feature 037 (containerized dev-env)
#
# Governing requirements:
#   FR-009 / G3  base node:20-bookworm (prod BFF runtime lineage — dev/deploy parity)
#   FR-002       non-root workspace user `coder` with no host reach
#   US3          watchman → fast Metro file-watch (research D5)
#   research D4  iptables/ipset/dnsutils are consumed by init-firewall.sh (added in US1/T009,
#                but the packages are provisioned here so the base image carries them)
#   research D3  NO Docker install here — the docker-in-docker feature (US2/T013) provides it
#   FR-010       no secrets are baked into the image
#
# This image is intentionally minimal: the DinD engine, Claude Code CLI, and the egress
# firewall are layered on by the devcontainer feature + lifecycle hooks, not baked here.

FROM node:20-bookworm

# Base toolchain + firewall/network deps.
# iptables/ipset/dnsutils/iproute2 are used by init-firewall.sh (US1); jq is used by the
# verify scripts and firewall allowlist parsing.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        git \
        build-essential \
        curl \
        ca-certificates \
        unzip \
        sudo \
        iptables \
        ipset \
        dnsutils \
        iproute2 \
        jq \
    && rm -rf /var/lib/apt/lists/*

# watchman is NOT packaged in Debian apt — install Meta's official prebuilt release.
# This runs at image-build time (before the runtime egress firewall exists), so the GitHub
# download is unaffected by init-firewall.sh. Bump WATCHMAN_VERSION if the pinned asset 404s.
ARG WATCHMAN_VERSION=v2024.01.22.00
RUN cd /tmp \
    && curl -fsSL -o watchman.zip \
        "https://github.com/facebook/watchman/releases/download/${WATCHMAN_VERSION}/watchman-${WATCHMAN_VERSION}-linux.zip" \
    && unzip -q watchman.zip \
    && cd "watchman-${WATCHMAN_VERSION}-linux" \
    && mkdir -p /usr/local/bin /usr/local/lib /usr/local/var/run/watchman \
    && cp bin/* /usr/local/bin/ \
    && cp lib/* /usr/local/lib/ \
    && chmod 755 /usr/local/bin/watchman \
    && chmod 2777 /usr/local/var/run/watchman \
    && cd / && rm -rf /tmp/watchman.zip "/tmp/watchman-${WATCHMAN_VERSION}-linux"

# Root-level Node toolchain setup: corepack shims + Claude Code CLI both symlink into the
# root-owned /usr/local prefix, so they MUST be installed here (as root) — running them from the
# non-root `coder` user in postCreateCommand fails EACCES. Baking them also speeds warm start.
# Claude Code is a tool, not a secret (FR-010 still holds). The pnpm VERSION is resolved at
# runtime from package.json's packageManager field on first `pnpm` call.
RUN corepack enable \
    && npm install -g @anthropic-ai/claude-code

# Non-root workspace user (FR-002). node:20-bookworm ships uid 1000 as `node`; create
# `coder` alongside it (uid 1001) with passwordless sudo for in-container admin (firewall,
# apt) without ever granting host privilege.
ARG USERNAME=coder
RUN useradd --create-home --shell /bin/bash "${USERNAME}" \
    && echo "${USERNAME} ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}" \
    # Persistent shell history dir (bind-mounted to a named volume in devcontainer.json).
    && mkdir -p /commandhistory \
    && chown "${USERNAME}:${USERNAME}" /commandhistory

USER ${USERNAME}
WORKDIR /home/${USERNAME}
ENV SHELL=/bin/bash
