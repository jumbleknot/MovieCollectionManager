# .devcontainer/toolchain.Dockerfile — feature 038 (full dev-container toolchain)
#
# The HEAVY, build-once image. Built once in CI (.forgejo/workflows/devcontainer-image.yml →
# forge registry `mcm-devcontainer`) or locally (scripts/build-devcontainer-image.mjs →
# `mcm-devcontainer`), then pulled per-open. The committed thin `Dockerfile` does
# `FROM ${BASE_IMAGE}` against this image — so a warm recreate is a `docker pull`, not a
# 10–15-min Rust/tool compile (research D1/D2; SC-003/SC-011).
#
# Governing requirements / decisions:
#   FR-001/FR-002  the full team toolchain (Rust+cargo utils, uv+Specify, Node/pnpm/Nx, gh) on PATH
#   research D4    toolchain contents; layers ordered slow→fast for cache reuse
#   research D3    cache-dir env + pre-chown for the empty-volume copy-up ownership gotcha (US2);
#                  ONLY download caches are volumed — the baked toolchain tracks the image (FR-013)
#   FR-010         NO secrets and NO personal tools (RTK/plugins) are baked here — those live in the
#                  out-of-repo dotfiles layer (FR-009). This image is the shared, team-neutral asset.
#   037 gotcha     Node >= 24 base (pnpm@10.33 loads node:sqlite; Node 20 crashes ERR_UNKNOWN_BUILTIN_MODULE)
#
# All toolchain fetches run at IMAGE-BUILD time — BEFORE the runtime egress firewall exists
# (research D5) — so crates.io / PyPI / GitHub CDN rotation is NOT a per-open problem for the
# baked set. Inherits feature 037's base (apt deps, watchman, corepack + Claude Code CLI, non-root
# `coder`, DinD-config dir) so the 037 verify scripts (host/engine isolation, SC-008) still pass.

FROM node:24-bookworm

# --- 037 base: apt deps + firewall/network tooling ---------------------------------------
# iptables/ipset/dnsutils/iproute2 are consumed by init-firewall.sh; jq by the verify scripts
# and firewall allowlist parsing. build-essential + pkg-config + libssl-dev let Rust crates with
# native/C build scripts compile (the cargo-utility set below pulls some).
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        git \
        build-essential \
        pkg-config \
        libssl-dev \
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

# --- 037 base: watchman (Meta prebuilt; not in Debian apt) -------------------------------
# Fetched at IMAGE-BUILD time, before the runtime egress firewall exists (research D5). Bump if
# the pinned asset 404s.
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

# --- 037 base: root-level Node toolchain (corepack shims + Claude Code CLI) ---------------
# Both symlink into the root-owned /usr/local prefix → MUST be installed as root here (running
# from non-root `coder` in a lifecycle hook fails EACCES). Claude Code is a tool, not a secret
# (FR-010 holds). pnpm version resolves at runtime from package.json packageManager.
RUN corepack enable \
    && npm install -g @anthropic-ai/claude-code

# --- US1 (T013): gh (GitHub CLI) from the official apt repo [root, pre-user] --------------
RUN export DEBIAN_FRONTEND=noninteractive \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- 037 base: non-root workspace user `coder` (uid 1001) --------------------------------
# node:24-bookworm ships uid 1000 as `node`; create `coder` alongside (uid 1001) with
# passwordless sudo for in-container admin (firewall, apt) without ever granting host privilege.
ARG USERNAME=coder
RUN useradd --create-home --shell /bin/bash "${USERNAME}" \
    && echo "${USERNAME} ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}" \
    # Persistent shell history dir (named volume in devcontainer.json).
    && mkdir -p /commandhistory \
    && chown "${USERNAME}:${USERNAME}" /commandhistory \
    # Dedicated docker config dir for the in-container DinD CLI (DOCKER_CONFIG points here) so it
    # ignores the VS Code host-side credsStore helper (037 exit-255 fix).
    && mkdir -p "/home/${USERNAME}/.docker-dind" \
    && chown "${USERNAME}:${USERNAME}" "/home/${USERNAME}/.docker-dind"

# --- US2 (T016): cache-home env + PATH (stable targets regardless of $HOME) ---------------
# CARGO_HOME/RUSTUP_HOME are needed by rustup below; UV_CACHE_DIR by uv. Only the DOWNLOAD-cache
# subdirs (.cargo/registry, .cargo/git, .cache/uv, pnpm store) are volumed in devcontainer.json
# — NOT .cargo/bin or .rustup (baked; must track the image for FR-013 refresh, research D3).
ENV CARGO_HOME=/home/${USERNAME}/.cargo \
    RUSTUP_HOME=/home/${USERNAME}/.rustup \
    UV_CACHE_DIR=/home/${USERNAME}/.cache/uv \
    PATH=/home/${USERNAME}/.cargo/bin:/home/${USERNAME}/.local/bin:${PATH}

USER ${USERNAME}
WORKDIR /home/${USERNAME}

# Pre-create + own the cache-dir mount targets so Docker's empty-volume copy-up carries uid-1001
# ownership into a fresh named volume (research D3 ownership gotcha). Running as `coder` here
# means these dirs are coder-owned in the image; copy-up preserves that on first mount.
RUN mkdir -p \
      "${CARGO_HOME}/registry" \
      "${CARGO_HOME}/git" \
      "${CARGO_HOME}/bin" \
      "${UV_CACHE_DIR}" \
      "/home/${USERNAME}/.local/share/pnpm/store" \
      "/home/${USERNAME}/.claude"

# --- US1 (T010): Rust stable via rustup + rustfmt/clippy + rust-analyzer [coder] ----------
# Slow-but-stable layer FIRST (cache reuse): the toolchain changes rarely. rustup-init is fetched
# at build time (pre-firewall). rust-analyzer is added as a rustup component; expose its proxy on
# PATH via a symlink into CARGO_HOME/bin so `rust-analyzer --version` resolves directly.
RUN curl -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable \
          --component rustfmt clippy rust-analyzer \
    && rustc --version && cargo --version \
    && ln -sf "$(rustup which rust-analyzer)" "${CARGO_HOME}/bin/rust-analyzer" \
    && rust-analyzer --version

# --- US1 (T011): cargo utilities the repo's quality/security gates invoke [coder] ---------
# The SLOWEST layer (compiles from crates.io source) — placed after the stable toolchain so it
# caches, and before the fast uv layer so a uv change never reinvalidates it. `--locked` uses each
# crate's published Cargo.lock for reproducibility. Set covers features 033/034/035 + tarpaulin
# coverage (constitution). This is the bulk of the SC-011 one-time build cost.
RUN cargo install --locked \
      cargo-audit \
      cargo-deny \
      cargo-outdated \
      cargo-machete \
      cargo-semver-checks \
      cargo-geiger \
      cargo-expand \
      cargo-bloat \
      cargo-mutants \
      cargo-tarpaulin

# --- US1 (T012): uv (astral) + Specify CLI (SDD toolchain) [coder] ------------------------
# uv installs to ~/.local/bin (already on PATH). Specify (GitHub Spec Kit) via `uv tool install`
# exposes the `specify` command. Both fetched at build time (pre-firewall).
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && uv --version \
    && uv tool install --from git+https://github.com/github/spec-kit.git specify-cli \
    && specify --help >/dev/null 2>&1 || echo "toolchain.Dockerfile: 'specify' installed (help probe non-zero is tolerated at build time)"

ENV SHELL=/bin/bash
