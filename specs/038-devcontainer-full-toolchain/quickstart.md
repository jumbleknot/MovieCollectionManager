# Quickstart & Validation Guide: Full Toolchain + Personal Layer

**Feature**: 038-devcontainer-full-toolchain | **Date**: 2026-07-12

Runnable validation that proves the feature end-to-end. Prereqs, setup, per-SC checks, expected outcomes. Implementation detail lives in `tasks.md`; contracts in [contracts/devcontainer-toolchain-contract.md](contracts/devcontainer-toolchain-contract.md); mechanism in [research.md](research.md). Most acceptance is **hands-on host work** on the Windows workstation (build/pull the image, dotfiles install, timing) — mirroring 037. What 038 newly makes headless-runnable in-container: Rust/`uv` builds + `rtk gain`.

---

## Prerequisites

- Feature 037 baseline present (`.devcontainer/`, Docker Desktop WSL2, VS Code Dev Containers extension + `@devcontainers/cli`).
- Access to the forge registry (for the fast path) **or** ability to build the image locally (fallback).
- 037's VS Code reminders in place: `"dev.containers.mountWaylandSocket": false`; `DOCKER_CONFIG` override (baked). See [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md).

## One-time setup

**Fast path (forge image):**
1. Trigger `devcontainer-image.yml` (`workflow_dispatch`) → note the published `@sha256:<digest>`.
2. Set `MCM_DEVCONTAINER_IMAGE=<forge-host>/<ns>/mcm-devcontainer@sha256:<digest>` in the **gitignored** local env / your VS Code launch env (host stays out of git).

**Fallback path (offline / no forge):**
1. `node scripts/build-devcontainer-image.mjs` (or the Nx target) → builds `.devcontainer/toolchain.Dockerfile` → tags `mcm-devcontainer:local`. (This is the SC-011 one-time cost — expect several minutes.)
2. Leave `MCM_DEVCONTAINER_IMAGE` unset → `build.args` default resolves to `mcm-devcontainer:local`.

**Personal layer (optional, per-developer):**
- Set the VS Code user setting `dotfiles.repository` to your personal dotfiles repo (with an idempotent `install.sh`), or pass `--dotfiles-repository` to the CLI. Absent = the container still comes up fully team-capable (FR-014).

## Validate each Success Criterion

### SC-001 / SC-002 — full toolchain present & usable in-container
```bash
# From inside the container (or: devcontainer exec <id> …):
bash .devcontainer/verify/verify-toolchain-present.sh          # every tool → version, 0 missing
pnpm nx test mc-service                                         # Rust unit (NEW in-container, 038)
pnpm nx test:integration mc-service                            # Rust integration (needs mcm stack up)
uv run python -c "print('py ok')"                              # Python via uv
specify --help                                                 # SDD CLI
pnpm nx lint mcm-app                                           # JS/TS
```
Expected: all succeed, no "command not found", no host fallback.

### SC-003 / SC-011 — warm recreate < 90 s, 0 re-compile; first-provision one-time
- Recreate the container from the committed definition (Dev Containers: Rebuild, or `devcontainer up --remove-existing-container`). Time from trigger to usable shell.
- Expected: **< 90 s**, and `docker build` shows the toolchain layers already present (pulled base image, no Rust/tool compile). First-ever build (the one-time cost) is timed separately and does NOT recur on subsequent opens.

### SC-004 — stop→start < 15 s
- Stop, then start the existing container. Expected: **< 15 s** (unchanged from 037).

### SC-005 — caches persist, install from cache
```bash
bash .devcontainer/verify/verify-caches-persist.sh
```
Expected: after a recreate, `cargo`/`pnpm`/`uv` installs report cache hits, 0 full re-downloads of already-cached packages (the named volumes survived).

### SC-006 / SC-007 — personal layer active & persistent
```bash
bash .devcontainer/verify/verify-personal-layer.sh
rtk gain                                                        # > 80% compression
```
Expected: `rtk gain` > 80%; expected plugins/skills listed present; still logged in (Claude/`gh`/Expo) with 0 re-auth after a recreate. If the personal layer is not configured, the script exits 0 with a "personal layer absent" notice (FR-014).

### SC-008 — 037 isolation still holds
```bash
bash .devcontainer/verify/verify-host-isolation.sh
bash .devcontainer/verify/verify-engine-isolation.sh
```
Expected: both exit 0 (host FS/creds/SSH unreachable; in-container docker run absent from host engine).

### SC-009 — firewall allows exactly the added sources
```bash
bash .devcontainer/verify/verify-firewall-allowlist.sh
```
Expected: crates.io / pypi.org / api.expo.dev reachable; an arbitrary non-allowlisted host is refused/timed out.

### SC-010 — committed config is personal-free & secret-free
```bash
node scripts/secret-scan.mjs                                    # 0 findings in .devcontainer/
node scripts/check-topology-scrub.mjs                          # forge host not a git literal
grep -rniE 'rtk|plugin install|dotfiles\.repository' .devcontainer/   # expect: 0 personal entries
```

## Final validation (per constitution — inside the container)
```bash
pnpm nx e2e mcm-app                                            # web E2E regression (real dev path)
pnpm nx test mc-service && pnpm nx test:integration mc-service # Rust (newly in-container)
rtk gain                                                        # > 80% compression confirmed
```

## Refresh the toolchain image (FR-013)
- Re-run `devcontainer-image.yml` → new `@sha256:` digest → update your gitignored `MCM_DEVCONTAINER_IMAGE`. A stale local digest ≠ the latest published digest is the staleness signal. No forced local rebuild.
