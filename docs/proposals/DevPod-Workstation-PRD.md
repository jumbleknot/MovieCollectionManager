# PRD: Containerized Dev Environments via DevPod on Windows Workstation

**Author:** Steve
**Date:** 2026-07-08
**Status:** Draft
**Scope:** Local (workstation-only) adoption of DevPod-managed devcontainers for AI-assisted development.

---

## 1. Summary

Adopt [DevPod](https://devpod.sh) on the Windows 11 workstation to run per-project, containerized development environments defined as code (`devcontainer.json`). Each environment is a disposable Ubuntu container running on the local Docker Desktop engine, entered via VS Code, with Claude Code executing **inside** the container.

The primary goal is **blast-radius isolation for AI-assisted development**: agent-run commands, dependency installs, and test containers are sealed inside a throwaway container rather than touching the Windows host, while secondary goals (reproducibility, Linux/prod parity, parallel toolchains) come along for free.

This PRD deliberately **excludes** remote access, always-on availability, and multi-user features, which are not requirements. That exclusion is why DevPod (a lightweight CLI over the devcontainer spec) is chosen over Coder (a team-oriented platform).

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

- **G1 — Isolation:** Claude Code and all agent-run shell commands execute inside a container that cannot reach the Windows host filesystem, credentials, or (by default) the host Docker engine.
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
├── VS Code (host)  ──Remote──►  Dev Container
├── Claude Code VS Code ext ───►  (runs inside container)
├── DevPod CLI (host)  ──manages──► Docker Desktop provider
└── Docker Desktop (engine in WSL2)
        └── Dev Container (Ubuntu)
              ├── Project source (DevPod volume, Linux FS)
              ├── Node / Expo / project toolchain
              ├── Claude Code CLI
              └── Inner Docker engine (DinD)  ← test/build containers
```

Key decisions:

- **Provider:** DevPod's **Docker provider**, targeting the existing Docker Desktop engine. No extra daemon.
- **Source location:** DevPod clones the repo into a container-side volume (Linux FS) — satisfies FR3/NFR2.
- **Docker access:** Docker-in-Docker feature gives each container its own inner engine, isolated from Docker Desktop and from other containers — satisfies FR4 and G1 (an escape via the inner engine does not reach the host engine). The alternative — mounting the host Docker socket — is explicitly rejected because it hands the container control of the host engine, defeating the isolation goal.
- **Agent placement:** Claude Code runs in the container's shell so its blast radius equals the container — satisfies G1/FR2.

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

Forward these ports (FR5): `8081` (Metro), `19000`, `19001`, `19006` (Expo Dev/DevTools/web).

---

## 9. Implementation

### 9.1 Install DevPod (workstation, one-time)

1. Install DevPod Desktop or CLI for Windows (`winget install DevPod.DevPod` or download from devpod.sh).
2. Add the Docker provider (uses the running Docker Desktop engine):
   ```powershell
   devpod provider add docker
   devpod provider use docker
   ```
3. Set VS Code as the default IDE:
   ```powershell
   devpod ide use vscode
   ```

### 9.2 `.devcontainer/devcontainer.json` (commit to each repo)

```jsonc
{
  "name": "expo-universal-dev",
  "build": { "dockerfile": "Dockerfile" },

  // Isolated inner Docker engine for building images / running test containers.
  // NOT the host socket — keeps the host Docker Desktop engine out of blast radius.
  "features": {
    "ghcr.io/devcontainers/features/docker-in-docker:2": {
      "moby": true,
      "version": "latest"
    },
    "ghcr.io/devcontainers/features/node:1": { "version": "20" }
  },

  // Metro + Expo dev server ports forwarded to the workstation.
  "forwardPorts": [8081, 19000, 19001, 19006],
  "portsAttributes": {
    "8081":  { "label": "Metro" },
    "19006": { "label": "Expo Web" }
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

  // Runs once after the container is created.
  "postCreateCommand": "npm install -g @anthropic-ai/claude-code && npm install",

  "remoteUser": "coder"
}
```

### 9.3 `.devcontainer/Dockerfile`

Base this on the **same image lineage as your prod images** (G3) once that base is settled; the example below uses a clean Node/Ubuntu base with the tooling Expo/Metro needs.

```dockerfile
# Prefer a base that matches your prod runtime lineage for parity (G3).
FROM node:20-bookworm

# Tooling: git, watchman (fast file watching for Metro), build essentials.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      watchman \
      build-essential \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for the workspace (Docker CLI access is provided by the
# docker-in-docker feature, so no host socket / privileged flags needed).
RUN useradd -m -s /bin/bash coder \
    && echo "coder ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/coder

USER coder
WORKDIR /home/coder
```

> Note: the Docker CLI and inner engine come from the `docker-in-docker` feature — do **not** install Docker manually or mount `/var/run/docker.sock`.

### 9.4 Daily use

```powershell
# Start / open a workspace from a local repo (or a git URL)
devpod up ./my-expo-app --ide vscode

# ... work in VS Code; Claude Code runs in the integrated (container) terminal ...

# Tear down when done; state in the DevPod volume persists unless deleted
devpod stop my-expo-app      # stop, keep volume
devpod delete my-expo-app    # full teardown
```

---

## 10. Security Considerations

- **Agent isolation (primary control):** Claude Code runs as the unprivileged `coder` user inside the container; it has no path to the Windows host FS, no host SSH keys, and no host Docker socket. Inner-engine containers are isolated from Docker Desktop.
- **Secrets:** Inject per-project secrets via container env / DevPod environment, not baked into the image or committed. Do not mount the Windows user profile.
- **No `--privileged`, no host socket mount:** DinD provides Docker capability without host-engine control (see §9.2).
- **Residual risk:** DinD requires elevated capabilities inside the container; a determined escape from the *inner* engine is more plausible than from a plain container. Acceptable for a solo local setup; if that ever matters more, revisit Sysbox on a Linux host (out of scope here — Sysbox is Linux-only and not available under Docker Desktop on Windows).

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

- **Coder Workspaces (local):** Rejected for this scope — its differentiators (web dashboard, templates, provisioners, multi-user) map to explicit non-goals; running its control plane locally is overhead without payoff here.
- **Plain VS Code Dev Containers (no DevPod):** Viable and even lighter. DevPod chosen for its CLI-driven lifecycle and, critically, **NFR4** — the same config can later target the homelab by swapping the provider, with no rewrite.
- **Raw WSL (status quo):** Rejected — single shared mutable environment, host-file reach, no per-project reproducibility or agent isolation.

---

## 15. Open Questions

1. Which prod image is the right parity base for the workspace `Dockerfile` (G3)?
2. Should a shared base dev image be published to the Forgejo registry in Phase 3, or keep per-repo Dockerfiles?
3. Is Expo **tunnel** acceptable as the default device-connection path, or is LAN port-forwarding always available in your setup?
