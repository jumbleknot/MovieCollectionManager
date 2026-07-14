# HANDOFF: 038-devcontainer-full-toolchain

**State (2026-07-14) — ✅ 100% COMPLETE. All 35 tasks `[X]`.** Feature 038 merged to `main` (PR #65); the final 3 hands-on sign-offs (T020/T025/T034) were completed 2026-07-14 in the developer's VS Code dev container on the forge-digest image, and this PR (`fix/038-devcontainer-compose-v5-parity`) bakes the one durable fix that surfaced (Compose v5). Proof:
- **T020 fast startup** — host-measured: warm recreate **~17 s** with **0 image-pull + 0 rustc/cargo compile**; stop→start **0.331 s**; caches-persist + toolchain-present PASS.
- **T025 personal layer** — dotfiles `github.com/jumbleknot/mcm-dotfiles` → RTK (persisted `~/.claude/tools/bin`) + 15 plugins; `verify-personal-layer.sh` PASS; 2nd rebuild 0-reinstall; **`rtk gain` 99.0%**.
- **T034 in-container E2E** — **104/104** core web specs green vs the containerized BFF + **148** mc-service unit tests + `rtk gain` >80%.

Earlier headless validation still holds: toolchain-present, firewall-allowlist (SC-009), engine-isolation (SC-008), caches-persist (SC-005), committed-clean (SC-010). Forge git/registry auto-allowlist wired (c5373e4).

**★ T034 is a CI-PARITY provisioning task, NOT `pnpm nx e2e` (4 walls, all solved 2026-07-14 — recipe in [scratchpad `t034-e2e.sh`] + memory):** (1) DinD Compose v2.40.3 rejects the mcm stack's include-override merge that host v5.x accepts → **this PR bakes Compose v5 into the image** (interim unblock: user-scoped `~/.docker-dind/cli-plugins/docker-compose`). (2) `mc-service:latest` is a LOCAL build (`pnpm nx build mc-service`), not a pull. (3) Keycloak `password authentication failed` — DinD `/var/lib/docker` persists across rebuilds → stale baked Postgres pw; `docker volume rm keycloak-store-postgres-data` + recreate. (4) Dev Keycloak imports **no realm** on a fresh volume → use the CI path: mint self-consistent secrets → `gen-ci-env.mjs` → auth up WITH `keycloak/compose.ci.yaml` (`--import-realm` ci-realm.json, `CI_REALM_FILE`=abs) → build BFF → `up-mcm --profile app --profile bff-nonsecure` → Playwright **container** (`--network host`, `E2E_BFF_TARGET=dev-container`). **TWO parity gaps to consider as follow-ups: (a) dev Keycloak seeds no realm on a fresh volume; (b) the stacks depend on Docker-Desktop-only Compose merge behavior.**

**★ Forge-image pull (T020):** registry is HTTP on `:3000` → Docker Desktop needs `"insecure-registries":["<forge>:3000"]` + a Forgejo PAT (read:package) as the `docker login` password. VS Code Rebuild reconnect-race: `docker rm -f`s the OLD container but reconnects to that dead ID ("No such container / Not reconnecting") while the NEW `vsc-mcm-*` is Up → **Developer: Reload Window** (do not rebuild again); time recreates from host `docker events`, not VS Code's clock.

**What landed (committed surface):**
- `.devcontainer/toolchain.Dockerfile` (⊕ heavy image: Rust stable + rust-analyzer + 10 cargo utils, `uv` + Specify, `gh`, 037 base) · thin `.devcontainer/Dockerfile` (✎ `FROM ${BASE_IMAGE}`) · `devcontainer.json` (✎ `build.args` pin + 4 cache mounts + `mcm-claude` + `onCreateCommand` chown) · `init-firewall.sh` (✎ +crates/PyPI/astral/Expo).
- 5 new `verify/` scripts (toolchain-present, caches-persist, personal-layer, committed-clean, firewall-allowlist).
- `.forgejo/workflows/devcontainer-image.yml` (⊕ build→push tag+digest→surface digest) · `scripts/build-devcontainer-image.mjs` + Nx target `build-devcontainer-image` (local fallback) · runbook extended · `.gitignore` (⊕ `MCM_DEVCONTAINER_IMAGE` local env).
- **Out-of-repo (NOT committed, FR-009):** the personal dotfiles `install.sh` — authored as a template in this session's scratchpad (`dotfiles-install.sh`); drop it into your personal dotfiles repo, set `RTK_GIT_URL`, wire via VS Code `dotfiles.repository`.

**Headless-verified GREEN this session:** `verify-committed-clean.sh` (SC-010) + `secret-scan` + `topology-scrub` all pass; every shell script `bash -n` clean; `devcontainer read-configuration` resolves (`BASE_IMAGE` default + env-set digest); the new workflow YAML + `project.json` parse.

## Sign-off steps — ✅ ALL COMPLETED 2026-07-14 (kept below as the how-to record)

Prereqs (were in place): local image `mcm-devcontainer` built; `MCM_DEVCONTAINER_IMAGE` (forge `@sha256` digest) + `FORGE_REGISTRY_HOST` set on the host via `setx`; VS Code `dev.containers.mountWaylandSocket:false`; Docker Desktop `insecure-registries` for the forge `:3000`. All three below are DONE — see the completion summary + the ★ CI-parity note at the top for what actually happened.

**T020 — Fast-startup timing (SC-003/004/011).** Prove a warm recreate is a pull, not a compile.
1. Get the forge digest: on the forge, open the latest **`devcontainer-image`** workflow run (fired by the PR-#65 merge to `main`, since it touches `.devcontainer/toolchain.Dockerfile`) → its job summary prints `MCM_DEVCONTAINER_IMAGE=<host>/<ns>/mcm-devcontainer@sha256:<digest>`. (Or trigger it `workflow_dispatch`.) Note: pulling a private forge image needs `docker login <forge-registry>` on the host first.
2. Host PowerShell: `setx MCM_DEVCONTAINER_IMAGE "<the @sha256 digest ref>"` → fully quit + reopen VS Code → **Rebuild Container**.
3. **Time it**: warm recreate should be **< 90 s** with **no rustc/cargo compile** in the `docker build` log (the toolchain arrives via the pulled base image). Stop→start should be **< 15 s**. `bash .devcontainer/verify/verify-caches-persist.sh` → PASS. (The local `mcm-devcontainer` image also demonstrates "no recompile" — rebuilds are layer-cached — so timing can be sanity-checked without the forge pull if `docker login` to the forge is inconvenient.)

**T025 — Personal AI layer (SC-006/007).** Establish RTK + plugins once, persisted in the `mcm-claude` volume.
1. Create a **private personal dotfiles repo** (GitHub or the forge). Put the template `install.sh` at its root — the copy authored this session is in the scratchpad as `dotfiles-install.sh` (out-of-repo by design, FR-009).
2. In that `install.sh`, set `RTK_GIT_URL` to the RTK source repo and list your plugins in `PERSONAL_PLUGINS`.
3. VS Code **User** settings: `"dotfiles.repository": "<your-dotfiles-repo-url>"` (optionally `dotfiles.installCommand`/`targetPath`). Rebuild the container → the runner clones the dotfiles and runs `install.sh` as a post-create pass (RTK → `cargo install --git … --root ~/.claude/tools`, `rtk init -g`, plugins).
4. Verify: `bash .devcontainer/verify/verify-personal-layer.sh` (rtk gain > 80%, plugins present, logins resolve) and `rtk gain`. Rebuild again → confirm 0 reinstall / 0 re-login. Absent dotfiles → the script exits 0 with a notice (FR-014). Needs crates.io + the RTK/dotfiles git host reachable (crates.io + github.com allowlisted; forge via `FORGE_REGISTRY_HOST`).

**T034 — Final web E2E in-container (constitution per-feature gate).** Prove the real dev path still works from inside the container.
1. Bring up the app stack on the in-container **DinD** engine: `node scripts/gen-dev-secrets.mjs` → `pnpm nx up-auth infrastructure-as-code` → `pnpm nx up-mcm infrastructure-as-code` (manual ordering; see [docs/runbooks/local-dev.md](../../docs/runbooks/local-dev.md)). **First pull is slow + firewall-sensitive** — Docker Hub/quay CDN blobs may need `sudo iptables -P OUTPUT ACCEPT` for the pull then re-run `init-firewall.sh` (documented cold-pull caveat).
2. `pnpm nx e2e mcm-app` (web E2E via Playwright) → green.
3. `rtk gain` > 80% (if the personal layer from T025 is active).
Then mark T020/T025/T034 `[X]` in tasks.md and the feature is 100% done.

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
