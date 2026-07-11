# Implementation Plan: Containerized Local Dev Environment for AI-Assisted Development

**Branch**: `037-containerized-dev-env` | **Date**: 2026-07-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/037-containerized-dev-env/spec.md`

## Summary

Give Claude Code a disposable, spec-conformant Linux dev container to run inside, so the agent's blast radius is the container — not the Windows host. Primary requirement: strong isolation of the host filesystem, credentials, and SSH keys (US1/G1), extended with a **default-deny egress firewall** (from Anthropic's reference Claude Code devcontainer) that the source PRD never considered. In-container container builds/test-stacks run on an isolated **docker-in-docker** engine (US2), which requires the container to run `privileged` — so the security posture is stated **honestly**: strong FS/credential isolation, moderate engine isolation. Source lives on a **Docker named volume** (not NTFS) for native file-watch speed (US3). The committed `.devcontainer/` is the portable asset; the reference `@devcontainers/cli` proves it runs unmodified outside VS Code (US5/SC-006). Delivered as config-as-code + verification scripts + a runbook, with the source PRD updated to match (FR-013). No application source, auth, or CI/CD is touched.

## Technical Context

**Language/Version**: Config-as-code — `devcontainer.json` (JSONC) + `Dockerfile` (base `node:20-bookworm`) + POSIX **bash** for `init-firewall.sh` and `.devcontainer/verify/*` scripts. No application language is added. Pilot toolchain: **Node 20** + **pnpm** (via corepack) + **watchman**. Increment 2 (deferred): Rust stable + Python 3.13 + `uv` via devcontainer features.

**Primary Dependencies**: VS Code **Dev Containers** extension (`ms-vscode-remote.remote-containers`, interactive runner); **`@devcontainers/cli`** (headless runner + verification harness + portability proof); feature `ghcr.io/devcontainers/features/docker-in-docker:2` (moby); Anthropic Claude Code devcontainer pattern (egress firewall, non-root user, persistent history); **Docker Desktop** (WSL2 backend) as the host engine (already present — NFR5).

**Storage**: Docker **named volume** for the workspace source (Clone-in-Named-Volume); a persistent volume for shell history / tool caches. No application database. Secrets injected at runtime (`remoteEnv` / gitignored env file), never baked or committed (FR-010).

**Testing**: Acceptance-verification bash scripts under `.devcontainer/verify/`, executed via `devcontainer exec` (headless) and from the in-container terminal; each asserts one success criterion (SC-001/002/005/006). The existing web E2E regression is unaffected and runs *inside* the container as an end-to-end proof that the real dev path still works.

**Target Platform**: Windows 11 workstation, Docker Desktop (WSL2 backend). Container OS: Debian **bookworm** (Ubuntu/Debian-family Linux). Single machine, single user.

**Project Type**: Local developer tooling (config-as-code committed per-repo). Not a service, library, or app.

**Performance Goals**: Warm start of an existing container **< 15 s**; cold build from scratch **< 5 min** on the workstation (SC-004). Hot-reload latency indistinguishable from native (SC-003, achieved via D2 named volume + watchman).

**Constraints**: DinD requires `privileged` → moderate engine isolation, stated honestly (FR-011). Egress firewall is default-deny → the allowlist **must** include the image registries DinD pulls from (Docker Hub, `ghcr.io`, forge registry) or US2 compose-stack pulls fail. Source must stay on the Linux named volume, never an NTFS bind mount (FR-003). Enhanced Container Isolation is **off** (incompatible with the DinD feature). No iOS Simulator / Android emulator in-container (out of scope); native mobile stays host-side.

**Scale/Scope**: 1 user, 1–2 concurrent containers; pilot = this monorepo (`MovieCollectionManager`), targeting frontend/BFF/web + compose-based integration tests inside the container.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v2.3.0. This feature is developer tooling — it adds no application runtime, auth, or data path — so most app-scoped principles are N/A. The applicable gates:*

| Principle | Status | Notes |
|---|---|---|
| **AI Assistant Constraints — Technology Agnosticism** | ✅ PASS | `spec.md` is WHAT/WHY and tech-agnostic; all tech (devcontainer, DinD, firewall, CLI) lives here in `plan.md`/`research.md`. |
| **AI Assistant Constraints — Behavior-Descriptive Identifiers** | ✅ PASS | Artifact names describe behavior (`init-firewall.sh`, `verify-host-isolation.sh`); no `FR-`/`SC-` IDs in filenames — governing IDs go in a provenance comment inside each file. |
| **AI Assistant Constraints — Documentation** | ✅ PASS | A runbook (`docs/runbooks/devcontainer.md`) and the updated PRD are deliverables (FR-013); comments only where rationale is non-obvious. |
| **Security — Secrets Management (NON-NEGOTIABLE)** | ✅ PASS | FR-010: no secret baked into image or committed config; runtime injection only; Windows user profile not mounted. The committed `.devcontainer/` will pass the existing `secret-scan`/`check-no-inline-secrets` gates. |
| **Security — Least privilege** | ⚠️ JUSTIFIED | The container runs `privileged` (DinD requirement). This is unavoidable for a nested engine on Docker Desktop and is disclosed in the honest-posture requirement (FR-011). See Complexity Tracking. |
| **TDD (NON-NEGOTIABLE)** | ✅ PASS | Verification scripts (D6) assert each SC and are authored RED-first (fail with no `.devcontainer/`), then GREEN once config exists. Config-as-code's analog to unit tests. |
| **Test Run Protocol / RTK / E2E regression** | ✅ PASS | Final validation runs the web E2E regression *inside* the container (proves the real dev path); RTK stays active. No app behavior changes, so no new app test suites are required. |
| **Resource Naming (features 019/020)** | ✅ PASS | The dev container + its volumes follow descriptive, conventional names; they are dev-only artifacts, disjoint from the named prod/CI stacks. |
| App-scoped principles (BFF auth, JWT validation, RBAC, Agent architecture, Design System, Frontend stack) | N/A | No application code, endpoint, or UI is added or modified. |

**Result**: PASS with one justified privilege exception (documented below). No unjustified violations — Phase 0 gate cleared.

## Project Structure

### Documentation (this feature)

```text
specs/037-containerized-dev-env/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1–D6 (complete)
├── data-model.md        # Phase 1 — config-artifact "entities" + field contracts
├── quickstart.md        # Phase 1 — runnable validation guide (build, open, verify each SC)
├── contracts/
│   └── devcontainer-contract.md   # Committed-config contract + verification-command contract
├── checklists/
│   └── requirements.md  # Spec quality checklist (complete)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)

This feature adds **config-as-code and docs**, not `src/`. Concrete layout:

```text
.devcontainer/                     # committed per-repo (FR-007); the portable asset (FR-008)
├── devcontainer.json              # runner-agnostic definition: features, ports, remoteUser, mounts policy
├── Dockerfile                     # base node:20-bookworm + pnpm(corepack) + watchman + git + Claude Code deps
├── init-firewall.sh               # default-deny egress firewall; allowlist incl. DinD registries (D4)
└── verify/                        # acceptance-verification harness (D6), run via `devcontainer exec`
    ├── verify-host-isolation.sh       # SC-001 (host FS/creds/SSH unreachable; in-container marker present)
    ├── verify-engine-isolation.sh     # SC-002 (in-container docker run absent from host engine)
    ├── verify-reproducible-recreate.sh# SC-005 (delete + up = identical, zero manual steps)
    └── verify-portable-runner.sh      # SC-006 (@devcontainers/cli up on a clean checkout)

docs/
├── runbooks/devcontainer.md       # daily use; "run Claude in-container" convention + verify (FR-012); LAN vs tunnel; secrets injection
└── proposals/DevPod-Workstation-PRD.md   # UPDATED to match this spec (FR-013): plain runner, honest posture, drop "no --privileged"
```

**Structure Decision**: Single repo-root `.devcontainer/` for the monorepo (Claude Code operates across the whole workspace, so the container is workspace-wide, not per-sub-project). Pilot toolchain is Node/pnpm + DinD (D5); Rust/Python are a measured second increment. Verification scripts live beside the config so the proof travels with the definition.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Container runs `--privileged` (least-privilege exception) | The `docker-in-docker` feature's nested engine cannot run without it; US2/FR-004 (in-container image builds + compose-based integration tests) depends on a host-independent engine. | **Host Docker socket mount** — rejected: gives the container full control of the host engine, defeating G1. **Rootless DinD** — deferred: reduces but doesn't remove elevated caps, adds networking/mount friction; revisit as a hardening spike only if moderate isolation proves insufficient. The privilege is disclosed honestly (FR-011/SC-008), and the egress firewall (D4) plus host-FS isolation keep the *net* blast radius small. |
