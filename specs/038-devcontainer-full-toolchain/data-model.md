# Phase 1 Data Model: Config-Artifact Entities

**Feature**: 038-devcontainer-full-toolchain | **Date**: 2026-07-12

This feature has no application database. The "entities" are the config artifacts and their field contracts. Maps the spec's Key Entities to concrete files/fields, with invariants a reviewer or verify script checks.

---

## E1 — Team Toolchain (committed, shared)

**Represented by**: `.devcontainer/toolchain.Dockerfile` (heavy) + the thin `.devcontainer/Dockerfile` + `.devcontainer/devcontainer.json`.

| Field / element | Value / contract | Invariant |
|---|---|---|
| Base | `FROM node:24-bookworm` (toolchain.Dockerfile) | Node ≥ 24 (pnpm@10.33 `node:sqlite`); regressing to 20 crashes (037 gotcha). |
| Rust | rustup stable + rust-analyzer + cargo utils (audit, deny, outdated, machete, semver-checks, geiger, expand, bloat, mutants, tarpaulin) | All on PATH at container start; each reports a version (SC-001). |
| Python | `uv` + Specify CLI (`uv tool install`) | `uv`, `uvx`, `specify` on PATH (SC-001). |
| Node/JS | Node 24 + pnpm (corepack) + Nx via `pnpm nx` | `pnpm nx` resolves; no host fallback (SC-002). |
| `gh` | GitHub CLI (official apt repo) | On PATH, reports a version. |
| Inherited (037) | watchman, iptables/ipset/dnsutils/jq, `coder` user (uid 1001), DinD config dir, Claude Code CLI | Unchanged; 037 verify scripts still pass (SC-008). |
| Credentials | **none** | 0 secrets baked (FR-010/SC-010); passes secret-scan. |
| Committed? | ✅ yes | Contains no personal tool/plugin/credential (FR-009). |

## E2 — Pre-provisioned Toolchain Artifact (build-once, fast path)

**Represented by**: the forge OCI image `mcm-devcontainer` (tag + `@sha256:` digest), built by `.forgejo/workflows/devcontainer-image.yml` from E1's `toolchain.Dockerfile`.

| Field | Contract | Invariant |
|---|---|---|
| Repository | `${REGISTRY}/${NS}/mcm-devcontainer` (host-free Forgejo vars) | Forge host never a git literal (topology-scrub). |
| Reference | immutable `@sha256:<digest>` | Reproducible; digest = staleness signal (FR-013/D8). |
| Consumed via | `MCM_DEVCONTAINER_IMAGE` env → `devcontainer.json` `build.args.BASE_IMAGE` | Top-level `image` is NOT used (not substitution-eligible, D2). |
| Refresh | `workflow_dispatch` / scheduled on toolchain change | No forced local rebuild for a refresh (FR-013). |
| Local fallback | `mcm-devcontainer` (colon-free = :latest) built by `build-devcontainer-image` script | Offline / no-forge path; the `BASE_IMAGE` default (D2). Tag is colon-free — `${localEnv:VAR:default}` truncates a default at its first colon. |
| Credentials | **none** | 0 secrets in the shared artifact (FR-010/SC-010). |

**State transitions**: `absent → built (CI) → pushed (tag+digest) → pulled per-open`. Refresh: `toolchain change → rebuild → new digest → dev updates local MCM_DEVCONTAINER_IMAGE`. Stale = local digest ≠ latest published digest (detectable, FR-013).

## E3 — Persistent Cache (per-ecosystem)

**Represented by**: named-volume `mounts:` in `devcontainer.json` + cache-home env in `toolchain.Dockerfile` (D3 table).

| Field | Contract | Invariant |
|---|---|---|
| Volumes | `mcm-cargo-registry`, `mcm-cargo-git`, `mcm-rustup`, `mcm-uv-cache`, `mcm-pnpm-store` (+ 037's `mcm-commandhistory`, DinD `/var/lib/docker`) | Survive container recreation (FR-004/SC-005). |
| Population | **runtime** (first build/install fills them) | NOT baked under the mount (empty-volume shadowing, D3). |
| Ownership | dirs pre-`chown coder:coder` in image → copy-up | `coder` writes without permission error; root `postCreate` chown fallback repairs a pre-existing root-owned volume. |
| Env pinning | `CARGO_HOME`, `RUSTUP_HOME`, `UV_CACHE_DIR`, pnpm `store-dir` set in image | Stable targets regardless of `$HOME`. |

**Invariant (SC-005)**: after a recreate, a dependency install is served from cache — 0 full re-downloads of already-cached packages.

## E4 — Personal AI-Assistant Setup (non-committed)

**Represented by**: the developer's out-of-repo dotfiles `install.sh` + the persistent `mcm-claude` volume (`/home/coder/.claude`).

| Field | Contract | Invariant |
|---|---|---|
| RTK | `cargo install --git … --root ~/.claude/tools rtk` + `rtk init -g` (installed into the **persisted** `~/.claude` volume, not ephemeral `~/.cargo/bin` — D3/D7) | `rtk gain` > 80% compression in-container (SC-006); survives recreate → 0 reinstall (FR-008/SC-007); RTK not in any repo manifest (constitution). |
| Plugins/skills | `claude plugin install …` (~15) | 100% present after one-time setup (SC-007). |
| Logins | Claude / `gh` / Expo, persisted in `mcm-claude` | 0 re-logins on recreate (SC-007). |
| Idempotency | each step guarded (skip if satisfied / volume populated) | Re-run is cheap and login-preserving (FR-008); never blocks start (FR-014). |
| Committed? | ❌ no (out-of-repo) | The repo carries 0 personal plugin lists / proxy / credentials (FR-009/SC-010). |

## E5 — Personal Delivery Mechanism

**Represented by**: VS Code user setting `dotfiles.repository` (+ `dotfiles.installCommand`/`targetPath`) and the CLI `--dotfiles-repository` flag.

| Field | Contract | Invariant |
|---|---|---|
| Location | per-user VS Code machine setting / CLI flag | Not in devcontainer.json; not committed (FR-009). |
| Trigger | post-create personalization pass (after `postCreateCommand`) | Applied only when configured; absence never blocks container start (FR-014). |
| Failure mode | a blocked source surfaces a clear "which source" error | No hang / silent degrade (FR-015). |

## E6 — Extended Egress Allowlist

**Represented by**: `ALLOWED_DOMAINS` additions in `.devcontainer/init-firewall.sh` (D5).

| Field | Contract | Invariant |
|---|---|---|
| Added domains | crates.io / static.crates.io / index.crates.io, pypi.org / files.pythonhosted.org, astral.sh, api.expo.dev / exp.host | Runtime fetches succeed (SC-009). |
| Forge entry | `FORGE_REGISTRY_HOST` env-injected (037) | Host never a git literal. |
| Default-deny | non-allowlisted destination still DROPped | Arbitrary host refused (SC-009). |
| Build-time note | baked toolchain fetched before the firewall exists | crates/PyPI CDN-rotation is not a per-open problem for the baked set (D5). |

---

## Cross-entity invariants (verify targets)

- **SC-001/002** (E1/E2): every toolchain tool on PATH + a version; all three language builds + SDD run in-container → `verify-toolchain-present.sh`.
- **SC-003/011** (E2): warm recreate < 90 s, 0 re-compile; first-provisioning one-time → timed in `quickstart.md`.
- **SC-005** (E3): install from cache, 0 re-downloads → `verify-caches-persist.sh`.
- **SC-006/007** (E4/E5): `rtk gain` > 80%, plugins present, logins persist → `verify-personal-layer.sh`.
- **SC-008** (E1): 037 host/engine isolation still pass → existing `verify-host-isolation.sh` / `verify-engine-isolation.sh`.
- **SC-009** (E6): required fetches succeed, arbitrary host refused → `verify-firewall-allowlist.sh`.
- **SC-010** (E1/E2/E4): 0 personal lists/proxy/credentials in committed config → review + secret-scan/topology-scrub gates.
