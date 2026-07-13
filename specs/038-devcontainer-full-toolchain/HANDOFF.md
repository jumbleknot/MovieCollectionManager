# HANDOFF: 038-devcontainer-full-toolchain

**State (2026-07-12) — IMPLEMENTED (config-as-code), pending hands-on container validation.** All 8 phases authored; **28/35 tasks marked `[X]`**. The 7 remaining are exactly the **container-open / timing** tasks that need Docker Desktop on the Windows workstation (T008, T014, T020, T025, T028, T031, T034) — not headless-agent-runnable, same reality as 037. Branch `038-devcontainer-full-toolchain` (synced with `main` = fully-merged 037: PRs #61/#62/#63/#64).

**What landed (committed surface):**
- `.devcontainer/toolchain.Dockerfile` (⊕ heavy image: Rust stable + rust-analyzer + 10 cargo utils, `uv` + Specify, `gh`, 037 base) · thin `.devcontainer/Dockerfile` (✎ `FROM ${BASE_IMAGE}`) · `devcontainer.json` (✎ `build.args` pin + 4 cache mounts + `mcm-claude` + `onCreateCommand` chown) · `init-firewall.sh` (✎ +crates/PyPI/astral/Expo).
- 5 new `verify/` scripts (toolchain-present, caches-persist, personal-layer, committed-clean, firewall-allowlist).
- `.forgejo/workflows/devcontainer-image.yml` (⊕ build→push tag+digest→surface digest) · `scripts/build-devcontainer-image.mjs` + Nx target `build-devcontainer-image` (local fallback) · runbook extended · `.gitignore` (⊕ `MCM_DEVCONTAINER_IMAGE` local env).
- **Out-of-repo (NOT committed, FR-009):** the personal dotfiles `install.sh` — authored as a template in this session's scratchpad (`dotfiles-install.sh`); drop it into your personal dotfiles repo, set `RTK_GIT_URL`, wire via VS Code `dotfiles.repository`.

**Headless-verified GREEN this session:** `verify-committed-clean.sh` (SC-010) + `secret-scan` + `topology-scrub` all pass; every shell script `bash -n` clean; `devcontainer read-configuration` resolves (`BASE_IMAGE` default + env-set digest); the new workflow YAML + `project.json` parse.

**Next (hands-on, in this order):** T008 `node scripts/build-devcontainer-image.mjs` then `devcontainer up` → `whoami`=coder, `$MCM_DEVCONTAINER`=1 · T014 `verify-toolchain-present.sh` GREEN + `pnpm nx test mc-service` / `uv run` / `specify --help` · T031 apply firewall → `verify-firewall-allowlist.sh` + re-run 037 isolation · then the forge-image fast path (T019 CI run → set `MCM_DEVCONTAINER_IMAGE` digest → T020 timing) · T025 dotfiles → `verify-personal-layer.sh` · T034 final in-container E2E + `rtk gain`.

## ★★ TWO implementation discoveries (verified this session — do NOT regress)

1. **`${localEnv:VAR:default}` truncates the default at its FIRST colon** (`@devcontainers/cli` 0.87.0). A default `mcm-devcontainer:local` silently becomes `mcm-devcontainer` → `FROM` would miss the local tag. **Fix (shipped):** the local-fallback tag is **colon-free** — `mcm-devcontainer` (= :latest) — in devcontainer.json, the thin Dockerfile, AND the build script. A colon-containing **env value** (the forge `…@sha256:…` digest) passes through **intact** — only the literal default is affected. Corrected in research D2 / contract / data-model.
2. **Docker named-volume copy-up POPULATES a fresh volume from the baked dir** (experiment: fresh volume over baked `/opt/toolchain/bin` → baked file present, `coder:coder` because the image dir was pre-chowned). So D3's "starts empty and shadows" is imprecise; the real hazard is **stale-on-image-refresh** (an *existing* non-empty volume shadows a *newer* baked payload). **Consequence (shipped): `mcm-rustup` was DROPPED** — the rustup toolchain + `~/.cargo/bin` are baked and must **track the image** so a refresh (FR-013) delivers updated tools; a volume there would pin a stale toolchain for zero benefit. **Only the download caches are volumed** (`.cargo/registry`, `.cargo/git`, `.cache/uv`, pnpm store) — empty-in-image, runtime-populated, no stale-shadow. Corrected in research D3 / contract / data-model / devcontainer.json.

**Read in order**: [plan.md](plan.md) + [research.md](research.md) (the mechanism) → [tasks.md](tasks.md) (the work) → this handoff (037 pilot gotchas) → the merged feature 037 (`.devcontainer/`, [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md), [specs/037-containerized-dev-env/](../037-containerized-dev-env/) esp. tasks.md "Pilot outcome"). Private memory `project_mcm_038_devcontainer_full_toolchain` + `project_mcm_037_containerized_dev_env` have the condensed gotcha chains.

## ★★ Load-bearing implementation gotchas (from plan/research/analyze — do NOT rediscover)

- **Host-free image pin = `build.args`, NOT top-level `image`** (research D2, verified vs spec): `devcontainer.json`'s top-level `image` does NOT support `${localEnv:...}`; `build.args` DOES (+ `${localEnv:VAR:default}` default syntax). So there are **two Dockerfiles**: heavy `toolchain.Dockerfile` (CI→forge image, or local `mcm-devcontainer:local` fallback) + a thin committed `Dockerfile` (`ARG BASE_IMAGE`/`FROM ${BASE_IMAGE}`) fed by `build.args.BASE_IMAGE=${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer:local}`. Forge host stays out of git (topology-scrub).
- **Cache volumes shadow + own wrong** (D3): a named volume over an image dir starts EMPTY + SHADOWS image contents → caches are RUNTIME-populated, never baked under a mount; fresh volume is root:root → pre-`chown coder:coder` the dir in the image (copy-up carries uid 1001) + a root `onCreate` chown fallback. Set `CARGO_HOME`/`RUSTUP_HOME`/`UV_CACHE_DIR`/pnpm store-dir explicitly. Do NOT volume `~/.cargo/bin` (would shadow baked cargo utils).
- **RTK must persist in `~/.claude`** (analyze I1): install via `cargo install --git … --root ~/.claude/tools rtk` (+ `~/.claude/tools/bin` on PATH), NOT the ephemeral `~/.cargo/bin` (lost on recreate → reinstall every open, violates FR-008/SC-007). Dotfiles `install.sh` idempotent + FAIL LOUD naming a blocked source (FR-015).
- **Dotfiles = per-user VS Code setting** (`dotfiles.repository`), never in committed `devcontainer.json` → satisfies FR-009 naturally; CLI honors `--dotfiles-repository`; no built-in idempotency (script owns it, guard on the `mcm-claude` volume).

## What 038 is (one line)

Extend feature 037's isolated dev container so an in-container AI session is **as capable as native** (full toolchain: Rust + cargo utils, uv + Specify, Node/pnpm/Nx, gh; plus the personal layer: RTK, ~15 Claude plugins/skills, logins) **and starts fast** (no multi-minute reinstall per open). 037 shipped a Node+pnpm+DinD-only pilot image; 038 is "increment 2" + the personal layer + the fast-startup mechanism.

## Strategy already agreed (the two levers + the tiering — encode these in plan.md)

**Two levers kill startup time:**
1. **Prebuilt image pushed to the forge registry** — build the heavy toolchain ONCE in CI, push `jumbleknot/mcm-devcontainer:<tag>`, reference by digest in `devcontainer.json`. Fresh container = `docker pull` (~30–60s), not a 15-min Rust compile. This is the "shared registry-published base image" the 037 spec flagged as a later standardization step. Rebuild only when the toolchain changes (Renovate/weekly/manual), never per open.
2. **Persistent named volumes for every package cache** — survive container recreation so nothing re-downloads: cargo registry+git (`~/.cargo/registry`,`~/.cargo/git`), pnpm store, uv cache (`~/.cache/uv`), DinD images (`/var/lib/docker` — feature already volumes this), and **`~/.claude`** (plugins/skills, RTK hook, logins — installed once, persist forever).

**Tiering (committed team toolchain vs personal layer):**

| Tier | Contents | Mechanism | Committed? |
|---|---|---|---|
| Baked in prebuilt image | Rust stable + rust-analyzer + cargo audit/deny/outdated/machete/semver-checks/geiger/expand/bloat/mutants, uv + Specify, Node 24, pnpm, watchman, Nx, git/gh, DinD | Dockerfile layers, slow→fast for cache reuse | ✅ |
| Persistent volumes | the caches above + `~/.claude` | `mounts:` in devcontainer.json | ✅ (mount config) |
| Personal (out-of-repo) | RTK binary + `rtk init -g`, `/plugin install …` (~15 plugins), Claude/gh/Expo logins | VS Code `dotfiles.repository` → `install.sh`, guarded to run once (skip if `~/.claude` volume populated) | ❌ personal |

**Firewall allowlist additions** (037's `init-firewall.sh` is default-deny): add `crates.io`/`static.crates.io`/`index.crates.io` (Rust), `pypi.org`/`files.pythonhosted.org` (uv/Specify), Claude plugin marketplaces (mostly GitHub — already allowed), Expo/EAS endpoints. **Keep the CDN-pull caveat in mind** (see gotchas). **Android/native-mobile stays host-side** (out of scope, per 037).

## Three open decisions to pin (`/speckit-clarify` or at plan)

1. **Prebuilt-image host** — forge registry `jumbleknot/mcm-devcontainer` (recommended, same as app images)? Keep the forge host literal out of git (topology-scrub — source from env, as 037 does for `FORGE_REGISTRY_HOST`).
2. **Personal-layer delivery** — does the user have a **dotfiles repo** to target, or scaffold one? (Recommended over baking personal tools into the shared image.)
3. **RTK distribution** — does `rtk-ai/rtk` publish a **Linux release binary** (clean, GitHub-allowlisted), or is it cargo-git-only (compiles from source; needs Rust + crates.io allowlisted)? Per README it's `cargo install --git`.

## 037 pilot gotchas 038 MUST respect (hard-won — do NOT rediscover)

The 037 pilot on the REAL VS Code clone-in-volume container found a **4-blocker chain, 3 of them VS Code-on-Docker-Desktop injections invisible to headless `@devcontainers/cli`**. All are fixed on `main`; 038 must not regress them:

- **Base image Node 24** (`node:24-bookworm`) — pnpm@10.33 loads `node:sqlite` (needs Node ≥22/24); Node 20 crashes. A prebuilt image must stay ≥ Node 24.
- **No hardcoded `workspaceFolder`/`workspaceMount`** — the forge repo is named `mcm` → mounts at `/workspaces/mcm`; a hardcoded path → postCreate `chdir` exit 127. Let the runner default them.
- **VS Code Wayland mount** → user setting `"dev.containers.mountWaylandSocket": false` (Docker Desktop can't reach the `Ubuntu` distro socket). Document in the 038 runbook too.
- **VS Code `credsStore`** → `containerEnv.DOCKER_CONFIG=/home/coder/.docker-dind` so the inner DinD docker ignores the absent host-side helper (exit 255 otherwise).
- **Firewall ↔ DinD**: `init-firewall.sh` must flush ONLY INPUT/OUTPUT — never `iptables -X` / `-F FORWARD` (deletes dockerd's chains → `docker network create`/compose fails). Already fixed (#64). Reset policy to ACCEPT at script top so re-runs don't self-block.
- **Registry-pull CDN reality**: CDN-backed blob layers (Docker Hub → CloudFront, quay.io → Akamai) rotate IPs faster than a domain-resolved ipset can track; only AWS/Cloudflare ranges are coverable via `FIREWALL_ALLOW_CDN_RANGES=1`. For a **cold** stack/toolchain pull, relax egress for the pull (`sudo iptables -P OUTPUT ACCEPT`) then re-run `init-firewall.sh`, or pre-pull. **This is the strongest argument for the prebuilt image** — bake the toolchain at image-build time (no firewall), so per-open pulls are just the (already-pulled) base image.
- **First-time stack setup** (if 038 validates compose/integration): `node scripts/gen-dev-secrets.mjs` + external networks/volumes are prerequisites (per [local-dev.md](../../docs/runbooks/local-dev.md)), not container defects.

## Validation reality (same as 037)

Most acceptance is **hands-on host work** on the Windows workstation (build/pull the prebuilt image, dotfiles install, RTK compression, plugin presence, timing budgets) — not fully headless-agent-runnable. 037's verify scripts + the pilot pattern are the model. What 038 genuinely adds that 037 deferred: **Rust `cargo test` / `pnpm nx test:integration mc-service`, Python/`uv` tests, and `rtk gain`** all become runnable in-container once the toolchain + RTK land.

## Constitution / SDD notes

- Spec stays tech-agnostic (tools named as required *capabilities*; the prebuilt-image/cache-volume/dotfiles *mechanism* belongs in plan.md — mirrors how 037 kept DinD out of its spec).
- `.specify/feature.json` already points at `specs/038-devcontainer-full-toolchain`, so `/speckit-plan` etc. target 038.
- Secrets: no personal credential in the committed image or config (constitution). The personal layer is out-of-repo by design (FR-009/FR-010 of the 038 spec).
