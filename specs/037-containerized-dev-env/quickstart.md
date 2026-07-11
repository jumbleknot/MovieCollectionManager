# Quickstart & Validation Guide: Containerized Local Dev Environment

**Feature**: 037-containerized-dev-env | **Date**: 2026-07-11

Runnable validation that the environment meets its success criteria. This is a **run/validate guide**, not implementation — the config bodies live in `.devcontainer/` (built during implementation) and the SC→check mapping is in [contracts/devcontainer-contract.md](contracts/devcontainer-contract.md).

## Prerequisites

- Windows 11 workstation with **Docker Desktop** running (WSL2 backend). Enhanced Container Isolation **off** (incompatible with the DinD feature — research D3).
- VS Code with the **Dev Containers** extension (`ms-vscode-remote.remote-containers`).
- Node ≥ 18 on the host **only** to install the headless runner: `npm install -g @devcontainers/cli`.
- A sentinel host-only file to prove isolation, e.g. `C:\Users\Steve\HOST-ONLY-MARKER.txt` (must NOT appear inside the container).

## Path A — Interactive (VS Code), the daily driver

1. Command Palette → **Dev Containers: Clone Repository in Named Container Volume** → this repo's URL. (Source lands on a Linux named volume — FR-003, not `E:\`.)
2. Wait for the cold build (first time). Expect **< 5 min** (SC-004).
3. When it reopens, the integrated terminal is **inside** the container. Confirm:
   ```bash
   echo "$MCM_DEVCONTAINER"      # -> 1  (in-container marker, FR-012)
   whoami                        # -> coder (non-root, FR-002)
   claude --version              # Claude Code CLI present (FR-002)
   ```

## Path B — Headless (portability proof, SC-006)

```bash
# From a clean checkout dir on the host (bash):
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash .devcontainer/verify/verify-host-isolation.sh
devcontainer exec --workspace-folder . bash .devcontainer/verify/verify-engine-isolation.sh
```
Both scripts exit `0` under the CLI runner with **no edits** to `devcontainer.json` → SC-006 met.

## Validation scenarios (each maps to a success criterion)

| Scenario | Command / action | Expected (pass) |
|---|---|---|
| **Host isolation (SC-001)** | `bash .devcontainer/verify/verify-host-isolation.sh` | Exit 0: host sentinel unreachable; no host `~/.ssh` / credential store; marker present |
| **Engine isolation (SC-002)** | `bash .devcontainer/verify/verify-engine-isolation.sh` | Exit 0: in-container `docker run` works **and** host `docker ps -a` omits it |
| **Hot-reload parity (SC-003)** | Start Metro/Expo in-container, edit a component | Reload with no perceptible slowdown vs native |
| **Startup budget (SC-004)** | Time cold `devcontainer build`; time warm `devcontainer up` | cold < 5 min; warm < 15 s |
| **Reproducibility (SC-005)** | `bash .devcontainer/verify/verify-reproducible-recreate.sh` (wraps `delete` then `up`) | Exit 0: recreated with 0 manual steps; isolation checks still pass |
| **Portability (SC-006)** | Path B above | Both verify scripts exit 0 under `@devcontainers/cli` |
| **Dev server over network (SC-007)** | Run Expo web/Metro in-container; open forwarded `localhost:8081` in a browser; connect a phone over LAN | App loads on both (tunnel fallback if LAN routing unavailable) |
| **Honest posture (SC-008)** | Grep the runbook + updated PRD for "unprivileged"/"no privileged" claims | 0 such claims; moderate-engine-isolation caveat present |
| **Full in-container session (SC-009)** | Run backend/web dev + a compose-based integration test (`pnpm nx test:integration …`) entirely in-container | Completes with no host-side fallback (native mobile excepted) |

## Compose-stack note (SC-009 / US2)

Running the project's compose stacks inside the container uses the **in-container DinD engine**. The first pull is slow (cold registries) and **requires the egress firewall to allowlist** Docker Hub / `ghcr.io` / the forge registry (research D4). If a pull hangs or is refused, check the firewall allowlist **before** suspecting Docker.

## Teardown

```bash
devcontainer exec … # (finish work, git push — the volume is the between-session source of truth)
# VS Code: "Dev Containers: Reopen Folder Locally", or:
devcontainer down --workspace-folder .   # stop
# Full teardown (removes the volume): remove the container + named volume via Docker.
```
