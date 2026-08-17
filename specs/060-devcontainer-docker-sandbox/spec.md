# Feature Specification: Dev container on Docker Sandbox — retiring Docker-in-Docker

**Feature Branch**: `060-devcontainer-docker-sandbox`

**Created**: 2026-08-15

**Status**: Draft

**Input**: User description: "Rehost the AI-assisted engineering dev container on a Docker Sandbox microVM, retiring Docker-in-Docker entirely. Source proposal: `docs/proposals/proposal-devcontainer-on-docker-sandbox.md` (revision 2). Full P0→P6 migration scope. Phase P0 (host prep) is already COMPLETE on the Windows workstation. Gate R2 resolved NEGATIVE: `/dev/kvm` is ABSENT in the sandbox, so the local Android emulator does not survive the move and mobile E2E becomes a documented scoped exception."

## Context

The AI coding assistant works inside a disposable Linux dev container (features 037/038). Because the assistant must create and destroy containers, that container runs a nested container engine, which forces it to run **privileged**. The honest posture recorded in `docs/runbooks/devcontainer.md` (FR-011) is therefore two-tier: host-filesystem and credential isolation is STRONG, but **container-engine isolation is only MODERATE** — an escape from the privileged container reaches the shared virtual machine that also hosts the workstation's own engine.

The nested engine also carries a standing operational tax: a stale-container lock deadlock after rebuilds, a rerouted internal host name, a compose-version parity pin, a credential-helper workaround, and a **documented, deliberate gap — egress from containers the assistant creates is not filtered at all**.

This feature moves the whole engineering environment inside a hardware-isolated microVM that ships its own private container engine, and has the dev container consume that engine as an ordinary unprivileged client. The nested engine and the `privileged` flag are deleted, not relocated. The blast radius for everything the assistant does becomes the disposable microVM.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Workstation is sandbox-capable (Priority: P1) — ✅ COMPLETE

As the developer, I need my workstation to be able to run hardware-isolated microVMs with their own private container engine, proven end-to-end on a throwaway sandbox, before committing any project work to that environment.

**Why this priority**: Nothing downstream can start without it, and it is the cheapest place to discover that the workstation cannot host the new environment at all. **This story is already satisfied** — carried out ahead of this specification and recorded here so the migration record is complete and auditable.

**Independent Test**: Create a throwaway sandbox, run a container inside it, confirm the workstation's own engine never sees that container, and destroy the sandbox — leaving the existing environment untouched.

**Acceptance Scenarios**:

1. **Given** the hypervisor capability is enabled and the workstation has been restarted since, **When** the sandbox tooling reports its own preflight diagnosis, **Then** every check reports healthy. ✅
2. **Given** the sandbox tooling is installed, **When** its version is queried, **Then** a version is returned and recorded for later pinning. ✅ *(v0.38.0)*
3. **Given** a default network-governance policy is required before any sandbox can be created, **When** the default is set to a deny-by-default profile, **Then** sandbox creation proceeds without an interactive prompt. ✅ *(balanced; tightened in User Story 2)*
4. **Given** a throwaway sandbox, **When** a container is run inside it, **Then** it runs successfully **and** the workstation's own engine never lists it. ✅
5. **Given** the throwaway sandbox is destroyed, **When** the existing dev container is opened normally, **Then** it still works exactly as before. ✅
6. **Given** the emulator question is open, **When** hardware-virtualisation availability is probed inside the sandbox, **Then** the result is recorded as gate data. ✅ *(absent — see FR-006 and Assumptions)*

---

### User Story 2 - Governed, audited egress with the forge reachable (Priority: P1)

As the developer, I need the sandbox to reach exactly the destinations the work requires — and nothing else — with enforcement that the assistant inside cannot switch off, an audit trail when something is blocked, and the private forge reachable for both source and images.

**Why this priority**: It is the hard gate. The forge is reached over a private overlay network, and sandbox egress is redirected through a host-side proxy that is documented as not necessarily following that network's routing. If the forge is unreachable and cannot be made reachable, the migration stops here and the existing environment is retained — so this must be answered before any effort is spent on the environment itself.

**Independent Test**: From a shell inside the sandbox, fetch from each allowlisted destination, clone from and push to the forge, pull the toolchain image, then attempt a destination that is deliberately not allowlisted and confirm it is refused with a corresponding audit entry.

**Acceptance Scenarios**:

1. **Given** a deny-by-default policy with an explicit allowlist derived from the project's canonical destination list, **When** each allowlisted destination is fetched from inside the sandbox, **Then** every one succeeds.
2. **Given** that same policy, **When** a destination that is not on the allowlist is requested, **Then** the request is refused **and** an entry naming it appears in the governance audit log.
3. **Given** the private forge is on an overlay network, **When** source is cloned, fetched and pushed from inside the sandbox, **Then** all three succeed.
4. **Given** the private image registry is on the same overlay network, **When** the digest-pinned toolchain image is pulled onto the sandbox's own engine, **Then** the pull succeeds.
5. **Given** the enforcement is applied outside the sandbox, **When** a user inside the sandbox attempts to alter or bypass it, **Then** the enforcement remains in effect.
6. **Given** a service is listening on the workstation's own loopback interface, **When** it is addressed from inside the sandbox, **Then** it is unreachable.
7. **Given** the forge proves unreachable and no documented routing remedy resolves it, **When** the gate is evaluated, **Then** the feature is stopped at this story with the finding recorded, and the existing environment remains the working environment.

---

### User Story 3 - Unprivileged dev container on the sandbox's own engine (Priority: P1)

As the AI coding assistant, I need to run in a dev container that has the same toolchain, caches and workflows as today, that runs **unprivileged with no container engine inside it**, and that drives the sandbox's engine directly — so that every container I create is a sibling inside the disposable microVM rather than a nested child of my own container.

**Why this priority**: This is the migration itself. It is what deletes the privileged nested engine and moves the weak isolation seam off the workstation.

**Independent Test**: Bring the dev container up on the sandbox from a clean clone, then verify from inside that no engine daemon is running locally, verify from the sandbox that the container is unprivileged, verify from the workstation that its own engine sees neither the dev container nor anything the assistant creates, and confirm the toolchain and caches behave as they do today.

**Acceptance Scenarios**:

1. **Given** the dev container is running, **When** it is inspected for a local container-engine daemon, **Then** none is running inside it.
2. **Given** the dev container is running, **When** its configuration is inspected from the sandbox's engine, **Then** it is not privileged.
3. **Given** the dev container is running, **When** the assistant creates, inspects, reads logs from, executes into, and destroys containers, **Then** all operations succeed and act on the sandbox's engine.
4. **Given** containers created by the assistant, **When** the workstation's own engine is listed, **Then** none of them — nor the dev container itself — appears.
5. **Given** sibling services published inside the microVM, **When** they are addressed from the dev-container shell using the project's existing local service addresses, **Then** they resolve and respond exactly as they do today, with no change to documented addresses or environment exports.
6. **Given** a sibling container is asked to mount a path from the working tree, **When** it starts, **Then** the mount resolves to the intended content, because the workspace occupies the identical path inside the microVM and inside the dev container.
7. **Given** a fresh environment, **When** the dev container is created, **Then** the same toolchain is present, the same persistent caches are reused, and the developer's personal layer is preserved — matching current behaviour.
8. **Given** the ported verification suite, **When** it is run, **Then** it passes, including a new two-sided check on the engine boundary that replaces the previous engine-isolation check.
9. **Given** the existing environment must keep working until adoption, **When** the current configuration is used on the workstation's own engine, **Then** it still builds and runs unchanged.

---

### User Story 4 - Reaching the assistant from the workstation's editor (Priority: P2)

As the developer, I need to open my editor on the workstation, land in a terminal inside the dev container, and run the coding assistant there — with the same extensions and identity as today.

**Why this priority**: Without it the environment exists but cannot be worked in. It is P2 rather than P1 because a documented fallback route is available if the preferred route proves unstable.

**Independent Test**: From the workstation's editor, connect through to a dev-container terminal and confirm the in-container identity markers and the assistant's version; then exercise the fallback route once so it is documented rather than theoretical.

**Acceptance Scenarios**:

1. **Given** remote access to the sandbox is configured once, **When** the editor connects to it, **Then** the session lands inside the sandbox.
2. **Given** a sandbox editor session, **When** the dev container is attached to or reopened in, **Then** the terminal reports the in-container marker, the non-root project user, and a working assistant CLI, and the configured extensions load.
3. **Given** the preferred route is unavailable, **When** the documented fallback route is used, **Then** a dev-container terminal is still reached, and the fallback is recorded as exercised.
4. **Given** the remote-access tooling is documented as experimental, **When** its version is fixed after the environment is proven, **Then** the pinned version and a review step on updates are recorded.

---

### User Story 5 - Full workload parity, with sibling egress finally governed (Priority: P2)

As the developer, I need the real workload — application stacks, the integration tier, web end-to-end tests, and an assistant end-to-end scenario — to run in the new environment at acceptable speed, and I need the long-standing gap where assistant-created containers had unfiltered egress to be closed and *proved* closed.

**Why this priority**: It converts "the environment starts" into "the environment works". Closing the egress gap is the security payoff that justifies the migration beyond convenience.

**Independent Test**: Run the runbook's validated bring-up and test sequence end to end in the new environment against sibling stacks, timing it against the current environment's baseline, and issue a disallowed request from inside a sibling container.

**Acceptance Scenarios**:

1. **Given** the new environment, **When** the documented bring-up sequence is run (secret generation, auth stack, application image build, application stack), **Then** every step succeeds against sibling containers.
2. **Given** the stacks are up, **When** the integration tier is run with its three documented address exports unchanged, **Then** it passes.
3. **Given** the stacks are up, **When** the web end-to-end suite is run using the documented containerized browser recipe, **Then** it passes, including the working-tree mount.
4. **Given** the stacks are up, **When** one assistant end-to-end scenario is run against the hosted model provider, **Then** it passes.
5. **Given** a sibling container the assistant created, **When** it requests a destination that is not allowlisted, **Then** the request is refused and an audit entry is produced — closing the previously documented gap.
6. **Given** the current environment's measured baseline, **When** the same sequence is timed in the new environment, **Then** wall-clock time is within the agreed budget; if it is not, the finding is escalated with measurements rather than absorbed.
7. **Given** the local model server, **When** it is started as a sibling and addressed by the assistant gateway, **Then** it is reachable.
8. **Given** hardware virtualisation is absent in the microVM, **When** mobile emulator work is attempted, **Then** it is refused cleanly with a documented alternative route, and nothing else in the environment is affected.

---

### User Story 6 - Reproducible recreate, documented, and the old path retired (Priority: P3)

As any developer or AI assistant picking this up later, I need to recreate the whole environment from nothing with documented steps, understand how to diagnose it, and find one current description of the environment rather than two competing ones.

**Why this priority**: It is what makes the migration durable rather than a one-off local success — but it is only worth doing once the environment is proven.

**Independent Test**: From a workstation with the tooling installed but no sandbox, follow the documented steps and reach a working dev container within the agreed time, with no undocumented manual step.

**Acceptance Scenarios**:

1. **Given** a snapshot or declarative description of the proven environment, **When** it is used to recreate the environment from nothing, **Then** a working dev container is reached within the agreed time budget with no step outside the documentation.
2. **Given** the new environment, **When** a blocked network request is diagnosed, **Then** the documented triage order is followed and identifies the responsible layer without guesswork.
3. **Given** the migration is complete, **When** the environment documentation is read, **Then** the runbooks, the repository instruction index, the knowledge bundle and the README all describe the new environment, its posture, its lifecycle, its port publishing, its teardown semantics, and its known foot-guns.
4. **Given** the new environment has run cleanly for the agreed observation period, **When** the configuration is collapsed to a single description, **Then** the nested-engine configuration and its dedicated documentation sections are retired or archived, and the old path is no longer offered for assistant sessions.
5. **Given** the old environment is retained for non-assistant use and as the mobile-emulator fallback, **When** it is used, **Then** it still works and its remaining purpose is documented.
6. **Given** any phase of the migration, **When** it fails, **Then** the documented rollback restores the previous working state without having modified it.

### Edge Cases

- **What happens when the sandbox management service becomes unresponsive?** Observed on this workstation during preparation: management commands hung waiting on an already-running service. The recovery must be documented, because it presents as the tooling being broken rather than as a stuck process.
- **What happens when the tooling is not on the command path in a freshly opened shell?** Observed on this workstation. The documentation must not assume a bare command name resolves.
- **What happens when the assistant destroys the container it is running in?** It now holds full control of the engine, so this is reachable in a single command. Recovery must be documented. It breaks the session, not the workstation.
- **What happens when the assistant stops or removes infrastructure it depends on?** Same class as today's control, now over siblings. Accepted inside the blast radius, but the recovery path must be stated.
- **What happens when the microVM runs out of disk?** The toolchain image, application images, model files and caches now share one engine and one filesystem envelope, and that envelope's limit is undocumented. It must be established, and a pruning practice documented.
- **What happens to uncommitted work when the sandbox is destroyed?** It is lost. Pushing remains the durable backup, and the wording of that discipline must be updated for the new teardown semantics.
- **What happens when a blocked request could be explained by either enforcement layer?** Failures present as the union of two allowlists. One canonical destination list and a stated triage order are required, otherwise diagnosis time is lost.
- **What happens when a physical device on the local network needs to reach a development server?** Published ports bind to the workstation's loopback interface only. A documented remedy or an explicit statement that this workflow is unsupported is required.
- **What happens when a tool recipe mounts the current directory?** With one engine, mount paths resolve against the microVM's filesystem. Any recipe run from a path that does not exist in the microVM will mount the wrong thing, silently.
- **What happens when the model-provider credential cannot be kept outside the microVM?** Either outcome is acceptable; only the recorded posture differs. It must not be left ambiguous.
- **What happens when the workstation restarts?** The environment's persistence across stop/start and reboot must be stated, so a developer knows whether a recreate is required.

## Requirements *(mandatory)*

### Functional Requirements

#### Workstation prerequisites (User Story 1 — satisfied)

- **FR-001**: The workstation MUST provide hardware-isolated microVM capability, enabled and active since the last restart. ✅ *satisfied*
- **FR-002**: The sandbox tooling MUST be installed and its exact version recorded, so it can be pinned once the environment is proven. ✅ *satisfied — v0.38.0*
- **FR-003**: The sandbox tooling MUST be authenticated and configured with a deny-by-default network policy before any assistant work occurs. ✅ *satisfied for bring-up; tightened by FR-008*
- **FR-004**: The tooling's own preflight diagnosis MUST report healthy, and known failure modes of the management service MUST be recorded for the runbook. ✅ *satisfied*
- **FR-005**: It MUST be demonstrated that containers created inside a sandbox are invisible to the workstation's own container engine. ✅ *satisfied*
- **FR-006**: Availability of hardware virtualisation inside the microVM MUST be established and recorded. ✅ *satisfied — absent; consequences in FR-028*

#### Egress governance (User Story 2)

- **FR-007**: The project MUST maintain a single canonical list of permitted network destinations, and MUST derive every enforcement configuration from it rather than maintaining parallel hand-edited lists.
- **FR-008**: Sandbox egress MUST be deny-by-default with an explicit allowlist, enforced outside the microVM so that it cannot be altered from within, and MUST produce an audit record of refused requests.
- **FR-009**: The private forge MUST be reachable from inside the sandbox for source clone, fetch and push, and for image pull onto the sandbox's engine. If it cannot be made reachable, the feature MUST stop at this requirement with the finding recorded, and the existing environment MUST be retained.
- **FR-010**: The workstation's own filesystem, credentials and loopback services MUST be unreachable from inside the sandbox.
- **FR-011**: No credential value, forge hostname or private-network address may enter version control; existing repository gates enforcing this MUST continue to pass unchanged.
- **FR-012**: Credentials MUST be provisioned by the most host-resident mechanism that works, in a stated order of preference, and nothing MUST depend on credentials being carried by the remote-access session.

#### The dev container and the engine boundary (User Story 3)

- **FR-013**: No container-engine daemon may run inside the dev container.
- **FR-014**: The dev container MUST run unprivileged.
- **FR-015**: Every container operation the assistant performs MUST execute on the microVM's own engine, and containers it creates MUST be siblings of the dev container rather than nested inside it.
- **FR-016**: The local service addresses, port numbers and environment exports documented for existing workflows MUST continue to work from the dev-container shell without modification.
- **FR-017**: The working tree MUST occupy the identical path inside the microVM and inside the dev container, and this MUST be asserted automatically rather than relied upon by convention.
- **FR-018**: The dev container MUST retain the existing toolchain, the persistent caches, the developer's personal layer, the non-root project user, and the existing lifecycle behaviour, minus the plumbing that existed only to serve the nested engine.
- **FR-019**: Until adoption, the new environment MUST be selectable alongside the existing configuration, and the existing configuration MUST keep working on the workstation's own engine.
- **FR-020**: The environment verification suite MUST be ported, with a two-sided check on the engine boundary replacing the previous engine-isolation check: nothing engine-like inside the dev container, and nothing from the microVM visible to the workstation's engine.
- **FR-021**: Configuration and documentation that existed solely to work around the nested engine MUST be removed or archived rather than carried forward.

#### Working in the environment (User Story 4)

- **FR-022**: A developer MUST be able to reach a terminal inside the dev container from the workstation's editor and run the coding assistant there, with the configured extensions available.
- **FR-023**: A fallback route to a dev-container terminal MUST exist, be exercised at least once, and be documented.

#### Workload parity (User Story 5)

- **FR-024**: The documented bring-up sequence, the integration tier, the web end-to-end suite and at least one assistant end-to-end scenario MUST pass in the new environment.
- **FR-025**: Egress from containers the assistant creates MUST be governed by the same deny-by-default policy, and this MUST be demonstrated by a refused request originating inside such a container — closing the gap that the current environment documents as deliberately open.
- **FR-026**: The migrated workload's wall-clock time MUST be measured against the current environment's baseline and MUST meet an agreed budget; a miss MUST be escalated with measurements, not absorbed.
- **FR-027**: Whether the model-provider credential can remain outside the microVM MUST be determined and the resulting posture recorded.
- **FR-028**: Loss of the local mobile emulator MUST be recorded as a scoped exception with its alternative routes named, and the environment MUST refuse emulator operations cleanly rather than failing obscurely.

#### Durability and adoption (User Story 6)

- **FR-029**: The proven environment MUST be reproducible from nothing via a snapshot or declarative description, within an agreed time budget and with no undocumented manual step.
- **FR-030**: A runbook MUST document the new environment's lifecycle, the triage order across the two enforcement layers, port publishing, teardown semantics, disk management, and the known foot-guns.
- **FR-031**: The runbooks, the repository instruction index, the knowledge bundle and the README MUST be updated so that any human or AI assistant can pick the environment up and use it efficiently.
- **FR-032**: After two consecutive weeks of incident-free daily use, the configuration MUST be collapsed to a single description and the nested-engine path MUST no longer be offered for assistant sessions, while remaining available for non-assistant use and as the mobile-emulator fallback. An **incident** is any of: an unplanned environment recreate; a test failure attributable to the environment rather than to the code under test; a network request blocked in error, requiring a change to the permitted-destination list; or a fall-back to the retained environment to complete work. Anything else — including ordinary test flakiness with a known non-environment cause — does not reset the clock. Without this definition the gate is unfalsifiable in either direction.
- **FR-033**: Every migration phase MUST have a rollback that restores the previous working state, and the existing environment MUST remain untouched until adoption.

### Key Entities

- **Sandbox**: The hardware-isolated, disposable microVM that is the new blast radius. Owns a private container engine, its own filesystem and network stack. Identified by name; created, stopped, snapshotted and destroyed as a unit.
- **Canonical destination list**: The single in-repository source of permitted network destinations, from which every enforcement configuration is generated. The thing that must not fork into two lists.
- **Network policy**: The deny-by-default allowlist applied to a sandbox, enforced outside it, with an audit record of refusals. Governs the whole microVM, including every container inside it.
- **Dev container**: The unprivileged workspace container holding the toolchain, caches and personal layer, running as a client of the sandbox's engine. Ceases to be a container host.
- **Sibling containers**: Application stacks, the local model server and throwaway test containers — previously nested children of the dev container, now peers of it on the same engine.
- **Persistent caches**: The named storage volumes for shell history, package registries and stores, and the personal layer, which must survive recreation.
- **Workspace**: The working tree, at a path that must be identical inside the microVM and inside the dev container. Not backed up by the environment — pushing is the durable backup.
- **Environment verification suite**: The set of automated checks asserting the environment's posture, including the engine-boundary check that replaces the current engine-isolation check.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No nested container engine exists anywhere in the environment: zero engine daemons run inside the dev container, and the dev container runs unprivileged — both asserted automatically, not by inspection.
- **SC-002**: The environment verification suite passes in full, including the new engine-boundary check proving that the workstation's own engine sees neither the dev container nor any container the assistant creates.
- **SC-003**: A developer reaches a terminal inside the dev container from the workstation's editor and runs the coding assistant there, by the primary route or the documented fallback.
- **SC-004**: The assistant creates, interrogates and destroys the full application stack set from its own shell, and 100% of those containers are invisible to and unreachable from the workstation.
- **SC-005**: Every allowlisted destination is reachable; a non-allowlisted destination is refused with a matching audit entry, **including when the request originates inside a container the assistant created**; the workstation's loopback services are unreachable from inside the sandbox.
- **SC-006**: The integration tier, the web end-to-end suite and one assistant end-to-end scenario all pass, at no more than 1.5× the current environment's measured wall-clock baseline, using the unmodified local service addresses.
- **SC-007**: Recreating the environment from nothing reaches a working dev container in 15 minutes or less on a warm workstation, with zero manual steps beyond documented credential provisioning.
- **SC-008**: The runbooks, the repository instruction index, the knowledge bundle and the README all describe the new environment, its posture, and its gotchas, with no remaining passage describing the nested engine as current.
- **SC-009**: No credential value, forge hostname or private-network address enters version control; all existing repository gates pass unchanged.
- **SC-010**: The loss of the local mobile emulator is recorded as an explicit scoped exception with named alternative routes, and no other documented workflow regresses.

## Assumptions

- **Phase 0 is complete and its evidence is authoritative.** The workstation preparation recorded in `E:\Programming\VSCode\p0-docker-sandbox-host-setup.md` was carried out before this specification. That evidence lives outside the repository today and should be brought into the feature directory so the migration record is self-contained.
- **The sandbox tooling is v0.38.0**, which is newer than the version the source proposal researched. Behaviour differences — particularly around declarative environment descriptions and remote-access defaults — are expected and must be verified rather than assumed from the proposal text.
- **Hardware virtualisation is absent inside the microVM** (gate R2, resolved negative during Phase 0). The local Android emulator therefore does not survive the migration. Mobile end-to-end flows run in CI — already the recommended route for assistant flows — or on the retained existing environment on demand.
- **The Android toolchain stays in the environment image.** Dropping it would fork the toolchain description for one unavailable capability; the existing preparation step already no-ops cleanly where virtualisation is absent. Only the emulator capability is lost, not the toolchain.
- **The in-container egress firewall is retained as defense-in-depth** for this migration. Retiring it in favour of the sandbox policy alone is deliberately a later decision, taken once the audit trail has earned trust.
- **The existing environment is retained** for non-assistant local use and as the mobile-emulator fallback. This migration retires it for assistant sessions only.
- **A variant configuration is used during the migration**, collapsing to a single configuration at adoption, so the existing environment keeps working throughout.
- **The target is the Windows 11 workstation only.** Migrating the AI-assisted workflow to a Linux host is a separate long-term alternative and is out of scope.
- **Forge reachability through the sandbox's egress proxy is unproven** and is the feature's hard gate. A negative outcome is a legitimate result that stops the feature at User Story 2.
- **Pushing remains the only durable backup** of work in progress; destroying the sandbox discards anything unpushed.
- **Team reproducibility is desirable, not required.** A snapshot satisfying single-workstation recreate is sufficient; a fully declarative team description is a bonus.

## Out of Scope

- Replacing the dev container with a directly provisioned sandbox environment (no dev container at all).
- Retiring the in-container egress firewall in favour of sandbox policy alone.
- Per-container egress policy granularity within the microVM.
- Migrating the AI-assisted workflow to the Linux homelab host.
- Any change to CI, to production, or to application code.
