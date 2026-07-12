---
description: "Task list for 038-devcontainer-full-toolchain"
---

# Tasks: Full Developer Toolchain & Personal AI-Assistant Setup in the Dev Container

**Input**: Design documents from `specs/038-devcontainer-full-toolchain/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/devcontainer-toolchain-contract.md](contracts/devcontainer-toolchain-contract.md), [quickstart.md](quickstart.md)

**Tests**: This feature is config-as-code. Per the constitution's TDD gate, the acceptance-verification scripts under `.devcontainer/verify/` are the "tests" — each is authored **RED-first** (run before the config exists → fails), then the config makes it GREEN. They are included below. Extends 037's existing verify harness (`verify-host-isolation.sh`, `verify-engine-isolation.sh` stay unchanged and must still pass — SC-008).

**Organization**: Grouped by user story (spec priority order). MVP = User Story 1 (full toolchain present, even before it is fast). All paths are repo-root-relative.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 per spec.md
- Artifact names are behavior-descriptive; governing `FR-`/`SC-` IDs live only in in-file provenance comments (constitution — Behavior-Descriptive Identifiers).

## Path note

Artifacts live at the repo root under `.devcontainer/`, `.forgejo/workflows/`, `scripts/`, and `docs/`. There is no `src/` for this feature. The `<personal dotfiles repo>` (US3) is **out of this repo** by design (FR-009) — its task authors that separate repo's `install.sh`, never a committed file here.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Host prerequisites and the host-free image-pin plumbing every later phase depends on.

- [ ] T001 [P] Add the gitignored local env that carries `MCM_DEVCONTAINER_IMAGE` (the digest-pinned forge image ref — keeps the forge host out of git, topology-scrub) to the root `.gitignore`; document the var name + example (`…/mcm-devcontainer@sha256:<digest>`) in the runbook stub. No literal host value committed.
- [ ] T002 [P] Confirm host prereqs from 037 are present: `@devcontainers/cli` (`devcontainer --version`), Docker Desktop WSL2, VS Code Dev Containers extension. (No new host install beyond 037.)
- [ ] T003 Create/confirm the directory skeleton: `.devcontainer/verify/` exists (037); reserve `scripts/build-devcontainer-image.mjs` and `.forgejo/workflows/devcontainer-image.yml` paths.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The buildable full-toolchain **seam** — the two-Dockerfile structure + the `build.args` substitution that pins the base image host-free — so a container builds and opens as `coder`. Every user story attaches to this. Toolchain *contents* land in US1; caches in US2.

**⚠️ CRITICAL**: No user story work begins until the container builds from `${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer:local}` and opens as non-root `coder`.

- [ ] T004 Author `.devcontainer/toolchain.Dockerfile` scaffold: `FROM node:24-bookworm`, port 037's base setup (apt deps `git build-essential curl ca-certificates unzip sudo iptables ipset dnsutils iproute2 jq`, watchman install, `corepack enable && npm i -g @anthropic-ai/claude-code`, non-root `coder` uid 1001 + NOPASSWD sudo, `/commandhistory` + `.docker-dind` dirs). This is the image the CI job (US2) and the local fallback build. No toolchain installs yet, no secrets (FR-010).
- [ ] T005 Author the thin `.devcontainer/Dockerfile`: `ARG BASE_IMAGE=mcm-devcontainer:local` / `FROM ${BASE_IMAGE}` only — its sole job is to let `devcontainer.json` parametrize the base via `build.args` (top-level `image` is NOT substitution-eligible — research D2). In-file comment records why.
- [ ] T006 Rewire `.devcontainer/devcontainer.json` `build`: `{ "dockerfile": "Dockerfile", "args": { "BASE_IMAGE": "${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer:local}" } }`; keep 037's `features`(DinD), `remoteUser`, `containerEnv`(marker + `DOCKER_CONFIG`), `forwardPorts`, `postStartCommand`(firewall), and the omitted `workspaceFolder`/`workspaceMount` (037 exit-127 gotcha). No forge host literal.
- [ ] T007 Author `scripts/build-devcontainer-image.mjs` (+ an Nx target `build-devcontainer-image` on `infrastructure-as-code`): `docker build -f .devcontainer/toolchain.Dockerfile -t mcm-devcontainer:local .` — the offline/no-forge one-time fallback that makes the `BASE_IMAGE` default resolve (research D2, SC-011).
- [ ] T008 Smoke-verify the foundation: `node scripts/build-devcontainer-image.mjs` then `devcontainer up`; confirm the shell opens, `whoami` → `coder`, `echo $MCM_DEVCONTAINER` → `1`. (Note cold build time for the SC-011 one-time baseline.)

**Checkpoint**: Buildable non-root container from the host-free image seam — user stories can begin.

---

## Phase 3: User Story 1 — Full team toolchain present in-container (Priority: P1) 🎯 MVP

**Goal**: Rust + cargo utilities, `uv` + Specify CLI, Node 24 / pnpm / Nx, and `gh` are all on the command path at container start; every language layer builds/lints/tests and the SDD commands run with no host fallback.

**Independent Test**: `devcontainer exec … bash .devcontainer/verify/verify-toolchain-present.sh` exits 0; `pnpm nx test mc-service`, a `uv` Python check, and `specify --help` all succeed in-container.

### Tests for User Story 1 (RED-first) ⚠️

- [ ] T009 [P] [US1] Author `.devcontainer/verify/verify-toolchain-present.sh` (governs SC-001/SC-002): assert `rustc cargo rustfmt clippy rust-analyzer cargo-audit cargo-deny cargo-outdated cargo-machete cargo-semver-checks cargo-geiger cargo-expand cargo-bloat cargo-mutants cargo-tarpaulin uv uvx specify pnpm gh` all resolve on PATH and print a version, plus `pnpm nx --version`. Run now → **RED** (rustc/uv/gh missing). Behavior-descriptive name; SC IDs in a provenance comment.

### Implementation for User Story 1

- [ ] T010 [US1] In `.devcontainer/toolchain.Dockerfile`, install the Rust layer (slow→fast for cache reuse): rustup stable toolchain + `rustfmt`/`clippy` components + `rust-analyzer`, set `RUSTUP_HOME`/`CARGO_HOME` (paths used by US2 cache volumes). (FR-001)
- [ ] T011 [US1] In `.devcontainer/toolchain.Dockerfile`, install the cargo utility set the repo's quality/security gates use: `cargo-audit cargo-deny cargo-outdated cargo-machete cargo-semver-checks cargo-geiger cargo-expand cargo-bloat cargo-mutants cargo-tarpaulin` (features 033/034/035; constitution tarpaulin coverage). Order after T010 so the toolchain layer caches. (FR-001/FR-002)
- [ ] T012 [P] [US1] In `.devcontainer/toolchain.Dockerfile`, install `uv` (astral) and the Specify CLI via `uv tool install`; ensure `uv`/`uvx`/`specify` on PATH. (FR-001 — Python + SDD)
- [ ] T013 [P] [US1] In `.devcontainer/toolchain.Dockerfile`, install `gh` (GitHub CLI, official apt repo). (FR-001)
- [ ] T014 [US1] Rebuild the local image (T007) and run `verify-toolchain-present.sh` → **GREEN**; then prove no host fallback: `pnpm nx test mc-service`, `pnpm nx lint mcm-app`, `uv run python -c "print(1)"`, `specify --help` all succeed in-container. (SC-001/SC-002)

**Checkpoint**: MVP — a complete in-container workshop (all three language layers + SDD), even if first build is slow. Deliverable value even if nothing else ships.

---

## Phase 4: User Story 2 — Fast startup, nothing re-installed each time (Priority: P1)

**Goal**: Warm recreate < 90 s with 0 re-compile/re-download; caches survive recreation; the heavy toolchain is amortized via a prebuilt forge image pulled per-open.

**Independent Test**: recreate the container → ready < 90 s, `docker build` shows no Rust/tool compile; `verify-caches-persist.sh` exits 0; stop→start < 15 s.

**Depends on US1** (the prebuilt image must contain the toolchain from T010–T013; cargo caches need Rust present).

### Tests for User Story 2 (RED-first) ⚠️

- [ ] T015 [P] [US2] Author `.devcontainer/verify/verify-caches-persist.sh` (governs SC-005): after a recreate, assert the cache named volumes are mounted and a `cargo`/`pnpm`/`uv` install reports cache hits / 0 full re-downloads of already-cached packages. Run now → **RED** (no cache volumes mounted). Provenance comment for SC-005.

### Implementation for User Story 2

- [ ] T016 [US2] In `.devcontainer/toolchain.Dockerfile`, set the cache-home env explicitly (`CARGO_HOME=/home/coder/.cargo`, `RUSTUP_HOME=/home/coder/.rustup`, `UV_CACHE_DIR=/home/coder/.cache/uv`, pnpm `store-dir`) and **pre-create + `chown coder:coder`** each cache-dir target BEFORE any volume mounts, so Docker's empty-volume copy-up grants uid-1001 ownership (research D3 shadowing/ownership gotcha).
- [ ] T017 [US2] Add the persistent cache mounts to `.devcontainer/devcontainer.json` `mounts`: `mcm-cargo-registry`→`~/.cargo/registry`, `mcm-cargo-git`→`~/.cargo/git`, `mcm-rustup`→`~/.rustup`, `mcm-uv-cache`→`~/.cache/uv`, `mcm-pnpm-store`→`~/.local/share/pnpm/store` (alongside 037's `mcm-commandhistory`). (FR-004)
- [ ] T018 [US2] Add a root-run `onCreateCommand` (or first-line of `postCreateCommand`) `chown -R coder:coder` fallback over the cache mount targets — repairs a pre-existing root-owned volume (belt-and-suspenders for the copy-up gotcha, research D3).
- [ ] T019 [US2] Author `.forgejo/workflows/devcontainer-image.yml`: `workflow_dispatch` + push-path trigger on `.devcontainer/toolchain.Dockerfile` (+ optional weekly cron, FR-013); `runs-on: kvm`; `docker build -f .devcontainer/toolchain.Dockerfile -t ${REGISTRY}/${NS}/mcm-devcontainer:<tag> .` → push → capture `@sha256:` digest → surface it in the job summary. Host-free `REGISTRY`/`NS`/`REGISTRY_USER` Forgejo vars; no `${{ secrets }}` host literal (contract §B).
- [ ] T020 [US2] Verify the fast path: set `MCM_DEVCONTAINER_IMAGE` to the pushed digest, recreate → run `verify-caches-persist.sh` **GREEN**; **time** warm recreate < 90 s with 0 toolchain re-compile (SC-003) and stop→start < 15 s (SC-004). Confirm the first-provision cost does not recur on subsequent opens (SC-011).

**Checkpoint**: The full-toolchain container is fast enough for daily use — US1 + US2 together are the adoption bar.

---

## Phase 5: User Story 3 — Personal AI-assistant setup present and persistent (Priority: P2)

**Goal**: RTK compression active, personal plugins/skills present, service logins persist — established once, reused every open, via an out-of-repo dotfiles mechanism.

**Independent Test**: `verify-personal-layer.sh` exits 0 — `rtk gain` > 80%, expected plugins listed, still logged in; recreate → none redone. With no personal layer configured, the script exits 0 with an "absent" notice and the container is still team-capable.

### Tests for User Story 3 (RED-first) ⚠️

- [ ] T021 [P] [US3] Author `.devcontainer/verify/verify-personal-layer.sh` (governs SC-006/SC-007): assert `rtk gain` > 80% on the standard command set, the expected plugin/skill set is present, and logins resolve without a re-auth prompt; **exit 0 with a clear "personal layer absent" notice when unconfigured** (FR-014). Run now → **RED** (RTK/plugins absent). Provenance comment for SC-006/SC-007.

### Implementation for User Story 3

- [ ] T022 [US3] Add the personal persistence mount to `.devcontainer/devcontainer.json` `mounts`: `mcm-claude`→`/home/coder/.claude` (plugins/skills, RTK hook, logins survive recreation — FR-007). Pre-create + chown `~/.claude` in `toolchain.Dockerfile`.
- [ ] T023 [US3] Author the **out-of-repo** personal dotfiles repo's `install.sh` (NOT committed here — FR-009): idempotent — `command -v rtk >/dev/null || cargo install --git <rtk-repo> --root ~/.claude/tools rtk` (install into the **persisted `~/.claude` volume**, not the ephemeral `~/.cargo/bin`, so RTK survives recreate — research D7/D3; add `~/.claude/tools/bin` to PATH) + `rtk init -g`; `claude plugin install …` for the personal set, guarded/skipped if `~/.claude` already populated; leave logins to the persisted volume. Guard makes re-runs cheap + login-preserving (FR-008) and never blocks start (FR-014). **Fail loud on a blocked/unreachable source**: wrap the RTK/plugin fetches so a network/firewall failure exits non-zero with a message naming the unreachable source (crates.io / GitHub / marketplace) rather than silently continuing (FR-015).
- [ ] T024 [US3] Document the delivery seam in `docs/runbooks/devcontainer.md`: set the VS Code user setting `dotfiles.repository` (+ `dotfiles.installCommand`/`targetPath`) or the CLI `--dotfiles-repository` flag; note it is a per-user setting, never in the committed `devcontainer.json` (FR-009). No personal repo URL committed as a project literal.
- [ ] T025 [US3] With the dotfiles repo configured, recreate the container and run `verify-personal-layer.sh` → **GREEN** (`rtk gain` > 80%, plugins present); recreate again → confirm 0 re-install / 0 re-login (SC-006/SC-007). Separately confirm the absent-layer skip path (unset dotfiles → exit 0 notice, toolchain still works).

**Checkpoint**: The in-container assistant is as capable and economical as the native one, and persistent.

---

## Phase 6: User Story 4 — Committed team toolchain vs personal setup cleanly separated (Priority: P2)

**Goal**: The committed `.devcontainer/` carries the shared toolchain but zero personal tools/plugins/credentials; the personal layer applies from outside the repo; a second person gets a working team container without the personal conveniences.

**Independent Test**: review + gates show 0 personal entries / 0 secrets / no forge host literal in committed config; opening without the dotfiles mechanism yields a full team toolchain with only personal niceties absent.

### Tests for User Story 4 (verification) ⚠️

- [ ] T026 [P] [US4] Author `.devcontainer/verify/verify-committed-clean.sh` (governs SC-010): assert `.devcontainer/` contains no `dotfiles.repository`/`rtk`/`plugin install`/personal-plugin list, no credential, and no forge host literal (`MCM_DEVCONTAINER_IMAGE` referenced only as `${localEnv:…}`). Run now → passes only after the config is clean; wire it to run the existing `scripts/secret-scan.mjs` + `scripts/check-topology-scrub.mjs` over the tree.

### Implementation for User Story 4

- [ ] T027 [US4] Audit + fix the committed definition: confirm `devcontainer.json`/`Dockerfile`/`toolchain.Dockerfile`/`init-firewall.sh` hold no `dotfiles.*` key, no personal tool, no credential, no forge host literal; run `verify-committed-clean.sh` + `secret-scan` + `check-topology-scrub` → all clean (SC-010).
- [ ] T028 [US4] Second-person parity check: open the committed container **without** setting `dotfiles.repository` / `MCM_DEVCONTAINER_IMAGE` (default local fallback) → confirm the team toolchain works and only the personal layer is absent (FR-014, spec US4 scenario 2).

**Checkpoint**: The repo config is team-neutral and secret-free; the personal layer is provably out-of-repo.

---

## Phase 7: User Story 5 — Stays within the 037 security posture (Priority: P3)

**Goal**: Adding the toolchain/personal setup doesn't weaken 037's isolation; the egress firewall is extended by exactly the added package sources and still refuses everything else.

**Independent Test**: `verify-firewall-allowlist.sh` exits 0 (crates/PyPI/Expo reachable, arbitrary host refused); 037's `verify-host-isolation.sh` + `verify-engine-isolation.sh` still exit 0.

### Tests for User Story 5 (RED-first) ⚠️

- [ ] T029 [P] [US5] Author `.devcontainer/verify/verify-firewall-allowlist.sh` (governs SC-009): assert a fetch to crates.io + pypi.org + api.expo.dev succeeds and a fetch to an arbitrary non-allowlisted host is refused/timed out. Run now → **RED** (crates/PyPI/Expo not yet allowlisted). Provenance comment for SC-009.

### Implementation for User Story 5

- [ ] T030 [US5] Extend `.devcontainer/init-firewall.sh` `ALLOWED_DOMAINS`: add `crates.io static.crates.io index.crates.io` (Rust), `pypi.org files.pythonhosted.org` (uv/Specify), `astral.sh` (installer), `api.expo.dev exp.host` (Expo/EAS). Keep all 037 clauses unchanged (flush only INPUT/OUTPUT, never `-X`/`-F FORWARD`; reset policy ACCEPT at top; `FORGE_REGISTRY_HOST` env-injected; re-runnable). Add the build-time-vs-runtime note (baked toolchain fetched pre-firewall — research D5). (FR-012)
- [ ] T031 [US5] Run `verify-firewall-allowlist.sh` → **GREEN**; then re-run 037's `verify-host-isolation.sh` and `verify-engine-isolation.sh` → both still exit 0 (SC-008, isolation unchanged).

**Checkpoint**: Full toolchain + personal layer land with 037's isolation intact and egress still default-deny.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, refresh workflow, and final in-container validation.

- [ ] T032 [P] Extend `docs/runbooks/devcontainer.md`: the full toolchain, the cache-volume model, the `MCM_DEVCONTAINER_IMAGE` env + digest-refresh (FR-013) flow, the dotfiles seam, and carry forward 037's Wayland-socket + `credsStore`/`DOCKER_CONFIG` reminders.
- [ ] T033 [P] Update `specs/038-devcontainer-full-toolchain/HANDOFF.md` (state → implemented) and the private-memory pointer; note the prebuilt-image refresh cadence.
- [ ] T034 Run the `quickstart.md` final validation **inside the container**: `pnpm nx e2e mcm-app` (web E2E — real dev path), `pnpm nx test mc-service && pnpm nx test:integration mc-service` (Rust, newly in-container), `rtk gain` > 80% — the constitution's per-feature E2E + RTK gate.
- [ ] T035 [P] Confirm `.devcontainer/devcontainer-lock.json` still pins the DinD feature digest; refresh only if the feature is intentionally bumped.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: depends on Setup — BLOCKS all user stories (the buildable image seam).
- **US1 (Phase 3)**: depends on Foundational. 🎯 MVP.
- **US2 (Phase 4)**: depends on **US1** (the prebuilt image must contain the toolchain; cargo caches need Rust). Both P1.
- **US3 (Phase 5)**: depends on Foundational; best after US2 (uses the `~/.claude` volume + Rust for RTK). P2.
- **US4 (Phase 6)**: depends on the config existing (US1–US3 authored) — it audits the committed surface. P2.
- **US5 (Phase 7)**: depends on Foundational; independent of US1–US4 in mechanism (firewall), but validated last so SC-008 covers the final config. P3.
- **Polish (Phase 8)**: after all desired stories.

### Within Each User Story

- The RED-first verify script is authored and run (fails) BEFORE the config that makes it GREEN.
- Dockerfile toolchain layers ordered slow→fast for cache reuse.
- `toolchain.Dockerfile` changes (content) precede the CI prebuild (US2 T019).

### Parallel Opportunities

- Setup: T001, T002 in parallel.
- US1: T012 (uv) + T013 (gh) in parallel after the Rust layer (T010→T011) lands; the verify script T009 authored in parallel with any of them.
- US2: the verify script T015 in parallel with T016.
- Verify-script authoring across stories (T009, T015, T021, T026, T029) touches different files → parallelizable up front.
- Polish: T032, T033, T035 in parallel.

---

## Parallel Example: User Story 1

```bash
# After the Rust layer (T010 → T011) lands, add the independent toolchain layers together:
Task: "T012 [US1] Install uv + Specify CLI in .devcontainer/toolchain.Dockerfile"
Task: "T013 [US1] Install gh (GitHub CLI) in .devcontainer/toolchain.Dockerfile"
# The RED-first verify script can be authored up front, in parallel:
Task: "T009 [US1] Author .devcontainer/verify/verify-toolchain-present.sh"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 Setup → Phase 2 Foundational (the buildable image seam).
2. Phase 3 US1 → **STOP and VALIDATE**: full toolchain present, all three layers + SDD run in-container (even if the first build is slow).
3. This alone makes the container a complete workshop.

### Incremental Delivery

1. Setup + Foundational → buildable full-toolchain container.
2. US1 → complete in-container toolchain (MVP).
3. US2 → fast (prebuilt image + caches) — the daily-use bar.
4. US3 → personal layer (RTK/plugins/logins).
5. US4 → prove the committed/personal separation.
6. US5 → firewall extension + 037 isolation re-proof.
7. Polish → docs, refresh flow, final in-container E2E + RTK gate.

---

## Notes

- [P] = different files, no dependency on an incomplete task.
- The personal dotfiles `install.sh` (T023) is authored in a SEPARATE, out-of-repo repository — never committed here (FR-009). Every other artifact is repo-root-relative.
- Commit after each task or logical group; keep the forge host + any personal repo URL out of committed files (topology-scrub).
- Most timing/hands-on acceptance (SC-003/004/006/007/011) is host-side workstation work, mirroring 037; the newly headless-runnable pieces are the Rust/`uv` builds and `rtk gain`.
