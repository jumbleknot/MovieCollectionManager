# HANDOFF: 038-devcontainer-full-toolchain

**State**: Spec committed ([spec.md](spec.md) + [checklists/requirements.md](checklists/requirements.md), all items pass). **No plan/tasks/impl yet.** Branch `038-devcontainer-full-toolchain` (synced with `main`, which now carries the fully-merged feature 037: PRs #61/#62/#63/#64).

**Next command**: `/speckit-plan` (optionally `/speckit-clarify` first to pin the 3 open decisions below). Then `/speckit-tasks` → `/speckit-implement`.

**Read in order**: [spec.md](spec.md) → this handoff (strategy + 037 pilot gotchas) → the merged feature 037 (`.devcontainer/`, [docs/runbooks/devcontainer.md](../../docs/runbooks/devcontainer.md), [specs/037-containerized-dev-env/](../037-containerized-dev-env/) esp. tasks.md "Pilot outcome"). Private memory `project_mcm_037_containerized_dev_env` has the condensed gotcha chain.

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
