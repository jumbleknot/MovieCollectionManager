# Implementation Plan: Full Developer Toolchain & Personal AI-Assistant Setup in the Dev Container

**Branch**: `038-devcontainer-full-toolchain` | **Date**: 2026-07-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/038-devcontainer-full-toolchain/spec.md`

## Summary

Extend feature 037's isolated dev container so an in-container AI session is **as capable as native** — the full team toolchain (Rust + cargo utilities, `uv` + Specify CLI, Node 24 / pnpm / Nx, `gh`) plus the developer's **personal layer** (RTK compression proxy, Claude Code plugins/skills, service logins) — **without** a multi-minute reinstall per open. Two levers keep startup fast: (1) a **prebuilt toolchain image** built once in CI and pushed to the existing forge registry (`mcm-devcontainer`), pulled per-open instead of compiled; and (2) **persistent named-volume caches** (cargo, rustup, uv, pnpm, plus `~/.claude`) that survive container recreation so nothing re-downloads. The committed definition stays team-neutral and secret-free — the forge host is never a git literal (topology-scrub; supplied via `${localEnv:MCM_DEVCONTAINER_IMAGE}` build-arg), and the personal layer ships via a **personal dotfiles repo** (a per-user VS Code setting, not committed) whose idempotent `install.sh` builds RTK (`cargo install --git`), installs plugins, and reuses persisted logins. The 037 egress firewall is extended by exactly the added package sources (crates.io, PyPI, Expo). No application source, auth, or CI/CD app-deploy path is touched — only a new dev-image build+publish job and the `.devcontainer/` config.

## Technical Context

**Language/Version**: Config-as-code — `devcontainer.json` (JSONC) + two `Dockerfile`s + POSIX **bash** (`init-firewall.sh`, `verify/*`, the CI build script). Toolchain baked into the image: **Rust stable** (rustup) + rust-analyzer + cargo utilities (audit, deny, outdated, machete, semver-checks, geiger, expand, bloat, mutants, tarpaulin), **Python via `uv`** + Specify CLI (`uvx`/`uv tool`), **Node 24** + pnpm (corepack) + Nx, **`gh`**, plus 037's watchman + DinD. No application language is added.

**Primary Dependencies**: VS Code **Dev Containers** extension + **`@devcontainers/cli`** (both must resolve the definition unmodified — 037 US5); feature `ghcr.io/devcontainers/features/docker-in-docker:2` (moby, digest-pinned in `devcontainer-lock.json`); the existing forge OCI registry (app-image pipeline); VS Code **dotfiles** personalization (`dotfiles.repository` user setting / `--dotfiles-repository` CLI flag); RTK from `cargo install --git`.

**Storage**: Docker **named volumes** for every package cache (cargo registry+git, cargo `bin`, rustup toolchains, uv cache, pnpm store) **and `~/.claude`** (plugins/skills/RTK-hook/logins), plus 037's command-history volume and the clone-in-named-volume workspace. No application database. Personal credentials are injected at first run and persist in the `~/.claude` volume — never baked, never committed (FR-010).

**Testing**: Extend 037's `.devcontainer/verify/*` bash harness, run via `devcontainer exec` (headless) and in-terminal; each asserts one SC. **What 038 newly makes runnable in-container** (037 deferred): `pnpm nx test mc-service` + `test:integration mc-service` (Rust), a `uv`/Python check, `rtk gain` (compression). The web E2E regression continues to run inside the container as the real-dev-path proof.

**Target Platform**: Windows 11 workstation, Docker Desktop (WSL2 backend). Container OS: Debian **bookworm** (Node 24 base — pnpm@10.33 loads `node:sqlite`, needs Node ≥22/24). Single machine, single user.

**Project Type**: Local developer tooling (config-as-code, committed per-repo) + a CI image-publish job. Not a service, library, or app.

**Performance Goals**: **Warm recreate < 90 s** with 0 toolchain re-compile/re-download (SC-003); **stop→start < 15 s** (SC-004, unchanged from 037); first dependency install after recreate served from cache, 0 full re-downloads (SC-005). First-ever provisioning (build the prebuilt image, or the local fallback) is a one-time cost (SC-011), explicitly distinguished from per-open.

**Constraints**: `devcontainer.json`'s top-level `image` property does **NOT** support variable substitution (would break pre-building) — so the host-free image pin is via a thin `Dockerfile` `FROM ${BASE_IMAGE}` fed by a `build.args` `${localEnv:...}` (which IS substitution-eligible). Named volumes mounted over image dirs start **empty and shadow** image contents → caches must be runtime-populated, and their target dirs pre-`chown`ed to `coder` (uid 1001) in the image so Docker's empty-volume copy-up grants correct ownership. The extended firewall stays default-deny; crates.io/PyPI are CDN-backed (same cold-pull caveat as 037's registries — bake at image-build time, before the firewall exists). DinD `privileged` + ECI-off are unchanged from 037. Android/native-mobile stays host-side.

**Scale/Scope**: 1 user, 1–2 concurrent containers; the monorepo (`MovieCollectionManager`) targeting the full frontend/BFF/web + Rust mc-service + Python agent layers inside the container.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v2.3.0. Developer-tooling feature — no application runtime/auth/data path — so app-scoped principles are N/A. Applicable gates:*

| Principle | Status | Notes |
|---|---|---|
| **AI Assistant — Technology Agnosticism** | ✅ PASS | `spec.md` is WHAT/WHY, tech-agnostic; all mechanism (prebuilt image, cache volumes, dotfiles, `cargo install --git`) lives here + `research.md`. The 3 pinned decisions are recorded in the spec's Clarifications as *capabilities*, mechanism here. |
| **AI Assistant — Behavior-Descriptive Identifiers** | ✅ PASS | Artifact names describe behavior (`toolchain.Dockerfile`, `verify-toolchain-present.sh`); no `FR-`/`SC-` IDs in filenames — governing IDs in a provenance comment inside each file. |
| **AI Assistant — Documentation** | ✅ PASS | The 037 runbook (`docs/runbooks/devcontainer.md`) is extended (toolchain, caches, dotfiles seam, Wayland/credsStore reminders); comments only where rationale is non-obvious. |
| **Security — Secrets Management (NON-NEGOTIABLE)** | ✅ PASS | FR-010: no credential in the committed definition or the shared prebuilt image; personal logins live only in the `~/.claude` volume, applied by the out-of-repo dotfiles mechanism. Forge host stays out of git (`${localEnv:...}`). Passes existing `secret-scan` / `check-no-inline-secrets` / topology-scrub gates. |
| **Security — Least privilege** | ⚠️ JUSTIFIED (inherited) | Container still runs `privileged` (DinD, from 037). No new privilege is added by 038. Disclosed in the honest-posture requirement (FR-011). See Complexity Tracking. |
| **RTK / Token Compression** | ✅ PASS | RTK is delivered in the **personal** layer (not `package.json`/`Cargo.toml`, per constitution) — `cargo install --git` + `rtk init -g` in the dotfiles `install.sh`; `rtk gain` becomes an in-container verification (SC-006). |
| **TDD (NON-NEGOTIABLE)** | ✅ PASS | `verify/*` scripts assert each SC, authored RED-first (fail before the toolchain/caches/dotfiles land), GREEN after — config-as-code's analog to unit tests. |
| **Test Run Protocol / E2E regression** | ✅ PASS | Final validation runs the web E2E regression **and** the newly-enabled Rust/`uv`/`rtk gain` checks inside the container. No app behavior changes. |
| **Git Management (single root `.gitignore`)** | ✅ PASS | New gitignored local env (`MCM_DEVCONTAINER_IMAGE` source) added to the root `.gitignore`; no personal-tool list committed. |
| **Resource Naming (019/020)** | ✅ PASS | The dev image + cache volumes take descriptive dev-only names (`mcm-devcontainer`, `mcm-cargo-registry`, …), disjoint from prod/CI stacks. |
| App-scoped principles (BFF auth, JWT, RBAC, Agent arch, Design System, Frontend/Backend stack) | N/A | No application code, endpoint, or UI added or modified. |

**Result**: PASS with one **inherited** (not new) justified privilege exception. Phase 0 gate cleared.

## Project Structure

### Documentation (this feature)

```text
specs/038-devcontainer-full-toolchain/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1–D8
├── data-model.md        # Phase 1 — config-artifact "entities" + field contracts
├── quickstart.md        # Phase 1 — runnable validation guide (build image, open, verify each SC)
├── contracts/
│   └── devcontainer-toolchain-contract.md   # Committed-config + CI-publish + verify-command contract
├── checklists/
│   └── requirements.md  # Spec quality checklist (complete)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)

Config-as-code, docs, and one CI job — not `src/`. Concrete layout (⊕ = new in 038, ✎ = modified from 037):

```text
.devcontainer/
├── devcontainer.json              # ✎ build.args BASE_IMAGE=${localEnv:...}; cache-volume mounts; dotfiles reminder
├── Dockerfile                     # ✎ thin: ARG BASE_IMAGE / FROM ${BASE_IMAGE} (host-free image-pin seam)
├── toolchain.Dockerfile           # ⊕ the HEAVY image: Rust+cargo utils, uv+Specify, Nx, gh, watchman, cache-dir chowns
├── devcontainer-lock.json         # (unchanged) DinD feature digest pin
├── init-firewall.sh               # ✎ allowlist += crates.io / PyPI / Expo (host-free forge entry already present)
└── verify/
    ├── verify-host-isolation.sh       # (unchanged, 037) SC-008
    ├── verify-engine-isolation.sh     # (unchanged, 037) SC-008
    ├── verify-reproducible-recreate.sh# (unchanged, 037)
    ├── verify-portable-runner.sh      # (unchanged, 037)
    ├── verify-toolchain-present.sh    # ⊕ SC-001/SC-002 — every tool on PATH + reports a version
    ├── verify-caches-persist.sh       # ⊕ SC-005 — recreate → install served from cache, 0 re-downloads
    ├── verify-firewall-allowlist.sh   # ⊕ SC-009 — crates/PyPI/Expo reachable; arbitrary host still refused
    ├── verify-personal-layer.sh       # ⊕ SC-006/SC-007 — rtk gain >80%, plugins present, logins persisted
    └── verify-committed-clean.sh      # ⊕ SC-010 — committed .devcontainer has 0 personal/creds/forge-host literal

.forgejo/workflows/
└── devcontainer-image.yml         # ⊕ build toolchain.Dockerfile on kvm → push tag+digest to forge → write digest artifact

infrastructure-as-code/  (or scripts/)
└── build-devcontainer-image.*     # ⊕ Nx target / script: local one-time build of the toolchain image (offline fallback)

docs/runbooks/devcontainer.md      # ✎ extend: toolchain, cache volumes, dotfiles seam, image refresh, MCM_DEVCONTAINER_IMAGE env

.gitignore                         # ✎ add the gitignored local env file carrying MCM_DEVCONTAINER_IMAGE (forge host)

<personal, OUT OF REPO>
dotfiles/install.sh                # the personal delivery mechanism — NOT committed to this repo (FR-009)
```

**Structure Decision**: Keep the single repo-root `.devcontainer/` (Claude Code operates workspace-wide). **Two Dockerfiles**: `toolchain.Dockerfile` is the heavy, build-once image (CI→forge, or local fallback); the committed `Dockerfile` is a thin `FROM ${BASE_IMAGE}` whose sole purpose is to parametrize the base image via a `build.args` `${localEnv:...}` substitution — required because top-level `image` is not substitution-eligible, and it is how the forge host stays out of git. The personal layer is entirely out-of-repo (dotfiles) so the committed definition carries no personal tool/credential (FR-009/FR-010).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Container runs `--privileged` (least-privilege exception) | **Inherited from 037** — the `docker-in-docker` nested engine can't run without it; 038 adds no new privilege. | Host Docker socket mount (rejected: full host-engine control, defeats isolation); rootless DinD (deferred hardening spike). Disclosed honestly (FR-011/SC-008); egress firewall + host-FS isolation keep the net blast radius small. |
| Two Dockerfiles + a thin `FROM ${BASE_IMAGE}` indirection | The host-free, digest-pinned image reference: top-level `image` rejects `${localEnv:...}`, but `build.args` accepts it. One Dockerfile can't be both "thin passthrough of the prebuilt image" (fast path) and "full installer" (fallback) without re-running installs on every rebuild. | A single Dockerfile with `image: <forge-host>/…` literal — rejected: puts the topology-sensitive forge host in git (topology-scrub gate). `build.cacheFrom` alone — rejected: BuildKit cache-hit is less deterministic across Docker Desktop than a digest-pinned base. |
