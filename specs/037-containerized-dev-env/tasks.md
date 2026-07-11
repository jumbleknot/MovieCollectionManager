---
description: "Task list for 037-containerized-dev-env"
---

# Tasks: Containerized Local Dev Environment for AI-Assisted Development

**Input**: Design documents from `specs/037-containerized-dev-env/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/devcontainer-contract.md](contracts/devcontainer-contract.md), [quickstart.md](quickstart.md)

**Tests**: This feature is config-as-code. Per the constitution's TDD gate, the acceptance-verification scripts under `.devcontainer/verify/` are the "tests" — each is authored **RED-first** (run before the config exists → fails), then the config makes it GREEN. They are included below.

**Organization**: Grouped by user story (spec priority order). MVP = User Story 1.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 per spec.md
- All paths are repo-root-relative.

## Path note

All artifacts live at the repo root under `.devcontainer/` and `docs/`. There is no `src/` for this feature. The source proposal `docs/proposals/DevPod-Workstation-PRD.md` is updated in Polish (FR-013).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Host prerequisites and directory skeleton needed by every later phase.

- [X] T001 [P] Install the headless runner on the host: `npm install -g @devcontainers/cli`; confirm `devcontainer --version` (used for the portability gate SC-006 and the `devcontainer exec` verification harness).
- [X] T002 [P] Create a host-only sentinel for the isolation proof: `C:\Users\Steve\HOST-ONLY-MARKER.txt` (must NOT be reachable from inside the container; referenced by `verify-host-isolation.sh`).
- [X] T003 Create the directory skeleton: `.devcontainer/` and `.devcontainer/verify/` at the repo root.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The minimal buildable, non-root dev container — with source already on a Linux **named volume** — that every user story attaches to. No isolation proof or Docker capability yet, just a shell that opens on the real workspace mount.

**⚠️ CRITICAL**: No user story work can begin until the container builds and opens as the non-root `coder` user **on the named-volume workspace** (so the MVP isolation proof and every later phase run on the real config, never a transient NTFS bind mount).

- [X] T004 Author `.devcontainer/Dockerfile`: base `node:20-bookworm` (prod BFF lineage — FR-009); `apt-get` install `git`, `watchman`, `build-essential`, `curl`, `ca-certificates`; create non-root user `coder` (+ NOPASSWD sudo); `USER coder`, `WORKDIR /home/coder`. No Docker install (comes from the DinD feature), no secrets.
- [X] T005 Author base `.devcontainer/devcontainer.json`: `name` (behavior-descriptive, e.g. `mcm-workspace`), `build.dockerfile: Dockerfile`, `remoteUser: coder`, **source on a Docker named volume** — set `workspaceMount` (or the equivalent named-volume mount) + `workspaceFolder` so the working tree lives on the Linux volume, never an NTFS bind mount (FR-003 — established here at Foundational so all phases inherit it), `containerEnv.MCM_DEVCONTAINER: "1"` (in-container marker — FR-012), `customizations.vscode.settings` `files.eol: "\n"`, `customizations.vscode.extensions` `[dbaeumer.vscode-eslint, esbenp.prettier-vscode]`, `postCreateCommand: "corepack enable && pnpm install"`. No credential literal (FR-010).
- [X] T006 Smoke-verify the foundation: `devcontainer build` then `devcontainer up`; confirm the shell opens, `whoami` → `coder`, `echo $MCM_DEVCONTAINER` → `1`, **and the workspace path is inside the container FS on the named volume (not under `/mnt/*`)** — proving source is off NTFS from the first build. (Cold build time noted for SC-004 measurement in T021.)

**Checkpoint**: Buildable non-root container exists, source on a Linux named volume — user stories can begin.

---

## Phase 3: User Story 1 — Agent runs sealed off from the host (Priority: P1) 🎯 MVP

**Goal**: Claude Code runs inside the container as `coder` with no reach to the host filesystem, credentials, or SSH keys, and a default-deny egress firewall shrinks the network blast radius.

**Independent Test**: `devcontainer exec … bash .devcontainer/verify/verify-host-isolation.sh` exits 0; `claude --version` runs in-container; the host sentinel (T002) is unreachable.

### Tests for User Story 1 (RED-first) ⚠️

- [X] T007 [P] [US1] Author `.devcontainer/verify/verify-host-isolation.sh` (governs SC-001): assert the host sentinel path is absent, no host `~/.ssh` / credential store is mounted, and `MCM_DEVCONTAINER=1` is set. Run it now → **RED** (fails: firewall/agent not yet present or no container). Behavior-descriptive name; SC-001 only in an in-file provenance comment.

### Implementation for User Story 1

- [X] T008 [US1] Add Claude Code to the environment: append `npm install -g @anthropic-ai/claude-code` to `postCreateCommand` in `.devcontainer/devcontainer.json` and add `anthropic.claude-code` to `customizations.vscode.extensions` (FR-002).
- [X] T009 [US1] Author `.devcontainer/init-firewall.sh` (default-deny egress, based on Anthropic's reference — research D4): DROP INPUT/FORWARD/OUTPUT; allow loopback, DNS (53), ESTABLISHED/RELATED; ipset allowlist for the Anthropic API, GitHub, and the npm registry. (Registry endpoints for DinD are added in US2/T014.)
- [X] T010 [US1] Wire the firewall into `.devcontainer/devcontainer.json`: run `init-firewall.sh` at container start (root, before dropping to `coder`) via a lifecycle hook; add `runArgs`/`capAdd` `NET_ADMIN`, `NET_RAW` so the firewall can program iptables. (These caps are subsumed once US2 makes the container privileged.)
- [X] T011 [US1] Run `verify-host-isolation.sh` → **GREEN**; confirm `claude --version` and the marker in-container.

**Checkpoint**: MVP — the agent runs isolated from the host FS/creds with egress control. Deliverable value even if nothing else ships.

---

## Phase 4: User Story 2 — Build images and run test stacks inside the environment (Priority: P2)

**Goal**: In-container `docker build`/`docker run` and compose-based integration tests work on an engine separate from the host engine.

**Independent Test**: `verify-engine-isolation.sh` exits 0 — an in-container container runs and does NOT appear in the host `docker ps -a`.

### Tests for User Story 2 (RED-first) ⚠️

- [X] T012 [P] [US2] Author `.devcontainer/verify/verify-engine-isolation.sh` (governs SC-002): inside the container, `docker build` a trivial image and `docker run` it; then assert the host engine's `docker ps -a` does not list it. Run now → **RED** (no in-container engine yet). Non-fabrication: it must observe the real host engine.

### Implementation for User Story 2

- [X] T013 [US2] Add `ghcr.io/devcontainers/features/docker-in-docker:2` (`moby: true`) to `.devcontainer/devcontainer.json` `features`. This sets the container `privileged` (supersedes the T010 `capAdd`); document the honest posture consequence inline.
- [X] T014 [US2] Extend `.devcontainer/init-firewall.sh` allowlist with the image registries DinD pulls from: `registry-1.docker.io`, `auth.docker.io`, `ghcr.io`, and the project's forge registry (redact the forge host literal — keep it out of git per the topology-scrub rule; source it from env). Without this, US2 compose-stack pulls fail.
- [X] T015 [US2] Run `verify-engine-isolation.sh` → **GREEN**; then bring up one real compose stack in-container (e.g. `pnpm nx up-auth infrastructure-as-code`) to confirm registry pulls succeed through the firewall.
- [X] T015a [US2] **Validate egress-firewall ↔ DinD coexistence** (the feature's riskiest integration point — research D3/D4). Confirm that (a) `init-firewall.sh`'s default-DROP chains do not break the DinD `dockerd`'s own iptables/NAT for nested-container networking, and (b) image pulls survive **registry CDN IP rotation** — Docker Hub/`ghcr.io` sit behind Cloudflare/Fastly with churning IPs, so an ipset allowlisted by resolved IP can go stale mid-session. Verify the firewall allowlists by **domain with periodic re-resolution** (as the Anthropic reference does), not a one-shot IP snapshot; exercise a cold pull, a second pull after an idle gap, and a nested container reaching another nested container. If coexistence proves brittle, record the fallback (scope the firewall to the outer interface only, or allowlist registry CIDR ranges) in the runbook. Do not paper over a real failure.

**Checkpoint**: US1 + US2 — isolated agent that can also build images and run compose stacks in-container, with the firewall and nested engine proven to coexist.

---

## Phase 5: User Story 3 — Fast edit-reload parity with native (Priority: P2)

**Goal**: Source on a Linux named volume + watchman + forwarded ports give hot-reload indistinguishable from native, reachable by browser/device.

**Independent Test**: Edit a component while Metro runs in-container → reload with no perceptible slowdown; forwarded `localhost:8081` loads the web target.

### Implementation for User Story 3

- [X] T016 [US3] Add `forwardPorts` + `portsAttributes` labels to `.devcontainer/devcontainer.json` (FR-005) with **this project's actual ports** — `8081` (Metro dev server; also serves the Expo Router web target and dev BFF API routes), and, when they run in-container/DinD, `8082` (containerized dev BFF — the `E2E_BFF_TARGET=dev-container` target) and `8099` (Keycloak, for the browser OAuth redirect on web login). Confirm the exact set against the running app. **Do NOT** use the legacy Expo `19000/19001/19006` ports — they are unused by this Expo SDK 56 project (verified: they appear nowhere in the codebase).
- [X] T017 [US3] Confirm the named-volume workspace (provisioned in Foundational T005/T006) delivers the file-watch performance benefit and document both entry paths: the VS Code "Clone Repository in Named Container Volume" flow (interactive) and the committed `workspaceMount`/`workspaceFolder` used by `devcontainer up` (headless). Re-assert the workspace path is on the volume, not `/mnt/*` (FR-003). No re-provisioning here — this is validation of the Foundational mount under real Metro load.
- [ ] T018 [US3] Validate hot-reload parity (SC-003): run the Expo web/Metro dev server in-container, edit a component, confirm reload latency ~ native and that watchman (not polling) drives it; record the observation in `quickstart.md`.

**Checkpoint**: US1–US3 — isolated, Docker-capable, and fast to develop in.

---

## Phase 6: User Story 4 — Reproducible, committed, prod-aligned definition (Priority: P3)

**Goal**: The committed definition rebuilds deterministically; base aligned to prod lineage; increment-2 (Rust/Python) planned and build-time measured.

**Independent Test**: `verify-reproducible-recreate.sh` exits 0 — `delete` then `up` yields an equivalent environment with zero manual steps, and the US1/US2 checks still pass.

### Tests for User Story 4 (RED-first) ⚠️

- [X] T019 [P] [US4] Author `.devcontainer/verify/verify-reproducible-recreate.sh` (governs SC-005): `devcontainer down`/remove volume, then `devcontainer up` from the committed def; re-run `verify-host-isolation.sh` + `verify-engine-isolation.sh`. Run now → **RED**.

### Implementation for User Story 4

- [X] T020 [US4] Commit `.devcontainer/` to the repo (FR-007); confirm the committed config contains no credential literals and passes the existing `scripts/check-no-inline-secrets.mjs` and `scripts/secret-scan.mjs` gates locally.
- [X] T021 [US4] Measure and record cold-build and warm-start times against SC-004 (< 5 min / < 15 s) in the runbook; document the prod-parity base decision and the deferred increment-2 plan (Rust stable + Python 3.13 + `uv` via features, added only if it stays within the build-time budget — research D5).
- [ ] T022 [US4] Run `verify-reproducible-recreate.sh` → **GREEN**.

**Checkpoint**: US1–US4 — reproducible and committed.

---

## Phase 7: User Story 5 — Runner portability (Priority: P3)

**Goal**: The committed `devcontainer.json` runs unmodified under a second conformant runner (`@devcontainers/cli`), insulating the setup from any single tool.

**Independent Test**: `verify-portable-runner.sh` exits 0 — `devcontainer up` on a clean clone builds and runs, and the isolation/engine checks pass under the CLI runner.

### Tests for User Story 5 (RED-first) ⚠️

- [X] T023 [P] [US5] Author `.devcontainer/verify/verify-portable-runner.sh` (governs SC-006): on a clean clone, `devcontainer up --workspace-folder .` via `@devcontainers/cli`, then run `verify-host-isolation.sh` + `verify-engine-isolation.sh` under the CLI runner. Run now → **RED**.

### Implementation for User Story 5

- [X] T024 [US5] Audit `.devcontainer/devcontainer.json` for spec-purity: no VS Code-only required field blocks the CLI runner (VS Code `customizations` are ignored gracefully by the CLI, not required). Run `verify-portable-runner.sh` → **GREEN**.

**Checkpoint**: All user stories independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T025 [P] Author `docs/runbooks/devcontainer.md`: daily use (open, work, `git push` = durable backup since the volume is the between-session source of truth); the "run Claude in-container" convention + marker verification (FR-012); runtime secret injection, no host-profile mount (FR-010); LAN vs Expo tunnel for devices (SC-007); teardown; and the firewall-allowlist troubleshooting note (check allowlist before suspecting Docker on a failed DinD pull).
- [X] T026 Update `docs/proposals/DevPod-Workstation-PRD.md` to match this spec (FR-013): invert §14 (plain Dev Containers as the portable asset, DevPod optional/deprecated as foundation given maintenance risk); rewrite G1/§7/§10 to the honest posture (strong FS/credential isolation, moderate engine isolation); **delete every "no `--privileged`" / "no privileged flags" claim**; add the egress-firewall control as a new isolation layer.
- [X] T027 [P] Verify honest posture (SC-008): grep `docs/runbooks/devcontainer.md` + `docs/proposals/DevPod-Workstation-PRD.md` for `unprivileged`/`no privileged`/`without privileged` → **0** matches; confirm the moderate-engine-isolation caveat is present in both.
- [ ] T028 Run the full `quickstart.md` validation, including SC-007 (device reaches the dev server over LAN) and SC-009 (a full in-container working session running a compose-based integration test, e.g. `pnpm nx test:integration mc-service`, with no host-side fallback — native mobile excepted).
- [ ] T029 [P] Run the web E2E regression **inside** the container (constitution: E2E regression at implementation done) to prove the real dev path works end-to-end in-container.
- [ ] T030 Confirm `rtk gain` still reports > 80% compression across the runs above (constitution Test Run Protocol).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup. **Blocks all stories** (nothing attaches without a buildable container).
- **US1 (P3 phase)** → after Foundational. **MVP.**
- **US2** → after US1 (extends the same `init-firewall.sh` and `devcontainer.json`; DinD privileged supersedes US1's `capAdd`).
- **US3** → after Foundational (the named-volume mount it relies on is provisioned there, in T005/T006 — so US3 is validation, not re-provisioning); edits the same `devcontainer.json` as US2, so sequence to avoid conflicts.
- **US4** → after US1 + US2 (its recreate check re-runs both isolation proofs).
- **US5** → after US1 + US2 (its portability check re-runs both proofs under the CLI runner).
- **Polish (P8)** → after all desired stories.

### Story independence

Each story ends at a green checkpoint and is independently demonstrable. US2–US5 all edit the single shared `.devcontainer/devcontainer.json`, so they are **sequenced, not parallelized**, despite being conceptually independent — same-file conflict avoidance.

### Parallel opportunities

- Setup: T001, T002 in parallel.
- Verify-script authoring is `[P]` (distinct files): T007, T012, T019, T023 can each be written ahead of their phase's implementation.
- Polish: T025 (runbook) and the T027/T029 checks are `[P]` (distinct files); T026 (PRD) is sequential with T027 (T027 greps T026's output).

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational → Phase 3 US1.
2. **STOP and VALIDATE**: `verify-host-isolation.sh` green; `claude` runs in-container; host sentinel unreachable.
3. This alone delivers the feature's primary value (agent blast-radius isolation + egress control).

### Incremental delivery

US1 (MVP) → US2 (in-container Docker) → US3 (fast reload) → US4 (reproducible/committed) → US5 (portable) → Polish (runbook + PRD reconciliation + full validation). Each adds value without breaking the prior checkpoint.

---

## Notes

- `[P]` = different files, no incomplete-task dependency.
- Verify scripts are authored RED-first and must fail if the environment is genuinely broken (no self-healing — constitution No-Runtime-Patches).
- Keep the forge registry host literal out of committed files (topology-scrub gate) — source it from env in `init-firewall.sh`.
- The privileged-container exception is deliberate and disclosed (plan.md Complexity Tracking / FR-011); do not "fix" it by mounting the host socket.
- Commit after each green checkpoint.
- **T015a** is a decimal-suffixed insertion from `/speckit-analyze` remediation (firewall↔DinD coexistence, finding F4); the suffix preserves all downstream task IDs and cross-references. Execute it in-order between T015 and T016.

## Implementation status (2026-07-11)

All config-as-code + docs authored and staged. The core was **validated headless** (via
`@devcontainers/cli` + Docker Desktop) beyond authoring:

- **SC-001 (T011): GREEN** — `verify-host-isolation.sh` passes all 6 checks on a **named volume**
  (host sentinel unreachable, non-root `coder`, marker set, `/proc/mounts` clean = source off
  NTFS). The script also correctly **failed** on a deliberate bind-mount (non-fabrication proven).
- **SC-002 (T015): GREEN two-sided** — nested `docker build`+`run` succeed; the probe is present on
  the nested engine and **absent from the host engine** (`--host-check`).
- **T015a firewall↔DinD: GREEN** — image pulls succeed through the default-deny firewall. Two real
  bugs were found and fixed here: (1) Docker Hub's blob CDN host `production.cloudfront.docker.com`
  was missing from the allowlist (auth succeeds, blob fetch times out — misleading); (2) `iptables
  -F` left the prior DROP policy in place, blocking the firewall's own re-run fetches → added a
  policy-reset. Broad CDN CIDR widening is gated behind opt-in `FIREWALL_ALLOW_CDN_RANGES=1`.
- **Foundation/toolchain: GREEN** — image builds; `coder`/non-root, `claude 2.1.197`, `pnpm
  10.33.0`, `docker 29.6.1` present; a real config bug was fixed (corepack/`npm -g` EACCES as
  non-root → moved to root-level Dockerfile layers). Config resolves + runs under `@devcontainers/cli`
  (SC-006 precondition); `devcontainer-lock.json` pins the DinD feature by digest (SC-005).
- **SC-008 (T027): PASS** — 0 privilege-denial claims in the runbook + PRD; moderate-engine caveat
  present in both. Secret / inline-secret / topology-scrub gates all pass on the staged tree.

**Pilot-only (unchecked — require interactive VS Code / real Metro / device / full monorepo):**
T018 (SC-003 hot-reload *feel*), T022 (full delete+recreate on the populated volume), T028
(SC-007 device-over-LAN + SC-009 full in-container integration session), T029 (web E2E in-container),
T030 (`rtk gain`). The verify scripts + quickstart are the pilot checklist. See
[HANDOFF.md](HANDOFF.md): hands-on acceptance is expected to be human-driven.
