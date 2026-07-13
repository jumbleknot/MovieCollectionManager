# Phase 0 Research: Full Developer Toolchain & Personal AI-Assistant Setup

**Feature**: 038-devcontainer-full-toolchain | **Date**: 2026-07-12

This resolves every unknown in the plan's Technical Context. Each decision is Decision / Rationale / Alternatives. Baseline = the merged feature-037 `.devcontainer/`; 038 is "increment 2" (full toolchain) + the personal layer + the fast-startup mechanism.

---

## D1 — Fast-startup lever #1: prebuilt toolchain image on the forge registry

**Decision**: Build the heavy toolchain **once** from `.devcontainer/toolchain.Dockerfile` in CI, push it to the existing forge OCI registry as `mcm-devcontainer` (tag + immutable `@sha256:` digest), and reference it per-open by digest. A fresh container is a `docker pull` (~30–60 s), not a 10–15-min Rust/tool compile. Rebuild only when the toolchain changes (Renovate / weekly / manual dispatch) — never per open.

**Rationale**: Directly satisfies SC-003 (warm recreate < 90 s, 0 re-compile) and SC-011 (first-provisioning is one-time). Reuses the proven app-image pipeline (kvm runner, `docker build` → push tag+digest, host-free `REGISTRY`/`NS`/`REGISTRY_USER` Forgejo vars). The 037 spec already flagged a "shared registry-published base image" as the later standardization step this becomes.

**Alternatives considered**:
- *Build the full toolchain locally on every rebuild* — rejected: the multi-minute compile is exactly what makes a capable container get abandoned (US2 rationale).
- *`build.cacheFrom` a forge image, single Dockerfile* — rejected as the primary mechanism: BuildKit cache-hit across Docker Desktop is less deterministic than a digest-pinned `FROM` base; kept as an optional accelerator only.
- *ghcr.io instead of the forge* — rejected (pinned decision, spec Clarifications): diverges from the forge-native app-image pipeline; adds a second registry.

## D2 — Host-free, digest-pinned image reference (the topology-scrub-safe seam)

**Decision**: The committed `devcontainer.json` uses `build.dockerfile: Dockerfile` + `build.args: { "BASE_IMAGE": "${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer}" }`. The committed **thin** `Dockerfile` is `ARG BASE_IMAGE=mcm-devcontainer` / `FROM ${BASE_IMAGE}` (its sole job is to parametrize the base). The digest-pinned forge reference (`<forge-host>/<ns>/mcm-devcontainer@sha256:…`) is supplied at runtime via the `MCM_DEVCONTAINER_IMAGE` env var, sourced from a **gitignored** local env — the forge host literal never enters git (topology-scrub gate, same rule 037 uses for `FORGE_REGISTRY_HOST`).

**Rationale**: Verified against the dev-container spec — **top-level `image` does NOT support `${localEnv:...}`** ("variables are not supported in properties used during image build time, as this would prevent pre-building"), but **`build.args` DOES** (canonical `"${localEnv:VARIABLE_NAME}"` example), and the **default-value form `${localEnv:VAR:default}` exists**. `${localEnv}` reads the host environment in **both** the VS Code extension and `@devcontainers/cli` (identical semantics; VS Code may need a restart to see a newly-set var). So `build.args` is the only substitution-eligible way to keep the forge host out of git while pinning the image.

> **★★ Implementation gotcha (verified 2026-07-12, `@devcontainers/cli` 0.87.0 — CORRECTS the original `:local` plan).** The `${localEnv:VAR:default}` parser splits the **default** on its FIRST colon, so a default that itself carries a Docker tag colon — `mcm-devcontainer:local` — silently truncates to `mcm-devcontainer` (the `:local` is discarded). The local-fallback tag is therefore kept **COLON-FREE** (`mcm-devcontainer`, which Docker reads as `:latest`), and the local build script tags the same colon-free name so the default and the build stay in sync. A colon-containing **env value** (the forge `…@sha256:…` digest ref, or a `host:port/…` ref) passes through **intact** — only the literal default is affected. Confirmed via `devcontainer read-configuration` (unset env → `BASE_IMAGE == "mcm-devcontainer"`; env set to a `@sha256:` ref → passed through verbatim).
>
> **★★★ Cross-runner divergence (verified 2026-07-12, VS Code Dev Containers extension CLI 0.463.0 — supersedes "the default is the offline fallback").** The two runners do **not** agree on `${localEnv:VAR:default}`: `@devcontainers/cli` honors the default, but the **VS Code extension does NOT** — when `MCM_DEVCONTAINER_IMAGE` is unset it emits `--build-arg BASE_IMAGE=` (**empty**), which *overrides* the thin Dockerfile's `ARG BASE_IMAGE=mcm-devcontainer` default and fails the build with `base name (${BASE_IMAGE}) should not be blank`. There is no in-config way to make VS Code skip an empty build-arg or apply the default. **Therefore `MCM_DEVCONTAINER_IMAGE` is a REQUIRED prerequisite under VS Code** (set to `mcm-devcontainer` for the local image, or the `@sha256:` digest for the forge fast path) — the same posture the forge path needs anyway. The Dockerfile ARG default + the localEnv default remain as a convenience for `@devcontainers/cli`/CI. This makes the "zero-config bare open" claim CLI-only; VS Code is documented as env-var-required (runbook).

**Alternatives considered**:
- *`"image": "${localEnv:...}"`* — **does not work** (image is not substitution-eligible).
- *Literal `FROM <forge-host>/…` in the committed Dockerfile* — rejected: commits the topology-sensitive forge host (fails topology-scrub).
- *`runArgs` substitution* — rejected: `runArgs` is not in the spec's substitution list (unreliable cross-runner).

## D3 — Fast-startup lever #2: persistent named-volume caches

**Decision**: Mount a dedicated named volume for each package cache so nothing re-downloads across container recreation. Set the cache-home env vars **explicitly** in `toolchain.Dockerfile` so targets are stable regardless of `$HOME`, and **pre-create + `chown coder:coder` (uid 1001)** each dir in the image so Docker's empty-volume **copy-up** grants correct ownership on first mount.

| Volume (descriptive name) | Mount target | Env var set in image |
|---|---|---|
| `mcm-cargo-registry` | `/home/coder/.cargo/registry` | `CARGO_HOME=/home/coder/.cargo` |
| `mcm-cargo-git` | `/home/coder/.cargo/git` | (same `CARGO_HOME`) |
| `mcm-uv-cache` | `/home/coder/.cache/uv` | `UV_CACHE_DIR=/home/coder/.cache/uv` |
| `mcm-pnpm-store` | `/home/coder/.local/share/pnpm/store` | pnpm `store-dir` (Linux default) |
| `mcm-claude` (personal) | `/home/coder/.claude` | — (holds plugins/skills/RTK-hook/logins) |
| `mcm-commandhistory` (037) | `/commandhistory` | — (unchanged) |
| DinD `/var/lib/docker` (037 feature) | — | — (already volumed by the feature) |

> **★★ CORRECTION (verified 2026-07-12 by a Docker copy-up experiment) — `mcm-rustup` DROPPED; the baked toolchain + cargo `bin` are NOT volumed.** Two facts settled the volume list: (1) A fresh named volume mounted over a **baked** image dir is **populated by Docker copy-up** (NOT left empty — the experiment mounted a fresh volume over a baked `/opt/toolchain/bin` and saw the baked file, owned `coder:coder` because the image dir was pre-chowned). So D3's "starts empty and shadows" is imprecise: copy-up fills a *fresh* volume on first mount; the real hazard is the **stale-on-image-refresh** case — an *existing, non-empty* volume shadows a **newer** baked version (no second copy-up). (2) The rustup toolchain and the cargo-utility binaries are **baked** (D4) and must **track the image** so an image refresh (FR-013 → new digest) actually delivers updated tools. Voluming `/home/coder/.rustup` (or `~/.cargo/bin`) would let a stale volume shadow a refreshed toolchain — defeating FR-013 — for **zero** benefit (the toolchain is already on PATH from the image layer, no re-download to amortize). **Therefore only the DOWNLOAD caches are volumed** — dirs that are **empty in the image** and **runtime-populated** by the project's own builds (`.cargo/registry`, `.cargo/git`, `.cache/uv`, the pnpm store). Those never carry a baked payload, so there is no stale-shadow, and they legitimately persist across recreation (SC-005). Runtime `rustup component add` / `rustup target add` persistence is intentionally traded away for FR-013 correctness; a needed target is baked in the image instead.

**Rationale**: Satisfies SC-005 (install from cache, 0 re-downloads) and FR-004. **Never bake a cache under its mount point** (a pre-warmed cache would be shadowed-stale on the next image refresh, per the correction above) — the download caches are empty in the image and runtime-populated. **Ownership gotcha (confirmed)**: a fresh named volume inherits ownership from the image dir via copy-up, so pre-`chown coder:coder`-ing each cache-dir target in the image grants uid 1001 first-write; without it a fresh volume can land `root:root`. Belt-and-suspenders: a root `onCreateCommand` `chown -R coder:coder` fallback repairs a pre-existing root-owned volume.

**Alternatives considered**:
- *No cache volumes (re-download each recreate)* — rejected: violates SC-005, slow.
- *Bake caches into the image* — rejected: shadowed by the mount; also bloats the image and re-invalidates on any dep change.
- *`~/.cargo/bin` (installed binaries) as a volume* — rejected: the baked cargo utilities live in the image-layer `~/.cargo/bin` (on PATH at start, SC-001); a volume there would **shadow** them (empty-volume gotcha). So only download/registry/git/toolchain caches are volumed, never `bin`.
  - **Consequence for RTK (see D7)**: a runtime `cargo install` of RTK writes to `~/.cargo/bin`, which is the container's **ephemeral writable layer** (not a volume) → the binary is **lost on recreate**, which would force a reinstall every open (violates FR-008/SC-007). Fix: install RTK into the **persisted `~/.claude` volume** (`cargo install --root ~/.claude/tools`) and add `~/.claude/tools/bin` to PATH — so RTK persists without shadowing the baked cargo tools.

## D4 — Toolchain contents (the committed team set)

**Decision**: `toolchain.Dockerfile` (`FROM node:24-bookworm`, inheriting 037's watchman + firewall deps + `coder` user + DinD-config dir) additionally installs, slow→fast layer order for cache reuse:
- **Rust**: rustup (stable) + `rustc`/`cargo`/`rustfmt`/`clippy` + `rust-analyzer` + cargo utilities already used by the repo's security/quality gates: `cargo-audit`, `cargo-deny`, `cargo-outdated`, `cargo-machete`, `cargo-semver-checks`, `cargo-geiger`, `cargo-expand`, `cargo-bloat`, `cargo-mutants`, `cargo-tarpaulin` (coverage — constitution SC-011/tarpaulin).
- **Python**: `uv` (astral installer) → provides `uvx`/`uv tool`; **Specify CLI** via `uv tool install` (the SDD toolchain).
- **Node/JS**: Node 24 (base) + pnpm (corepack, version resolved from `package.json` `packageManager`) + Nx (invoked via `pnpm nx`, no global needed) — 037 already bakes corepack + Claude Code CLI.
- **`gh`**: GitHub CLI from the official apt repo.

**Rationale**: FR-001/FR-002 — every layer's build/lint/test + the SDD commands run in-container with no host fallback. The cargo-utility set is exactly what the repo's SAST/SCA/quality gates (features 033/034/035) invoke, so `pnpm nx` Rust targets and `cargo audit`/`deny` work in-container. Baking tools into an image LAYER (not a mounted volume) keeps them on PATH at container start (SC-001) and unshadowed by the cache volumes.

**Alternatives considered**:
- *devcontainer "features" for Rust/Python* (`ghcr.io/devcontainers/features/rust`, `.../python`) — viable but the prebuilt-image lever wants explicit control of versions + the cargo-utility set + cache-dir env in one Dockerfile; features add resolution indirection and are harder to pin than explicit `RUN` layers. Kept as a fallback if a `RUN` install proves brittle.
- *Global Nx install* — unnecessary; the repo drives Nx via `pnpm nx`.

## D5 — Extended egress allowlist

**Decision**: Extend 037's default-deny `init-firewall.sh` allowlist by exactly the added package sources: Rust — `crates.io`, `static.crates.io`, `index.crates.io`; Python/uv — `pypi.org`, `files.pythonhosted.org`; astral (uv/rust installer scripts) — `astral.sh` (+ its GitHub release assets, already covered by the GitHub entries); Expo/EAS — `api.expo.dev`, `exp.host`, `registry.npmjs.org` (already present). Claude plugin marketplaces are mostly GitHub (already allowed). The forge registry entry (`FORGE_REGISTRY_HOST`) is already env-injected in 037.

**Rationale**: FR-012/SC-009 — required fetches succeed, arbitrary destinations still refused. **Critical nuance (inherited 037 gotcha)**: the heavy toolchain is fetched at **image-build time**, BEFORE the runtime egress firewall exists — so crates.io/PyPI's CDN-backed, IP-rotating blob hosts are NOT a per-open firewall problem for the baked toolchain. The firewall allowlist matters only for **runtime** fetches (a `cargo add` of a new crate, a `uv add`, RTK's `cargo install --git`). This is the **strongest argument for the prebuilt image**: bake at build time (no firewall), so per-open is just the already-built image.

**Alternatives considered**:
- *Broadly relax egress* — rejected: defeats default-deny.
- *`FIREWALL_ALLOW_CDN_RANGES=1` for crates.io* — only AWS-CloudFront/Cloudflare ranges are coverable (037); crates.io uses Fastly, not covered. Not needed for the baked path; for a runtime cold `cargo install` that stalls on a blob, the documented 037 escape (`sudo iptables -P OUTPUT ACCEPT` for the pull, then re-run `init-firewall.sh`) applies.

## D6 — Personal layer delivery: a new dotfiles repo (out-of-repo)

**Decision**: The personal layer ships via a **newly scaffolded personal dotfiles repo** with an idempotent `install.sh`, wired through VS Code's **`dotfiles.repository`** *user setting* (and `--dotfiles-repository` for the headless CLI) — **not** committed to this repo. `install.sh`: (1) `cargo install --git <rtk-url> rtk` + `rtk init -g`; (2) `claude plugin install …` for the ~15 personal plugins/skills; (3) leaves service logins (Claude, `gh`, Expo) to the persisted `~/.claude` volume. Guarded to **run once** — each step is a no-op when already satisfied (e.g. `command -v rtk >/dev/null || cargo install …`; skip plugin install if the `~/.claude` volume is already populated).

**Rationale**: FR-006/FR-007/FR-008/FR-009 — the personal setup is present, persistent (via the `mcm-claude` volume), and delivered by an **out-of-repo** mechanism so the committed definition holds no personal tool/credential. Verified: `dotfiles.*` is a **per-user VS Code machine setting** (never in devcontainer.json; a `dotfiles` block in devcontainer.json is a DevPod-only extension the VS Code extension ignores), and the headless CLI honors `--dotfiles-repository/--dotfiles-install-command/--dotfiles-target-path`. The runner auto-detects `install.sh` (first of a standard set) and runs it as a post-create personalization pass. There is **no built-in idempotency** — the script owns it; guarding on the persistent `~/.claude` volume makes re-runs cheap and login-preserving.

**Alternatives considered**:
- *Bake RTK/plugins into the shared image* — rejected (FR-009/FR-010, pinned decision): personal tools/logins must not live in the committed shared artifact.
- *An existing dotfiles repo* — none to target; scaffold a new one (pinned decision).

## D7 — RTK distribution: `cargo install --git`

**Decision**: RTK is built from source in-container via `cargo install --git <rtk-repo-url> --root ~/.claude/tools rtk` in the dotfiles `install.sh` (the Rust toolchain from D4 is present), with `~/.claude/tools/bin` on PATH. `--root` targets the **persisted `~/.claude` volume** so the built binary survives container recreation. No separate release-binary channel.

**Rationale**: Matches the RTK README (`cargo install --git`) and the pinned decision. Needs Rust + crates.io/GitHub allowlisted — both already in scope (D4/D5). Keeps RTK in the **personal** layer (constitution: RTK is a machine tool, never in `package.json`/`Cargo.toml`). **Persistence is the load-bearing detail** (D3): the default `cargo install` target `~/.cargo/bin` is the container's ephemeral writable layer (not a volume — voluming it would shadow the baked cargo utilities), so RTK there would be lost on every recreate and reinstalled each open — violating FR-008/SC-007. Installing to `~/.claude/tools` (already a persistent volume) makes RTK "established once, reused"; the idempotent guard (`command -v rtk` on the PATH-added dir) then no-ops on subsequent opens. The `mcm-cargo-registry`/`mcm-rustup` volumes still make the *first* build fast on a fresh personal setup.

**Alternatives considered**:
- *Prebuilt Linux release binary* — only viable if `rtk-ai/rtk` publishes one; the README says cargo-git, so don't assume a release asset.
- *Bake RTK into the shared image* — rejected (personal layer, FR-009).

## D8 — Refresh & staleness of the prebuilt image (FR-013)

**Decision**: The forge image is refreshable on demand via a **`workflow_dispatch`** on the new `devcontainer-image.yml` (plus a scheduled/Renovate trigger when `toolchain.Dockerfile` or pinned tool versions change). The digest is the staleness signal: the gitignored `MCM_DEVCONTAINER_IMAGE` carries `…@sha256:<digest>`; a refreshed image = a new digest the developer updates locally (documented in the runbook). A developer never has to rebuild the toolchain locally to get a refresh — they re-pull the new digest.

**Rationale**: FR-013 — refreshable centrally, staleness detectable (digest mismatch), no forced local rebuild. Mirrors the app-image digest-by-git discipline (feature 023), scoped to the dev image.

**Alternatives considered**:
- *`:latest` tag only* — rejected: not reproducible; a silent upstream change can't be detected. Digest pin is the staleness contract.
- *Auto-update the local env on open* — rejected: opening should be deterministic; refresh is a deliberate, visible step.

---

## Resolved unknowns summary

| Unknown (from Technical Context) | Resolved by |
|---|---|
| How to pin the prebuilt image without committing the forge host | D2 — `build.args` `${localEnv:MCM_DEVCONTAINER_IMAGE:default}` + thin `FROM ${BASE_IMAGE}` |
| Which cache dirs to volume + ownership/shadowing pitfalls | D3 |
| Exact toolchain contents + install order | D4 |
| Which firewall entries to add; build-time vs runtime fetch | D5 |
| Personal-layer mechanism keeping the repo team-neutral | D6 |
| How RTK is obtained on Linux | D7 |
| Image refresh + staleness detection | D8 |

No `NEEDS CLARIFICATION` remain. Ready for Phase 1.
