# Feature Specification: Full Developer Toolchain & Personal AI-Assistant Setup in the Dev Container

**Feature Branch**: `038-devcontainer-full-toolchain`

**Created**: 2026-07-11

**Status**: Draft

**Input**: Extend the feature-037 containerized dev environment so an AI-assisted coding session run *inside* the container is as capable as one on the native Windows workstation — carrying the full developer toolchain and the developer's personal AI-assistant setup — **without** a long reinstall each time a container is started.

## Context

Feature 037 delivered a disposable, isolated Linux **dev container** (plain Dev Containers + Docker-in-Docker + a default-deny egress firewall) whose pilot image carries only **Node 24 + pnpm + watchman + DinD**. The developer's real workflow on the native workstation depends on much more (Rust and its cargo tooling, Python via `uv`, the Specify CLI, Nx, `gh`, EAS/Expo) plus a **personal AI-assistant setup** (an output-compression proxy for token savings, a set of Claude Code plugins/skills, and service logins). None of that exists in the container today, so an in-container assistant session is markedly less capable than a native one — and naïvely installing all of it on every container start would cost many minutes (dominated by compiling native tooling), which is unacceptable for daily use.

This feature closes that gap while preserving 037's isolation posture and staying within its startup-time expectations.

## Clarifications

### Session 2026-07-12

- Q: Where should the pre-provisioned dev-container toolchain image be hosted? → A: The project's existing forge registry (`jumbleknot/mcm-devcontainer`), same pipeline as the app images; referenced by digest in the committed definition, with the forge host literal kept out of git (topology-scrub — sourced from env).
- Q: How should the personal (out-of-repo) layer — compression proxy, plugins/skills, logins — be delivered? → A: A newly scaffolded personal dotfiles repository whose install script the editor runs post-create, guarded to run once (skipped when the persistent personal-config volume is already populated).
- Q: How is the personal compression proxy obtained for the container's Linux platform? → A: Built from source in-container via the Rust toolchain (`cargo install --git`); no separate release-binary channel, and it is part of the personal layer (not baked into the shared image). The first build is a one-time, cached cost.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Full team toolchain present in-container (Priority: P1)

As the developer, when I open the dev container, the complete project toolchain is already available on the command path — the Rust toolchain and its cargo utilities, the Python package manager and the Specify CLI, Node 24 / pnpm / Nx, and `gh` — so I can build, lint, test, and run the project's spec-driven-development commands entirely inside the container without reaching back to the host.

**Why this priority**: This is the core capability gap. Without the toolchain present, in-container work is limited to the JS layer; Rust/Python/SDD work forces host round-trips, undercutting the isolation win of 037. If only this ships, the container is already a complete workshop.

**Independent Test**: From inside a freshly opened container, run a representative build/lint/test for each language layer (Rust, JavaScript/TypeScript, Python) and the SDD tooling; all succeed with no host fallback and no "command not found".

**Acceptance Scenarios**:

1. **Given** a freshly opened container, **When** the developer checks for each expected tool on the command path, **Then** every tool in the agreed toolchain set is present and reports a version.
2. **Given** the container, **When** the developer runs a Rust build/test, a JS/TS build/lint/test, and a Python check, **Then** each completes successfully in-container.
3. **Given** the container, **When** the developer runs the project's SDD commands, **Then** they execute without a missing-prerequisite error.

---

### User Story 2 - Fast startup, nothing re-installed each time (Priority: P1)

As the developer, starting or recreating a container is fast — a stop→start in seconds and a full recreate well under the warm budget (see SC-003/SC-004) — and never a multi-minute reinstall of the toolchain, because the heavy one-time work is amortized and package caches survive container recreation so dependencies are not re-downloaded or re-compiled.

**Why this priority**: A capable-but-slow environment gets abandoned. Startup speed is what makes the full-toolchain container usable every day. Tied with US1 for adoption.

**Independent Test**: Time three transitions — first-ever provisioning on the machine, recreating the container from the committed definition, and a stop→start — and confirm each meets its budget; then recreate the container and confirm dependency downloads do not re-run (caches are reused).

**Acceptance Scenarios**:

1. **Given** the environment definition is already provisioned once on the machine, **When** the developer recreates the container, **Then** it is ready to use within the warm budget and no toolchain component is re-compiled or re-downloaded.
2. **Given** an existing stopped container, **When** the developer starts it, **Then** it is ready within the stop/start budget.
3. **Given** a package cache populated by a prior session, **When** the developer installs project dependencies after a recreate, **Then** the install is served from cache (no full re-download).

---

### User Story 3 - Personal AI-assistant setup present and persistent (Priority: P2)

As the developer, my personal AI-assistant setup works inside the container just as on the host — command output is compressed for the assistant to save tokens, my Claude Code plugins/skills are available, and my service logins (assistant, forge/`gh`, Expo) persist — all established once and reused on every subsequent open, not redone each time.

**Why this priority**: The in-container assistant should be as effective and economical as the native one; re-authenticating and re-installing plugins every open would make the container painful. Second to the toolchain itself because the container is still useful without the personal niceties.

**Independent Test**: In a container, confirm the assistant's output-compression is active and achieving its usual savings, the expected plugins/skills are present, and the developer is still logged in to the relevant services; recreate the container and confirm none of these had to be redone.

**Acceptance Scenarios**:

1. **Given** a container with the personal setup established, **When** the assistant runs commands, **Then** their output is compressed (measurable token savings), matching the host behavior.
2. **Given** the container, **When** the developer lists available assistant plugins/skills, **Then** the expected personal set is present.
3. **Given** the personal setup was established once, **When** the developer recreates the container, **Then** plugins, compression, and logins are already in place with no re-install or re-login.

---

### User Story 4 - Committed team toolchain vs personal setup cleanly separated (Priority: P2)

As the developer/operator, the shared toolchain is defined as committed code that travels with the repo, while my personal setup (my plugins, my logins, my compression proxy) is delivered by a personal mechanism and is **not** committed to the repository, so the repo config carries no individual's tools or credentials.

**Why this priority**: Keeps the committed definition team-neutral and secret-free (constitution), and lets the personal layer evolve without touching the repo. Important for correctness and secret hygiene, but the container still functions if the separation were imperfect — hence P2.

**Independent Test**: Inspect the committed definition and confirm it contains the team toolchain but none of the personal tools, plugin lists, or credentials; confirm the personal layer is applied from a source outside the repository.

**Acceptance Scenarios**:

1. **Given** the committed definition, **When** it is reviewed, **Then** it defines the shared toolchain and contains no personal plugin list, personal proxy, or credential.
2. **Given** a second person opened the same committed container without the personal mechanism, **When** they use it, **Then** the team toolchain works and only the personal conveniences are absent.

---

### User Story 5 - Stays within the 037 security posture (Priority: P3)

As the developer/operator, adding the toolchain and personal setup does not weaken feature 037's isolation: host-filesystem/credential isolation stays strong, and the default-deny egress firewall is extended only as far as needed to fetch the new package sources (Rust crates, Python packages, plugin sources, Expo) required to provision the image and do the one-time personal setup.

**Why this priority**: A safety constraint rather than a new capability; it must hold but doesn't itself deliver user value, so P3.

**Independent Test**: Run 037's existing isolation checks in the extended container (they still pass), and confirm the firewall allows exactly the added package sources and no more (a disallowed destination is still blocked).

**Acceptance Scenarios**:

1. **Given** the extended container, **When** 037's host-isolation and engine-isolation checks run, **Then** they still pass.
2. **Given** the extended firewall, **When** the toolchain/image is provisioned and the personal setup runs, **Then** all required package fetches succeed and an arbitrary non-allowlisted destination is still refused.

---

### Edge Cases

- **Toolchain component changes** (new cargo tool, bumped versions): the amortized/pre-provisioned artifact must be refreshable on demand without forcing every developer to rebuild locally, and a stale artifact must be detectable.
- **First-ever provisioning is slow by nature** (native tooling compiles): this one-time cost is acceptable and must be clearly distinguished from the per-open experience, which must stay fast.
- **Personal mechanism absent or first run**: the container must still come up with the full team toolchain; the personal layer applies on first availability and is skipped cleanly if not configured (never blocks container start).
- **A package source is unreachable / firewall too tight**: provisioning or personal setup must fail loudly with a clear "which source was blocked" signal, not hang or silently degrade.
- **Personal credentials must never be baked** into the committed definition or the shared prebuilt artifact.
- **Native mobile tooling** (Android SDK/emulator, device builds) is intentionally excluded and remains host-side (per 037).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dev container MUST make the full project toolchain available on the command path at container start: the Rust toolchain + language server + the project's cargo utility set, the Python package manager + the Specify CLI, Node 24 + pnpm + Nx, and `gh`.
- **FR-002**: Every tool in FR-001 MUST be runnable in-container such that the project's Rust, JavaScript/TypeScript, and Python build/lint/test workflows and its SDD commands all complete without host fallback.
- **FR-003**: Recreating a container from the committed definition MUST NOT re-compile or re-download the toolchain; the heavy provisioning MUST be performed once and reused across container recreations.
- **FR-004**: Project dependency caches (for each package ecosystem in use) MUST persist across container recreation so dependency installs are served from cache rather than re-downloaded.
- **FR-005**: Starting/recreating a container MUST meet defined startup budgets (see Success Criteria); it MUST NOT require an interactive multi-minute toolchain install on each open.
- **FR-006**: The developer's personal AI-assistant output-compression proxy MUST be active for the in-container assistant, delivering token savings comparable to the host.
- **FR-007**: The developer's personal Claude Code plugins/skills MUST be available in-container, and the developer's relevant service logins MUST persist across container recreation.
- **FR-008**: The personal setup (proxy, plugins, logins) MUST be established once and reused thereafter — not reinstalled or re-authenticated on every container open.
- **FR-009**: The shared team toolchain MUST be defined as committed, repository-resident configuration; the personal setup MUST be delivered by a mechanism outside the repository and MUST NOT be committed.
- **FR-010**: No personal credential or secret may be baked into the committed definition or any shared prebuilt artifact (constitution — Secrets Management).
- **FR-011**: Feature 037's isolation guarantees MUST continue to hold in the extended container (host-filesystem/credential/SSH isolation strong; engine isolation unchanged); 037's isolation checks MUST still pass.
- **FR-012**: The default-deny egress firewall MUST be extended to allow exactly the additional package sources needed (Rust crate registry, Python package index, plugin sources, Expo) for image provisioning and one-time personal setup, and MUST continue to refuse non-allowlisted destinations.
- **FR-013**: The pre-provisioned toolchain artifact MUST be refreshable on demand (e.g., when a tool or version changes) without requiring each developer to rebuild it locally, and a stale artifact MUST be detectable.
- **FR-014**: Container start MUST NOT be blocked by the personal mechanism being absent or failing; the team toolchain MUST come up regardless, and the personal layer MUST be applied only when available.
- **FR-015**: Provisioning or personal-setup failure due to a blocked/unreachable package source MUST surface a clear, actionable error identifying the source, not hang or silently proceed.

### Key Entities

- **Team Toolchain**: The committed, shared set of developer tools the container provides (Rust + cargo utilities, Python/`uv` + Specify, Node/pnpm/Nx, `gh`). Travels with the repo; identical for everyone.
- **Pre-provisioned Toolchain Artifact**: The amortized, build-once form of the team toolchain that makes per-open startup fast; refreshable on demand; contains no credentials.
- **Persistent Cache**: Per-ecosystem dependency/tool caches that survive container recreation so nothing re-downloads.
- **Personal AI-Assistant Setup**: The developer's non-committed layer — output-compression proxy, Claude Code plugins/skills, and service logins — established once and persisted.
- **Personal Delivery Mechanism**: The out-of-repo means by which the personal setup is applied to any container the developer opens (kept separate from committed config and free of shared credentials).
- **Extended Egress Allowlist**: The additional package-source destinations the firewall permits so the toolchain/personal setup can be fetched, on top of 037's baseline.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a freshly opened container, **100%** of the agreed toolchain tools are present on the command path and report a version; **0** are missing.
- **SC-002**: A representative build + lint + test across **all three** language layers (Rust, JS/TS, Python) and the SDD commands complete **entirely in-container** with **0** host fallbacks.
- **SC-003**: **Warm recreate** of the container from the committed definition is ready to use in **under 90 seconds**, with **0** toolchain components re-compiled or re-downloaded.
- **SC-004**: **Stop→start** of an existing container is ready in **under 15 seconds** (unchanged from 037).
- **SC-005**: After a container recreate, a project dependency install is served from cache with **0** full re-downloads of already-cached packages.
- **SC-006**: The assistant's output-compression is active in-container and achieves **> 80%** compression on the standard command set (matching the host target).
- **SC-007**: **100%** of the developer's expected personal plugins/skills are present in-container after the one-time setup, and **0** require re-installation or re-login on a subsequent recreate.
- **SC-008**: Feature 037's host-isolation and engine-isolation checks **still pass (exit 0)** in the extended container.
- **SC-009**: With the extended firewall active, **100%** of required package fetches (crates, Python packages, plugin sources, Expo) succeed and an arbitrary non-allowlisted destination is still **refused**.
- **SC-010**: The committed definition contains **0** personal plugin lists, personal proxy binaries, or credentials (verified by review + the existing secret gates).
- **SC-011**: First-ever provisioning (build of the pre-provisioned artifact) is a **one-time** cost; it does not recur on subsequent opens, and its recurrence count over a working week of normal opens is **0**.

## Assumptions

- **Single developer / single workstation**, as in feature 037; no multi-user or shared-credential requirements.
- The developer will **create a new personal dotfiles repository** (decided — see Clarifications) as the personal delivery mechanism; this feature defines the seam, not the developer's private contents.
- A **pre-provisioned image is published to the project's existing forge registry** (decided) to amortize toolchain build cost; the forge host literal stays out of committed files (topology-scrub rule).
- The **personal compression proxy is built once from source in-container** via the Rust toolchain (decided — `cargo install --git`); the first build is a one-time, cached cost and it lives in the personal layer, not the shared image.
- Feature 037's `.devcontainer/` is the baseline this extends; its isolation posture, firewall, DinD engine, and named-volume/bind-mount open paths are unchanged except for the additive toolchain, caches, and allowlist entries.
- **Android/native-mobile tooling remains host-side** and out of scope, consistent with 037.

## Out of Scope

- Android Studio, the Android emulator, and native mobile build/device work (host-side, per 037).
- Any change to feature 037's isolation or privilege posture.
- Multi-user access or team-wide credential/login sharing.
- The specific private contents of the developer's personal setup (their exact plugin choices and credentials) — this feature provides the seam and persistence, not the personal inventory.
- Changes to application code, auth, or CI/CD beyond publishing/refreshing the pre-provisioned dev image.
