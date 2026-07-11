# Phase 1 Data Model: Containerized Local Dev Environment

**Feature**: 037-containerized-dev-env | **Date**: 2026-07-11

This feature has **no persisted application data**. The "entities" are configuration artifacts and their required field values. This document is the field-level contract those artifacts must satisfy; the runnable proof lives in [contracts/devcontainer-contract.md](contracts/devcontainer-contract.md) and [quickstart.md](quickstart.md).

---

## Entity: Environment Definition (`.devcontainer/devcontainer.json`)

The committed, runner-agnostic description of the environment. The portable asset (FR-008).

| Field | Required value / rule | Governing req |
|---|---|---|
| `name` | Behavior-descriptive (e.g., `mcm-workspace`); no spec IDs | Constitution |
| `build.dockerfile` | `Dockerfile` (sibling) | FR-002/FR-009 |
| `features["…/docker-in-docker:2"]` | present; `moby: true` | FR-004 |
| `remoteUser` | non-root (`coder`) — never `root`, never the host user | FR-002 |
| `workspaceMount` / provisioning | Docker **named volume**, not a host/NTFS bind mount | FR-003 |
| `forwardPorts` | `8081` (Metro/web/dev-BFF) always; `8082` (containerized dev BFF) + `8099` (Keycloak OAuth) when run in-container. **Not** legacy `19000/19001/19006` (unused by Expo SDK 56) | FR-005 |
| `portsAttributes` | human labels for Metro / Expo Web | FR-005 |
| `postCreateCommand` | installs Claude Code CLI + `pnpm install`; **no secrets** | FR-002/FR-010 |
| `postStartCommand` (or feature hook) | runs `init-firewall.sh` (default-deny egress) | FR-002 (isolation), D4 |
| `containerEnv` | sets an in-container marker var (e.g., `MCM_DEVCONTAINER=1`) | FR-012 |
| `customizations.vscode.extensions` | includes `anthropic.claude-code` | FR-002 |
| `customizations.vscode.settings` | `files.eol: "\n"` (Linux line endings) | G4 |
| any credential literal | **MUST be absent** | FR-010 |

**Invariants**:
- No field may reference a Windows host path, the host Docker socket, or the host user profile.
- The file MUST parse and run under **both** VS Code Dev Containers and `@devcontainers/cli` with no edits (FR-008/SC-006).

---

## Entity: Base Image Definition (`.devcontainer/Dockerfile`)

| Concern | Required value / rule | Governing req |
|---|---|---|
| Base image | `node:20-bookworm` lineage (matches prod BFF) | FR-009/G3 |
| Installed tools | `git`, `watchman`, `build-essential`, `curl`, `ca-certificates` | US3 (watchman → Metro), FR-002 |
| Workspace user | creates non-root `coder` (sudo optional, documented) | FR-002 |
| Docker install | **none manual** — comes from the DinD feature | D3 |
| Secrets | none baked | FR-010 |
| Increment-2 (deferred) | Rust stable + Python 3.13 + `uv` via features, gated on SC-004 build-time | D5 |

---

## Entity: Egress Firewall (`.devcontainer/init-firewall.sh`)

Default-deny outbound; allowlist only what the workflow needs (D4).

| Allowlisted destination | Why | Governing req |
|---|---|---|
| DNS (53), loopback, ESTABLISHED/RELATED | baseline connectivity | D4 |
| Anthropic API | Claude Code runtime | FR-002 |
| GitHub + npm registry | git, `pnpm`/`npm install` | FR-002 |
| Docker Hub (`registry-1.docker.io`, `auth.docker.io`), `ghcr.io`, forge registry | **DinD image pulls for compose stacks** | FR-004/US2 |
| Everything else | **DROP** | US1/G1 |

**Invariant**: if US2 compose-stack pulls fail, the allowlist is the first suspect — the registry set above is load-bearing.

---

## Entity: Source Volume (Docker named volume)

| Property | Rule | Governing req |
|---|---|---|
| Backing store | Docker named volume in the WSL2 Linux backend | FR-003 |
| Contents | the cloned repository working tree | FR-003 |
| Durability | survives `stop`; removed by `delete`; **the volume is the between-session source of truth** (push = durable backup) | FR-006 |
| NTFS bind mount | **prohibited** | FR-003 |

---

## Entity: Verification Script (`.devcontainer/verify/*.sh`)

| Property | Rule | Governing req |
|---|---|---|
| Name | behavior-descriptive; SC ID only in an in-file provenance comment | Constitution |
| Execution | via `devcontainer exec` and in-container shell | D6 |
| Exit contract | `0` = criterion met, non-zero = violated (assertable in CI-like runs) | D6 |
| Coverage | one script per: SC-001, SC-002, SC-005, SC-006 (SC-003/004/007 measured in quickstart) | D6 |

---

## Lifecycle (state transitions of an Environment Instance)

```text
(absent) --devcontainer up / VS Code "Reopen in Container"--> [built+running]
[built+running] --devcontainer stop / VS Code close--> [stopped, volume retained]
[stopped] --up--> [built+running]   (warm start < 15s, SC-004)
[built+running|stopped] --delete--> (absent, volume removed)
(absent) --up (from committed def)--> [built+running]  (deterministic, zero manual steps, SC-005)
```
