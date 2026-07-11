# Feature Specification: Containerized Local Dev Environment for AI-Assisted Development

**Feature Branch**: `037-containerized-dev-env`

**Created**: 2026-07-11

**Status**: Draft

**Input**: Assessment of `docs/proposals/DevPod-Workstation-PRD.md`, revised by two decisions: (1) target a plain, spec-conformant dev-container runner rather than a single vendor tool — the environment definition is the portable asset; (2) accept in-container container-building capability and state the isolation posture honestly (strong host-filesystem/credential isolation; only moderate isolation of the container engine).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent runs sealed off from the host (Priority: P1)

As the sole developer/operator, I open a project in a disposable Linux development environment and run the AI coding assistant **inside** it, so that any command the assistant runs — an errant script, a malicious dependency, an untrusted test container — cannot read or modify the host workstation's files, credentials, or SSH keys.

**Why this priority**: This is the reason the feature exists. Blast-radius isolation of the AI assistant is the primary control; every other benefit (reproducibility, parity, parallel toolchains) is secondary and comes along for free. If only this story ships, the environment already delivers its core value.

**Independent Test**: Open the environment, start the assistant in its terminal, and confirm from inside that a known host-only marker file (e.g., a file in the Windows user profile) is unreachable and that host credential stores are absent. Delete the environment and confirm nothing was written to the host workspace outside the project directory.

**Acceptance Scenarios**:

1. **Given** the environment is running, **When** the assistant is started in the environment's terminal, **Then** it runs as an unprivileged (non-root-on-host) user with no path to the host filesystem, host SSH keys, or host credential stores.
2. **Given** the assistant is running in the environment, **When** it attempts to read a file that exists only on the host outside the project, **Then** the read fails (the path does not exist inside the environment).
3. **Given** a session has ended, **When** the environment is torn down, **Then** no host-side state was mutated other than within the committed project definition and the environment's own managed storage.

---

### User Story 2 - Build images and run test stacks inside the environment (Priority: P2)

As the developer, I build container images and run multi-container test stacks (integration tests, compose stacks) from inside the environment, so that my full test workflow works without reaching back out to the host's container engine.

**Why this priority**: Much of this project's testing is container-based (replica-set MongoDB, compose stacks). Without in-environment container capability the isolation win is undercut by constant host round-trips. Second only to isolation because the environment is still useful for code/web/bundler work without it.

**Independent Test**: From inside the environment, build an image and run a throwaway container, then confirm on the host that the host engine's container listing does **not** show them — proving the in-environment engine is separate from the host engine.

**Acceptance Scenarios**:

1. **Given** the environment is running, **When** the developer builds an image and starts a test container inside it, **Then** both succeed.
2. **Given** a test container is running inside the environment, **When** the developer lists containers on the host engine, **Then** the in-environment containers do not appear there.
3. **Given** the isolation posture is documented, **When** a reader reviews it, **Then** it states plainly that in-environment container capability requires elevated privileges and therefore provides only *moderate* isolation of the container engine (a privileged escape can reach the shared host virtualization layer), while host-filesystem and credential isolation remain strong.

---

### User Story 3 - Fast edit-reload parity with native development (Priority: P2)

As the developer, I edit source and see hot reload / rebuild feedback as fast as I do developing natively, so that moving into the isolated environment costs me no day-to-day speed.

**Why this priority**: A reproducible, isolated environment that reloads slowly will be abandoned. File-watch parity is what makes the environment sticky for daily use. Tied with US2 in importance for adoption.

**Independent Test**: Edit a component while the bundler runs in the environment and observe reload latency indistinguishable from native development; confirm the reload is driven by an efficient file-watch mechanism, not slow polling.

**Acceptance Scenarios**:

1. **Given** project source resides on the environment's native Linux storage (not a cross-OS bind mount), **When** a source file is edited, **Then** hot reload triggers with latency a user cannot distinguish from native development.
2. **Given** a dev/bundler server runs inside the environment, **When** a browser or physical device on the local network connects to the forwarded dev-server address, **Then** it loads the running app.

---

### User Story 4 - Reproducible, committed, prod-aligned definition (Priority: P3)

As the developer/operator, I keep each project's environment defined as code committed alongside the project, based on an image aligned with what the project deploys, so that the environment rebuilds from scratch deterministically and reduces "works on my machine" drift.

**Why this priority**: Reproducibility and parity are durable quality wins but not blocking for a first pilot; the environment is valuable before the base image is perfectly aligned to prod.

**Independent Test**: Delete the environment entirely, recreate it from the committed definition with no manual steps, and confirm the recreated environment is functionally identical.

**Acceptance Scenarios**:

1. **Given** the environment definition is committed to the project, **When** the environment is deleted and recreated, **Then** it is reproduced with no manual configuration steps.
2. **Given** the base image is aligned with the project's deployed runtime lineage, **When** the environment is built, **Then** the development runtime matches the deployment runtime family.

---

### User Story 5 - Runner portability (Priority: P3)

As the developer/operator, I keep the environment definition strictly conformant to the open dev-container standard so that it runs unmodified under any conformant runner, protecting the setup against any single tool being abandoned and preserving a future migration path (e.g., to the homelab).

**Why this priority**: Insulation from vendor risk and a future migration path. Valuable but not required for the pilot; realized by *how* the definition is written rather than by extra machinery.

**Independent Test**: Take the committed definition and open it under a second conformant runner without editing it; confirm the environment builds and runs.

**Acceptance Scenarios**:

1. **Given** a spec-conformant environment definition, **When** it is opened under a different conformant runner, **Then** it builds and runs with no changes to the definition.

---

### Edge Cases

- **Native mobile targets**: iOS Simulator and Android emulator cannot run in a headless Linux environment. Native build/simulator/device-debug work stays a host-side activity and is explicitly out of scope (see Out of Scope). The environment supports backend/API/services, the web target, and the JS bundler only.
- **Device can't reach the dev server over the network**: when local-network routing to the forwarded dev-server address is unavailable, a tunneled connection path is the documented fallback (slower, acceptable for occasional use).
- **Assistant accidentally run on the host instead of inside the environment**: this silently defeats the isolation goal. There must be a reliable, documented way to verify at a glance that the assistant is executing inside the environment (e.g., an in-environment marker), and the daily-use convention must make in-environment invocation the default.
- **Cross-OS source mount reintroduced by mistake**: placing source on a slow cross-OS mount instead of the environment's native storage silently destroys file-watch performance (US3). The definition must keep source on native storage.
- **Concurrent environments exhausting workstation memory**: running several environments plus the editor at once can exhaust RAM; idle environments should be stoppable and the concurrent count kept small.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a per-project development environment that opens in the editor with an integrated terminal running **inside** the environment.
- **FR-002**: The AI coding assistant MUST be runnable inside the environment (available on the environment's command path and attachable from the editor), and MUST run as a user with no access to the host filesystem, host SSH keys, or host credential stores.
- **FR-003**: Project source MUST reside on the environment's native Linux storage, never a cross-OS bind mount, to preserve fast file watching.
- **FR-004**: The environment MUST be able to build container images and run test containers using a container engine that is separate from the host engine — such that in-environment containers do not appear on, and are not controlled via, the host engine.
- **FR-005**: The environment MUST forward the bundler/dev-server ports to the host so a browser or physical device on the local network can reach a dev server running inside the environment.
- **FR-006**: Tearing the environment down MUST fully remove it, and recreating it from the committed definition MUST be deterministic and require no manual steps.
- **FR-007**: The environment definition MUST be committed to each project so it travels with the code.
- **FR-008**: The environment definition MUST remain conformant to the open dev-container standard so it runs unmodified under any conformant runner (no dependence on a single vendor tool for portability).
- **FR-009**: The base image SHOULD share lineage with the runtime the project deploys, to reduce development-vs-deployment drift.
- **FR-010**: Per-project secrets MUST be injected at environment runtime (via environment variables / the runner's secret mechanism), never baked into the committed definition or image, and the host user profile MUST NOT be mounted in.
- **FR-011**: The documented security posture MUST state honestly that in-environment container capability requires elevated privileges and therefore yields only *moderate* isolation of the container engine (a privileged escape can reach the shared host virtualization layer and thus the host engine), while host-filesystem and credential isolation remain strong. It MUST NOT claim the environment runs without elevated privileges.
- **FR-012**: A reliable, documented method MUST exist to confirm the assistant is running inside the environment rather than on the host, and the daily-use convention MUST default to in-environment invocation.
- **FR-013**: The source proposal document MUST be updated so its tool choice and security-posture claims match this specification (plain conformant runner as the portable asset; honest isolation posture; removal of any "no elevated privileges" claim).

### Out of Scope

- Remote access to the environment from other machines.
- Always-on / persistent-uptime environments (the environment need exist only while the workstation is on).
- Multi-user access, role-based access control, or self-service dashboards.
- Running iOS Simulator or Android emulator inside the environment; all native mobile build/simulator/device work remains host-side.
- Any change to CI/CD (the existing forge-based CI and deployment control plane are unchanged).
- Achieving *strong* container-engine isolation on this workstation platform (not attainable together with in-environment container capability here; revisit only if the platform changes).

### Key Entities

- **Environment Definition**: The committed-as-code description of a project's development environment (base image, tooling, forwarded ports, editor customizations, post-create setup). The portable asset; conformant to the open standard.
- **Environment Instance**: A running, disposable Linux container created from the definition; hosts the assistant, the toolchain, and the in-environment container engine. Fully reproducible from the definition.
- **Source Volume**: The environment's native Linux storage holding project source, keeping file watching fast.
- **Base Image**: The image the environment is built on; ideally aligned with the project's deployment runtime lineage.
- **In-Environment Container Engine**: A container engine separate from the host engine, used to build images and run test containers inside the environment.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From inside a running environment, 0 host-only files outside the project are readable and 0 host credential/SSH stores are present — verified by an explicit isolation check.
- **SC-002**: Building an image and running a test container inside the environment succeeds, and 0 of those containers appear on the host engine's container listing.
- **SC-003**: After editing a source file, hot reload occurs with latency a developer cannot distinguish from native development (no perceptible slowdown versus the current native workflow).
- **SC-004**: Warm start of an existing environment completes in under 15 seconds; a cold build from scratch completes in under 5 minutes on the workstation.
- **SC-005**: Deleting an environment and recreating it from the committed definition reproduces a functionally identical environment with 0 manual configuration steps.
- **SC-006**: The same environment definition opens and runs unmodified under a second conformant runner (0 edits required).
- **SC-007**: A dev server running inside the environment is reachable from a browser and from a physical device over the local network via the forwarded address.
- **SC-008**: The published security posture and the updated source proposal contain 0 statements claiming the environment runs without elevated privileges, and explicitly document the moderate-container-engine-isolation caveat.
- **SC-009**: The pilot project runs its normal backend/web/bundler development and container-based test workflow entirely inside the environment for a full working session with no need to fall back to host-side execution (native mobile excepted).

## Assumptions

- **Single user, single workstation**: One developer/operator on one Windows 11 workstation with the existing host container engine already installed; no new always-on host services are introduced.
- **Host container engine present**: The workstation already runs a host container engine (with a Linux virtualization backend); the environment is created on top of it. Strong container-engine isolation is not attainable on this platform alongside in-environment container capability, and that limitation is accepted.
- **Pilot scope**: The first pilot targets the single universal (web + native) app project in this repository; native mobile testing remains host-side throughout.
- **Base image default**: Absent a chosen prod-parity base, the environment starts from a current Node 20 / Debian-family base matching the project's deployed runtime lineage; a specific prod-image parity base can be settled during hardening without reworking the definition.
- **Per-repo definitions first**: Each project carries its own environment definition initially; consolidating to a shared, registry-published base image is a later, optional standardization step and is not required for the pilot.
- **Network path default**: Local-network port forwarding is the default device-connection path; a tunneled path is the documented fallback when local-network routing is inconvenient.
- **Rollout is phased**: Pilot on one project and validate the success criteria first; standardize to additional projects afterward.
