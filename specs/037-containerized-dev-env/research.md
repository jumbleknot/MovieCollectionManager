# Phase 0 Research: Containerized Local Dev Environment

**Feature**: 037-containerized-dev-env | **Date**: 2026-07-11

All decisions below resolve the "HOW" deliberately deferred from `spec.md`. No `NEEDS CLARIFICATION` markers remain in the Technical Context after this phase.

---

## D1 — Runner: plain VS Code Dev Containers + `@devcontainers/cli`, not DevPod

**Decision**: The interactive runner is the **VS Code Dev Containers** extension (`ms-vscode-remote.remote-containers`). The **portable asset is the spec-conformant `.devcontainer/` directory**, and the second, headless runner that proves portability (SC-006 / FR-008) is the reference **`@devcontainers/cli`** (`devcontainer build|up|exec`).

**Rationale**:
- The open dev-container standard (`containers.dev`) is what every runner consumes — VS Code, GitHub Codespaces, the reference CLI, JetBrains, and DevPod all read the same `devcontainer.json`. Betting on the spec, not a binary, is exactly FR-008.
- DevPod's differentiator was one-flag provider swap (the PRD's NFR4), but its maintenance is now in question (open issue [loft-sh/devpod#1915 "Still Maintained?"](https://github.com/loft-sh/devpod/issues/1915); slowed releases). Depending on it for the *foundation* trades a portability win for a vendor risk. The CLI delivers the same portability proof with a first-party, actively-maintained tool.
- The `@devcontainers/cli` also gives a scriptable path for the acceptance-verification harness (`devcontainer exec <check>`), which the interactive extension does not.

**Alternatives considered**:
- **DevPod** — rejected as the foundation (vendor risk); the config remains DevPod-compatible, so it stays usable as an optional convenience.
- **Plain `docker run`/hand-rolled compose dev env** — rejected: loses the standard, the editor-attach UX, and the portability guarantee.

**Sources**: [containers.dev reference](https://containers.dev/implementors/reference/), [@devcontainers/cli](https://www.npmjs.com/package/@devcontainers/cli), [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers).

---

## D2 — Source on a Docker **named volume**, never an NTFS bind mount

**Decision**: Provision the workspace with **"Dev Containers: Clone Repository in Named Container Volume"** (extension) / `--workspace-mount` targeting a Docker named volume (CLI). Source lives on the Linux volume inside the Docker Desktop WSL2 backend, not on `E:\`/NTFS.

**Rationale**:
- Bind mounts cross the Docker VM boundary on Windows; I/O-heavy operations (`pnpm install`, file watching) run 5–10× slower than a Linux-native volume. A named volume gives full native speed — this is precisely FR-003 / SC-003 (hot-reload parity).
- The named-volume clone is the canonical VS Code mechanism for this and is CLI-reproducible, satisfying SC-005 (delete + recreate, zero manual steps).

**Consequence to document** (runbook): the working copy no longer lives on `E:\`. Git operations happen inside the container. Uncommitted work lives in the volume until pushed — the volume is the source of truth between sessions; `git push` is the durable backup.

**Alternatives considered**:
- **Bind-mount `E:\...\MovieCollectionManager`** — rejected: reintroduces the slow-file-watch failure mode US3/edge-case calls out.
- **Keep the repo in the WSL2 filesystem (`\\wsl$`) and open-folder-in-container** — viable and fast, but couples the workflow to a manually-maintained WSL checkout; the named-volume clone is more self-contained and reproducible.

**Sources**: [VS Code — Improve container disk performance](https://code.visualstudio.com/remote/advancedcontainers/improve-performance), [Dev Containers docs](https://code.visualstudio.com/docs/devcontainers/containers).

---

## D3 — In-container Docker via the `docker-in-docker` feature (privileged, honest posture)

**Decision**: Use `ghcr.io/devcontainers/features/docker-in-docker:2` (moby engine). Accept that enabling it makes the resolver run the container **`privileged`** — this is required and unavoidable for a nested engine. Document the honest posture (FR-011 / SC-008): strong host-FS/credential isolation, **moderate** engine isolation.

**Rationale**:
- FR-004/US2 needs an engine separate from the host engine so in-container test containers do not appear on or control the host engine. The DinD feature runs an isolated `dockerd` inside the dev container — nested containers are invisible to Docker Desktop's engine.
- The feature auto-sets `privileged: true` whenever it is enabled (features resolver behavior). A privileged container ≈ root on the shared Docker Desktop WSL2 VM, so a privileged-escape can reach the host VM and thus the host engine. That is the true ceiling on this platform and the spec commits to stating it plainly rather than claiming "no privileged."

**Known tension (validate in pilot)**: Docker Desktop's **Enhanced Container Isolation (ECI)** — the platform's mitigation for hostile privileged containers — **breaks the DinD feature** (`mount: /sys/kernel/security: permission denied`, [devcontainers/features#1319](https://github.com/devcontainers/features/issues/1319)). So ECI + DinD cannot both be on here. We run **without ECI** and accept moderate engine isolation. Strong engine isolation (e.g., Sysbox → genuine unprivileged DinD) is Linux-host-only and out of scope (revisit only if the environment ever moves to the homelab Linux host).

**Alternatives considered**:
- **Mount the host Docker socket** (`/var/run/docker.sock`) — rejected outright: hands the container full control of the host engine, defeating G1 entirely.
- **Rootless DinD** — deferred: shrinks the privileged surface but adds setup friction and some test-container networking/mount limitations; revisit as a hardening spike only if moderate isolation proves insufficient. Not in the pilot.
- **No in-container Docker** — rejected: US2 (compose-based integration tests) is a core workflow.

**Sources**: [devcontainers/features — docker-in-docker](https://deepwiki.com/devcontainers/features/3.1-docker-in-docker), [features reference](https://containers.dev/implementors/features/), [ECI × DinD incompatibility #1319](https://github.com/devcontainers/features/issues/1319).

---

## D4 — Build on Anthropic's Claude Code devcontainer pattern: egress firewall + non-root user + persistent history

**Decision**: Adopt the structure of [Anthropic's reference Claude Code devcontainer](https://code.claude.com/docs/en/devcontainer): a **default-deny egress firewall** (`init-firewall.sh`, iptables + ipset allowlist) run at container start, an unprivileged workspace user, and a persistent volume for shell history/caches. Claude Code is installed in-container (CLI on `PATH` + the `anthropic.claude-code` VS Code extension).

**Rationale**:
- Adds a control the source PRD never considered — **network blast-radius reduction**. Even inside an isolated container, a compromised dependency's exfiltration/callback is blocked unless its destination is allowlisted. This directly strengthens US1/G1 beyond filesystem isolation.
- It is the vendor-blessed, known-good composition of exactly the pieces we need (CLI + firewall + persistent volume + non-root), reducing bespoke risk.

**Integration risk (validate in pilot)**: default-deny egress **must allowlist the image registries DinD pulls from** for US2 (Docker Hub `registry-1.docker.io`/`auth.docker.io`, `ghcr.io`, plus the project's forge registry) — otherwise compose-stack image pulls fail. The firewall runs before/around DinD; the allowlist is the coupling point. Also: the firewall needs `NET_ADMIN`/`NET_RAW`, already covered because DinD runs privileged.

**Alternatives considered**:
- **No egress firewall** (PRD baseline) — rejected: leaves network exfiltration in the agent's blast radius for free-to-close cost.
- **Full network isolation (no egress)** — rejected: breaks `pnpm install`, git, Claude API, and registry pulls; allowlist is the right balance.

**Sources**: [Claude Code devcontainer docs](https://code.claude.com/docs/en/devcontainer), [init-firewall.sh](https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh), [firewall architecture](https://deepwiki.com/anthropics/claude-code/6.2-network-security-and-firewall).

---

## D5 — Base image & toolchain scope: Node/pnpm + DinD for the pilot; Rust/Python as increment 2

**Decision**: Pilot base = a current **Node 20 / Debian bookworm** image (aligns with the project's deployed `node:20-bookworm` BFF lineage — G3/FR-009), plus **pnpm via corepack**, **git**, **watchman** (fast Metro file-watch), the DinD feature, Claude Code, and the firewall. **Rust (stable) and Python 3.13 + `uv`** are added as a **second increment** (devcontainer features), not the MVP.

**Rationale**:
- The MVP (US1 isolation + US2 compose stacks + US3 web/Metro dev) needs only Node/pnpm + DinD: `pnpm nx build` and the compose stacks build/pull their own images inside nested build containers (the Rust musl build and BFF image build happen *inside* those Docker builds, not from the dev container's host toolchain), and web E2E runs the JS toolchain.
- Native `cargo test` / `pnpm nx test mc-service` and `uv run` / Python agent unit tests **do** need Rust/Python in the dev container — but adding both to the MVP risks the < 5 min cold-build budget (SC-004). Splitting lets us **measure** build time on the Node+DinD base first, then add toolchains and re-measure.
- Watchman is included specifically for Metro; Node 20 matches prod BFF lineage for parity.

**Alternatives considered**:
- **All three toolchains in the MVP image** — deferred, not rejected: correct end-state for whole-monorepo agent work, but gated on the SC-004 build-time measurement.
- **Microsoft `javascript-node` devcontainer image** vs plain `node:20-bookworm` — either works; prefer the prod-lineage `node:20-bookworm` base for G3 parity, layering tools via Dockerfile + features.

**Sources**: repo CLAUDE.md (prod BFF lineage `node:20-bookworm`; musl-vendored Rust Docker build; pnpm-only), [devcontainer features (node, rust, python)](https://containers.dev/features).

---

## D6 — Acceptance verification harness: scripts asserted via `devcontainer exec`

**Decision**: Each measurable success criterion maps to a **verification script** under `.devcontainer/verify/`, runnable via `devcontainer exec` (headless) and from the in-container terminal. Behavior-descriptive names, no spec IDs in filenames (constitution); the governing SC is a provenance comment inside each script.

**Rationale**:
- Satisfies the constitution's TDD gate for config-as-code: write the isolation/engine/reproducibility assertions first (they fail with no `.devcontainer/` — RED), then the config makes them pass (GREEN). The scripts are the durable regression proof for SC-001, SC-002, SC-005, SC-006.
- `devcontainer exec` runs them under the same `remoteUser`/`remoteEnv` the interactive session uses, so the proof matches reality.

**Examples**: `verify-host-isolation` (SC-001: host-only marker unreachable, no host credential stores), `verify-engine-isolation` (SC-002: in-container `docker run` then assert absence on host engine), `verify-reproducible-recreate` (SC-005), `verify-portable-runner` (SC-006: `devcontainer up` on a clean checkout).

**Sources**: [@devcontainers/cli example-usage](https://github.com/devcontainers/cli/tree/main/example-usage); repo constitution (TDD NON-NEGOTIABLE, Behavior-Descriptive Identifiers).

---

## Resolved Open Questions (from spec Assumptions)

| Open question | Resolution |
|---|---|
| Prod-parity base image (PRD OQ1) | `node:20-bookworm` lineage for the pilot (matches BFF). A specific `jumbleknot/*` base can be swapped later without reworking the config (D5). |
| Shared registry base image vs per-repo (PRD OQ2) | Per-repo `.devcontainer/` for the pilot; publishing a shared base to the forge registry is a later, optional standardization step (out of pilot scope). |
| Expo tunnel vs LAN default (PRD OQ3) | LAN port-forward is the default (`forwardPorts`); Expo tunnel is the documented fallback. No config cost either way. |
| Agent-in-container verification (FR-012) | In-container marker (env var + marker file) checked by `verify-host-isolation` and surfaced in the shell prompt; daily-use convention documented in the runbook. |
