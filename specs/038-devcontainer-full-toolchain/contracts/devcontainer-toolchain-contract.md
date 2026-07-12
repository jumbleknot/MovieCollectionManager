# Contract: Dev-Container Full-Toolchain + Personal-Layer

**Feature**: 038-devcontainer-full-toolchain | **Date**: 2026-07-12

Three contracts: (A) the committed config the runner consumes, (B) the CI image-publish job, (C) the verification commands. Extends the 037 `devcontainer-contract.md` — 037's clauses still hold; this adds the toolchain, caches, personal seam, and image-publish.

---

## A. Committed configuration contract

The `.devcontainer/` definition MUST resolve unmodified under **both** the VS Code Dev Containers extension and headless `@devcontainers/cli` (inherited 037 US5).

### A1. `devcontainer.json` (delta from 037)

```jsonc
{
  "name": "mcm-workspace",
  "build": {
    "dockerfile": "Dockerfile",
    // Host-free image pin: top-level `image` is NOT substitution-eligible; build.args IS.
    // Default = a locally-built tag so a bare `devcontainer up` (no env) still resolves.
    "args": { "BASE_IMAGE": "${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer:local}" }
  },
  "features": { "ghcr.io/devcontainers/features/docker-in-docker:2": { "moby": true } },
  "remoteUser": "coder",
  "mounts": [
    "source=mcm-commandhistory,target=/commandhistory,type=volume",
    "source=mcm-cargo-registry,target=/home/coder/.cargo/registry,type=volume",
    "source=mcm-cargo-git,target=/home/coder/.cargo/git,type=volume",
    "source=mcm-rustup,target=/home/coder/.rustup,type=volume",
    "source=mcm-uv-cache,target=/home/coder/.cache/uv,type=volume",
    "source=mcm-pnpm-store,target=/home/coder/.local/share/pnpm/store,type=volume",
    "source=mcm-claude,target=/home/coder/.claude,type=volume"
  ],
  "containerEnv": { "MCM_DEVCONTAINER": "1", "DOCKER_CONFIG": "/home/coder/.docker-dind" },
  "postCreateCommand": "pnpm install --config.confirmModulesPurge=false",
  "postStartCommand": "sudo /bin/bash ${containerWorkspaceFolder}/.devcontainer/init-firewall.sh"
  // workspaceFolder / workspaceMount intentionally OMITTED (037 gotcha — let the runner default them).
}
```

**Invariants**:
- MUST NOT contain the forge host literal (topology-scrub) — only `${localEnv:MCM_DEVCONTAINER_IMAGE:…}`.
- MUST NOT contain any `dotfiles.*` key (personal; lives in the user's VS Code settings, not here — FR-009).
- MUST NOT hardcode `workspaceFolder`/`workspaceMount` (037 exit-127 gotcha).
- MUST NOT contain any credential (FR-010).

### A2. Thin `Dockerfile` (the substitution seam)

```dockerfile
ARG BASE_IMAGE=mcm-devcontainer:local
FROM ${BASE_IMAGE}
# Intentionally minimal: its ONLY job is to let devcontainer.json parametrize the base image
# via build.args (top-level `image` cannot be substituted). All real setup is in toolchain.Dockerfile.
```

### A3. `toolchain.Dockerfile` (the heavy, build-once image)

- `FROM node:24-bookworm`; inherits 037's apt deps + watchman + `coder` user + DinD-config dir + Claude Code CLI.
- Installs (slow→fast layers): rustup stable + rust-analyzer + the cargo utilities (D4); `uv` + Specify CLI; `gh`.
- Sets `CARGO_HOME`, `RUSTUP_HOME`, `UV_CACHE_DIR`, pnpm `store-dir`; **pre-creates + `chown coder:coder`** each cache-dir target (copy-up ownership, D3).
- **Invariant**: 0 secrets; 0 personal tools (RTK/plugins live in the dotfiles layer, not here).

### A4. `init-firewall.sh` (delta)

- `ALLOWED_DOMAINS` += crates.io / static.crates.io / index.crates.io, pypi.org / files.pythonhosted.org, astral.sh, api.expo.dev / exp.host.
- All other 037 clauses unchanged (flush only INPUT/OUTPUT, never `-X`/`-F FORWARD`; reset policy to ACCEPT at top; `FORGE_REGISTRY_HOST` env-injected; re-runnable).

## B. CI image-publish contract (`.forgejo/workflows/devcontainer-image.yml`)

- **Trigger**: `workflow_dispatch` + a change-triggered run (push touching `.devcontainer/toolchain.Dockerfile` / pinned versions) + optional weekly schedule (FR-013).
- **Runner**: `kvm` (Docker image build + registry push — same as `cd-deploy`).
- **Steps**: `docker build -f .devcontainer/toolchain.Dockerfile -t ${REGISTRY}/${NS}/mcm-devcontainer:<tag> .` → push → capture `@sha256:` digest → surface the digest (job summary / artifact) for the developer to set `MCM_DEVCONTAINER_IMAGE`.
- **Secrets/vars**: host-free `REGISTRY`/`NS`/`REGISTRY_USER` Forgejo vars + registry push secret (same store as app images). No git literal of the forge host.
- **Invariant**: the published image contains the full team toolchain and 0 credentials/personal tools; it is disjoint from the 6 `jumbleknot/*` app images (naming: `mcm-devcontainer`).

## C. Verification-command contract

Each command asserts one SC. Run headless via `devcontainer exec <id> bash .devcontainer/verify/<script>.sh` and from the in-container terminal. Exit 0 = pass.

| Script | Asserts | Success condition |
|---|---|---|
| `verify-toolchain-present.sh` | SC-001, SC-002 | `rustc cargo rustfmt clippy rust-analyzer cargo-audit cargo-deny uv uvx specify pnpm gh` (+ `pnpm nx --version`) all resolve + print a version; 0 "command not found". |
| `verify-caches-persist.sh` | SC-005 | After a recreate, a dependency install reports cache hits / 0 full re-downloads (cargo/pnpm/uv), asserted against the mounted volumes. |
| `verify-firewall-allowlist.sh` | SC-009 | `curl`/fetch to crates.io + pypi.org + api.expo.dev succeed; a fetch to an arbitrary non-allowlisted host times out / is refused. |
| `verify-personal-layer.sh` | SC-006, SC-007 | `rtk gain` shows > 80% compression on the standard command set (RTK resolved from the persisted `~/.claude/tools/bin`); the expected plugin/skill set is listed present; logins resolve without a re-auth prompt; after a recreate, 0 reinstall / 0 re-login. **Skips cleanly (exit 0 + notice) when the personal layer is absent** (FR-014). |
| `verify-committed-clean.sh` | SC-010 | `.devcontainer/` holds no `dotfiles.*`/`rtk`/personal-plugin list, no credential, and no forge host literal (`MCM_DEVCONTAINER_IMAGE` only as `${localEnv:…}`); wraps `secret-scan.mjs` + `check-topology-scrub.mjs`. |
| `verify-host-isolation.sh` (037) | SC-008 | Unchanged — host FS/creds/SSH unreachable; `MCM_DEVCONTAINER=1`. |
| `verify-engine-isolation.sh` (037) | SC-008 | Unchanged — in-container `docker run` absent from host engine. |

**TDD (RED→GREEN)**: the four new scripts fail RED before the toolchain/caches/firewall/personal-layer land (e.g. `verify-toolchain-present.sh` reports missing `rustc`), and pass GREEN after. `verify-personal-layer.sh`'s absent-layer skip path is exercised separately from its present-layer assertions.
