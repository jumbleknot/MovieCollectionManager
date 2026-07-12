# PRD: Containerized Dev Environments on the Windows Workstation

**Author:** Steve
**Date:** 2026-07-08
**Status:** Revised — superseded by spec [`specs/037-containerized-dev-env/`](../../specs/037-containerized-dev-env/)
**Scope:** Local (workstation-only) adoption of spec-conformant dev containers for AI-assisted development.

---

> **Revision note (2026-07-11, feature 037).** This PRD was written around DevPod as the
> foundation and claimed the environment runs without elevated privileges. Both were revised:
>
> 1. **The portable asset is the spec-conformant `.devcontainer/` directory**, run by the **VS
>    Code Dev Containers** extension (daily driver) and the reference **`@devcontainers/cli`**
>    (headless / portability proof) — **not** DevPod. DevPod remains an optional, config-compatible
>    convenience but is **deprecated as the foundation** given its uncertain maintenance
>    ([loft-sh/devpod#1915](https://github.com/loft-sh/devpod/issues/1915)). See §14.
> 2. **Honest security posture.** In-container Docker (docker-in-docker) requires the container to
>    run **`privileged`**, so container-**engine** isolation is only *moderate*; host-filesystem /
>    credential / SSH isolation remains *strong*. Every claim that the environment needs no
>    elevated privileges has been removed. A **default-deny egress firewall** was added as a new
>    isolation layer.
>
> Where this document and the spec disagree, the spec wins.

## 1. Summary

Adopt **spec-conformant dev containers** on the Windows 11 workstation to run per-project, containerized development environments defined as code (`devcontainer.json`). Each environment is a disposable Debian container running on the local Docker Desktop engine, entered via VS Code (Dev Containers extension), with Claude Code executing **inside** the container. The reference `@devcontainers/cli` provides a headless runner and the portability proof.

The primary goal is **blast-radius isolation for AI-assisted development**: agent-run commands, dependency installs, and test containers are sealed inside a throwaway container rather than touching the Windows host, while secondary goals (reproducibility, Linux/prod parity, parallel toolchains) come along for free. A **default-deny egress firewall** further shrinks the network blast radius.

This PRD deliberately **excludes** remote access, always-on availability, and multi-user features, which are not requirements. The portable asset is the open dev-container standard itself — not any single vendor tool — which is why the foundation is plain Dev Containers rather than a bespoke platform (see §14).

---

## 2. Background & Current State

Current AI-assisted SDLC:

- **Workstation:** Windows 11, VS Code, Claude Code + Claude Code VS Code extension, WSL2, Docker Desktop.
- **Homelab:** Ubuntu server, two rootless Docker daemons — one for Forgejo + CI (Forgejo Actions), one for CD (Komodo) + Prod.
- **Deployment:** All apps deploy as Docker containers. Much dev/testing is local, including Metro for universal Expo apps.

Today, development happens directly on the Windows host (or raw WSL). Claude Code runs with access to the host filesystem, credentials, and Docker Desktop engine. There is no isolation boundary between agent-run commands and the host, and no per-project reproducibility beyond WSL's single shared mutable environment.

---

## 3. Problem Statement

Running an AI coding agent directly on the host couples the agent's blast radius to the workstation. An errant command, a malicious dependency, or an untrusted test container can reach host files, SSH keys, and the Docker Desktop engine. Separately, the single shared WSL environment makes per-project toolchain isolation and clean teardown awkward, and Windows-native quirks (paths, line endings) leak into development.

We want a per-project, disposable, Linux-consistent environment — defined as code and mirroring prod — inside which the agent operates, without standing up a full remote workspace platform.

---

## 4. Goals & Non-Goals

### Goals

- **G1 — Isolation (honest posture):** Claude Code and all agent-run shell commands execute inside a container with **strong** isolation of the Windows host filesystem, credentials, and SSH keys (no host profile, no host `~/.ssh`, no host credential store, no host Docker socket). Container-**engine** isolation is only **moderate**: in-container Docker requires the container to run `privileged`, so a privileged escape can reach the shared Docker Desktop WSL2 virtualization layer and thus the host engine. A default-deny egress firewall reduces the network blast radius on top of this. We do **not** claim the environment runs without elevated privileges.
- **G2 — Reproducibility:** Each project's environment is defined in `devcontainer.json` + `Dockerfile`, versioned in the repo, and rebuildable from scratch in minutes.
- **G3 — Prod parity:** Workspace base image shares lineage with the images deployed via Komodo, reducing "works on my machine" drift.
- **G4 — Linux consistency:** Development occurs in Ubuntu, eliminating Windows path/line-ending papercuts.
- **G5 — Parallel toolchains:** Multiple projects with differing Node/Python versions coexist without host-level version managers.
- **G6 — Low operational overhead:** No control-plane server to run, secure, or upgrade. Management is CLI + VS Code only.

### Non-Goals

- **NG1:** Remote access from other machines. (Not required.)
- **NG2:** Always-on / persistent-uptime workspaces. Environment need only exist when the workstation is on.
- **NG3:** Multi-user, RBAC, self-service dashboards.
- **NG4:** Running iOS Simulator / Android emulator inside the container (not feasible headless; see §8).
- **NG5:** Migrating CI/CD. Forgejo Actions and Komodo are unchanged.

---

## 5. Users

Single user (Steve), acting as both developer and operator, on one Windows 11 workstation.

---

## 6. Requirements

### Functional

- **FR1:** `devpod up` on a repo builds/starts the container and opens it in VS Code with the integrated terminal inside the container.
- **FR2:** Claude Code runs inside the container (CLI available on `PATH`; VS Code extension attaches to the container's remote).
- **FR3:** Project source lives on the container's Linux filesystem (DevPod-managed volume), **not** a Windows NTFS bind mount, to preserve fast file watching (watchman/Metro).
- **FR4:** The container can build images and run test containers (for integration tests / compose stacks) via an **isolated inner Docker engine** (Docker-in-Docker), not the host socket — see §9.
- **FR5:** Metro/Expo dev-server ports are forwarded to the host so a physical device or browser can reach them (see §8).
- **FR6:** `devpod delete` fully tears down the environment; `devpod up` recreates it deterministically.
- **FR7:** Environment definition is committed to each repo so it travels with the code.

### Non-Functional

- **NFR1 — Startup:** Warm start (existing container) < 15s; cold build < 5 min on the workstation.
- **NFR2 — File-watch latency:** Hot reload parity with native WSL dev (achieved via FR3).
- **NFR3 — Footprint:** Idle container overhead small enough to run 1–2 concurrently alongside VS Code without exhausting workstation RAM.
- **NFR4 — Portability:** The same `devcontainer.json` must run unmodified against a different DevPod provider later (e.g., the homelab) without rewrites — preserving a future migration path.
- **NFR5 — No new always-on services** on the workstation beyond Docker Desktop (already present).

---

## 7. Proposed Architecture

```
Windows 11 Workstation
├── VS Code (host)  ──Remote──►  Dev Container   (Dev Containers extension)
├── Claude Code VS Code ext ───►  (runs inside container)
├── @devcontainers/cli (host) ──headless runner + portability proof──►
└── Docker Desktop (engine in WSL2)   [Enhanced Container Isolation OFF — incompatible with DinD]
        └── Dev Container (Debian bookworm, PRIVILEGED for DinD)
              ├── Project source (Docker named volume, Linux FS)
              ├── Node 20 / pnpm / watchman toolchain
              ├── Claude Code CLI
              ├── init-firewall.sh  ← default-deny egress + allowlist
              └── Inner Docker engine (DinD)  ← test/build containers
```

Key decisions:

- **Runner:** the **VS Code Dev Containers extension** (daily driver) + the reference **`@devcontainers/cli`** (headless / portability). No extra control plane, no vendor lock (§14).
- **Source location:** the repo lives on a Docker **named volume** (Linux FS), never an NTFS bind mount — satisfies FR3/NFR2.
- **Docker access:** the docker-in-docker feature gives the container its own inner engine, so in-container test containers do not appear on the host engine — satisfies FR4. **This forces the container to run `privileged`**, which is why engine isolation is only *moderate* (a privileged escape can reach the host VM/engine). Mounting the host Docker socket is explicitly rejected — it hands the container full control of the host engine, defeating the isolation goal.
- **Egress control:** `init-firewall.sh` applies default-deny outbound with an allowlist (Anthropic API, GitHub, npm, the image registries DinD pulls from) — a network isolation layer the original PRD lacked.
- **Agent placement:** Claude Code runs in the container's shell so its blast radius equals the container (plus the firewall) — satisfies G1/FR2.

---

## 8. Expo / Mobile Workflow (Known Constraint)

Containerized environments are a poor fit for **native** mobile work; this is called out so expectations are set, not solved away:

- **No simulators/emulators in-container.** iOS Simulator (macOS-only) and Android emulator (needs KVM/GPU) do not run in a headless Linux container. Native device/simulator testing stays a host-side activity.
- **Metro over the network.** With Metro running in the container, the phone reaches it via forwarded ports on the workstation's LAN address, or via Expo **tunnel** (slower, ngrok-based) when LAN routing is inconvenient.

**Split of responsibilities:**

| Target | Where it runs |
|---|---|
| Backend / API / services | Container ✅ |
| Expo **web** target | Container ✅ |
| Metro bundler (JS) | Container ✅ (ports forwarded) |
| Native iOS/Android build, simulator, device debug | Host / native tooling ⚠️ |

Forward these ports (FR5), verified against this Expo SDK 56 codebase: `8081` (Metro / Expo Web / dev BFF), `8082` (containerized dev BFF), `8099` (Keycloak OAuth). The legacy `19000`/`19001`/`19006` Expo ports are **unused** by this project — do not forward them.

---

## 9. Implementation

### 9.1 Install the runners (workstation, one-time)

1. Install the **VS Code Dev Containers** extension (`ms-vscode-remote.remote-containers`) — the daily driver.
2. Install the headless / portability runner:
   ```powershell
   npm install -g @devcontainers/cli
   ```
3. In Docker Desktop, keep **Enhanced Container Isolation OFF** (incompatible with the docker-in-docker feature).

> The committed `.devcontainer/` is the real, canonical implementation (feature 037). The snippets
> below are illustrative; see [`.devcontainer/`](../../.devcontainer/) for the authoritative files.

### 9.2 `.devcontainer/devcontainer.json` (commit to each repo)

```jsonc
{
  "name": "expo-universal-dev",
  "build": { "dockerfile": "Dockerfile" },

  // Inner Docker engine for building images / running test containers. NOT the host socket.
  // NOTE: enabling this feature forces the container to run `privileged` (moderate engine
  // isolation — a privileged escape can reach the host VM/engine). Stated honestly, not hidden.
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {
      "moby": true,
      "version": "latest"
    }
  },

  // This project's REAL ports (Expo SDK 56). NOT the legacy 19000/19001/19006 (unused).
  "forwardPorts": [8081, 8082, 8099],
  "portsAttributes": {
    "8081": { "label": "Metro / Expo Web / dev BFF" },
    "8082": { "label": "Containerized dev BFF" },
    "8099": { "label": "Keycloak (OAuth)" }
  },

  "customizations": {
    "vscode": {
      "extensions": [
        "anthropic.claude-code",
        "dbaeumer.vscode-eslint",
        "esbenp.prettier-vscode"
      ],
      "settings": {
        "files.eol": "\n"
      }
    }
  },

  // Workspace deps only; corepack + Claude Code CLI are baked into the image (root-level).
  "postCreateCommand": "pnpm install",

  // Egress firewall applied on every start (root, then drops to coder).
  "postStartCommand": "sudo /bin/bash ${containerWorkspaceFolder}/.devcontainer/init-firewall.sh",

  "remoteUser": "coder"
}
```

### 9.3 `.devcontainer/Dockerfile`

Base this on the **same image lineage as your prod images** (G3) once that base is settled; the example below uses a clean Node/Ubuntu base with the tooling Expo/Metro needs.

```dockerfile
# Dev toolchain Node (24) — the repo's pinned pnpm@10.33 loads node:sqlite at startup, which
# needs Node >= 22/24; Node 20 crashes. Prod BFF still deploys on node:20 (parity checked in CI).
FROM node:24-bookworm

# Tooling: git, watchman (fast file watching for Metro), build essentials.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      watchman \
      build-essential \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root workspace user. The Docker CLI + inner engine come from the docker-in-docker
# feature (no host socket mount). That feature runs the CONTAINER privileged — the `coder`
# user is non-root, but the container itself runs privileged; see §10.
RUN useradd -m -s /bin/bash coder \
    && echo "coder ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/coder

USER coder
WORKDIR /home/coder
```

> Note: the Docker CLI and inner engine come from the `docker-in-docker` feature — do **not** install Docker manually or mount `/var/run/docker.sock`.

### 9.4 Daily use

Daily driver: VS Code → **Dev Containers: Clone Repository in Named Container Volume** (first
time) / **Reopen in Container** (thereafter). Headless / portability:

```bash
devcontainer up --workspace-folder .      # build + start
# ... work in VS Code; Claude Code runs in the in-container terminal ...
devcontainer down --workspace-folder .    # stop (retains the named volume = source of truth)
# Full teardown: also remove the named volume via Docker.
```

Full daily-use guidance is in [docs/runbooks/devcontainer.md](../runbooks/devcontainer.md).

---

## 10. Security Considerations

**Honest posture — two isolation strengths, do not conflate them:**

- **Host-FS / credential / SSH isolation (STRONG, the primary control):** Claude Code runs as the
  **non-root** `coder` user inside the container; it has no path to the Windows host FS, no host
  SSH keys, no host credential store, and no host Docker socket. This is the reason the feature
  exists and it holds fully.
- **Container-engine isolation (MODERATE):** the docker-in-docker feature runs the **container
  `privileged`**. A privileged-container escape can reach the shared Docker Desktop WSL2
  virtualization layer and therefore the host engine. **This environment runs with elevated
  privileges; we do not claim otherwise.** Mounting the host Docker socket is still rejected (it
  would be strictly worse — direct host-engine control).
- **Network egress (default-DENY + allowlist):** `init-firewall.sh` drops all outbound except
  DNS, the host/bridge subnet, and an allowlist (Anthropic API, GitHub, npm, the registries DinD
  pulls from). A compromised dependency cannot exfiltrate to an arbitrary destination.
- **Secrets:** injected per-project via container env / the runner's secret mechanism, never baked
  into the image or committed; the Windows user profile is never mounted.
- **Path to stronger engine isolation (out of scope):** a rootless nested engine (e.g. Sysbox)
  would raise engine isolation to strong, but is Linux-host-only and not available under Docker
  Desktop on Windows. Revisit only if the environment moves to the homelab Linux host. Enhanced
  Container Isolation is incompatible with the docker-in-docker feature and stays OFF.

---

## 11. Success Metrics / Acceptance Criteria

- **AC1:** `devpod up` on a sample Expo repo opens VS Code with an in-container terminal, and `claude` is runnable there. (G1, FR1, FR2)
- **AC2:** Editing a component triggers Metro hot reload with latency indistinguishable from native WSL dev. (NFR2, FR3)
- **AC3:** `docker build` and `docker run` of a test container succeed inside the workspace **and** `docker ps` on the Windows host does **not** show those containers. (FR4, isolation proof)
- **AC4:** Expo web target loads via forwarded port; Metro reachable by a physical device over LAN or tunnel. (FR5, §8)
- **AC5:** `devpod delete` then `devpod up` reproduces the environment with no manual steps. (G2, FR6)
- **AC6:** The same `devcontainer.json` runs unmodified against a second provider (dry-run against homelab). (NFR4)

---

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Native mobile dev friction (§8) | Medium | Keep simulator/device work host-side; use container for backend/web/Metro only. |
| DinD resource/startup overhead on workstation | Medium | Limit to 1–2 concurrent workspaces; `devpod stop` idle ones. |
| Bind-mount misconfiguration reintroduces slow file watching | Medium | Enforce FR3 — source stays in DevPod volume, never mounted from NTFS. |
| Claude Code accidentally run on host instead of in container | High (defeats G1) | Convention + checklist: only invoke `claude` from the in-container terminal; verify with a marker file check. |
| Image drift from prod | Low | Base Dockerfile on prod image lineage (G3); revisit when prod base changes. |

---

## 13. Rollout Plan

- **Phase 1 — Pilot:** One non-critical Expo repo. Validate AC1–AC5.
- **Phase 2 — Harden:** Settle the base image lineage against prod; add secrets handling; document the "run Claude in-container" convention.
- **Phase 3 — Standardize:** Add `.devcontainer/` to remaining active repos. Optional: a shared base image published to the Forgejo registry for reuse.

---

## 14. Alternatives Considered

- **Plain VS Code Dev Containers + `@devcontainers/cli` (CHOSEN foundation):** The portable asset
  is the spec-conformant `.devcontainer/` itself, consumed identically by the VS Code extension
  (daily driver), the reference CLI (headless + portability proof), Codespaces, and JetBrains.
  Betting on the open standard — not a binary — is exactly the portability requirement (NFR4). The
  CLI also gives a scriptable path for the acceptance-verification harness (`devcontainer exec`).
- **DevPod (REJECTED as the foundation; kept optional):** DevPod's differentiator was one-flag
  provider swap, but its maintenance is now in question
  ([loft-sh/devpod#1915](https://github.com/loft-sh/devpod/issues/1915); slowed releases).
  Depending on it for the foundation trades a portability win for vendor risk. The committed config
  stays DevPod-compatible, so DevPod remains usable as an optional convenience — just not the base.
- **Coder Workspaces (local):** Rejected — its differentiators (web dashboard, templates,
  provisioners, multi-user) map to explicit non-goals; running its control plane locally is
  overhead without payoff here.
- **Raw WSL (status quo):** Rejected — single shared mutable environment, host-file reach, no
  per-project reproducibility or agent isolation.

---

## 15. Open Questions

1. Which prod image is the right parity base for the workspace `Dockerfile` (G3)?
2. Should a shared base dev image be published to the Forgejo registry in Phase 3, or keep per-repo Dockerfiles?
3. Is Expo **tunnel** acceptable as the default device-connection path, or is LAN port-forwarding always available in your setup?
