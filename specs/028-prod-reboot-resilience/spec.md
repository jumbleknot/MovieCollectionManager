# Feature Specification: Prod Reboot-Resilience Follow-ups

**Feature Branch**: `028-prod-reboot-resilience`

**Created**: 2026-07-05

**Status**: Draft

**Input**: User description: "Prod reboot-resilience follow-ups: ensure the self-hosted production homelab comes back fully clean and hands-off after a host reboot, with fixes living in git so they survive Komodo ResourceSync deploys."

## Context

The production environment is config-as-code in this repository, deployed to a rootless-Docker homelab through a config-driven sync tool (Komodo ResourceSync from `infrastructure-as-code/komodo/stacks.toml`, branch `main`). On 2026-07-05 a kernel-upgrade reboot hard-killed the rootless containers and exposed several recovery defects. The host-side remediations (a graceful-shutdown drain unit, expanded database backup coverage, and UPS/NUT integration) are already done outside this repo. This feature delivers the remaining **repo/deploy-side** fixes so they land in git and survive every future deploy, plus a runbook that captures the whole recovery posture.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin & observability UIs reachable after an unattended reboot (Priority: P1)

As the homelab operator, after the production host reboots unattended (e.g. an automatic kernel-security reboot), every administrative and observability web UI must be reachable again over the private network without any manual intervention.

**Why this priority**: This was the most visible and highest-value failure — after the reboot the identity-management admin console and both observability dashboards showed as "running" but were silently not listening, because the container runtime started before the private-network interface was available and never learned its address. An operator returning to a rebooted box currently finds dead admin UIs with no obvious cause.

**Independent Test**: Reboot the host (or restart the container runtime so it starts before the private-network interface), then confirm each affected UI answers on its published port. Delivers value on its own: the operator regains admin/observability access hands-off.

**Acceptance Scenarios**:

1. **Given** the host has just rebooted and the container runtime started before the private-network interface was ready, **When** the operator opens the identity-management admin console over the private network, **Then** it responds normally (the published port is actually listening).
2. **Given** the same post-reboot state, **When** the operator opens each observability dashboard (metrics/traces UI and the tracing/analytics UI) over the private network, **Then** both respond normally.
3. **Given** the container runtime came up cleanly (private-network interface already present), **When** the stacks deploy, **Then** the UIs remain reachable exactly as before — no regression to the pre-existing working path.
4. **Given** a request originating from outside the private network, **When** it targets any of these published ports, **Then** it is refused by the host firewall (the exposure surface is unchanged — these UIs stay private-only).

---

### User Story 2 - Data service auto-recovers on container restart (Priority: P1)

As the homelab operator, when a data-tier container is restarted (by the restart policy after a reboot, or manually), it must recover cleanly and serve traffic — never enter a crash-loop.

**Why this priority**: After the reboot, the movie-collection data store's start-up wrapper crash-looped because a prior run left a read-only credential file in place that the wrapper could not overwrite. A crash-looping data store means the whole application is down ("failed to load collections") until an operator manually intervenes — directly defeating the hands-off recovery goal.

**Independent Test**: Start the data-store container, then restart it (not recreate) so the previous run's on-disk state persists, and confirm it reaches a healthy state on the second start instead of crash-looping. Delivers value on its own: the data tier survives restarts unattended.

**Acceptance Scenarios**:

1. **Given** a data-store container that has already run once and left its runtime credential file on disk, **When** the container is restarted, **Then** the start-up wrapper succeeds (no "permission denied" on the credential file) and the container reaches a healthy state.
2. **Given** a fresh data-store container (no prior on-disk state), **When** it starts for the first time, **Then** it behaves exactly as before — first-run behavior is unchanged.
3. **Given** the data store is healthy, **When** the application queries it after a restart cycle, **Then** collection data loads normally end-to-end.

---

### User Story 3 - Auth service retains backend connectivity after reboot (Priority: P2)

As the homelab operator, after a reboot the identity-management service must remain attached to every network its dependents need, so downstream services can complete their start-up discovery against it.

**Why this priority**: After the reboot the identity-management service came back missing one of its shared networks, which broke a downstream service's start-up discovery (it could not resolve the identity service by name and the app showed "failed to load collections"). This is important but lower-frequency than US1/US2, and the fix is primarily an operator redeploy plus confirming the declaration is durable.

**Independent Test**: Confirm the identity-management stack declaration attaches the service to all required shared networks, and that a redeploy through the standard sync tool reliably restores full attachment. Delivers value on its own: downstream discovery works after recovery.

**Acceptance Scenarios**:

1. **Given** the identity-management stack declaration, **When** it is reviewed, **Then** the service is declared as attached to every shared network its dependents require (including the shared backend network).
2. **Given** an identity-management container that came back after a reboot missing a shared network, **When** the operator performs the documented redeploy through the standard sync tool, **Then** full network attachment is restored durably (not via a manual one-off network reconnect).

---

### User Story 4 - Documented reboot-resilience posture & validation checklist (Priority: P3)

As the homelab operator, I need a single runbook that captures the full reboot-recovery posture — the already-completed host-side remediations, the repo/deploy-side fixes in this feature, the operator redeploy step, and a one-pass validation-reboot checklist — so recovery is repeatable and the knowledge is not lost.

**Why this priority**: Documentation does not itself restore service, so it is lowest priority — but it makes the recovery repeatable and gives the operator an authoritative validation procedure to confirm the box comes back clean.

**Independent Test**: A reviewer can follow the runbook end-to-end to understand every recovery control and execute the validation-reboot checklist without needing outside context.

**Acceptance Scenarios**:

1. **Given** the runbook, **When** the operator reads it, **Then** it documents the already-completed host-side fixes (graceful-shutdown drain, expanded database backups, UPS/NUT), the repo-side fixes in this feature, and the identity-service redeploy step.
2. **Given** the runbook's validation-reboot checklist, **When** the operator performs one validation reboot and follows the checklist, **Then** every recovery criterion (reachable UIs, no data-store crash-loop, no manual network reconnects, app loads end-to-end) has an explicit pass/fail check.

---

### Edge Cases

- **Runtime starts before the private-network interface**: the fix must not depend on the interface being present at runtime start — published ports must bind regardless of interface-address timing.
- **Widened bind vs. exposure**: moving a published port from a private-interface-scoped bind to an all-interfaces bind must not widen the actual reachable surface — the host firewall's default-deny for non-private inbound is what keeps these ports private.
- **Restart vs. recreate**: the data-store wrapper must be safe both when on-disk state persists (restart) and when it does not (recreate/fresh volume).
- **Idempotent init on other services**: any other start-up/init script that could be re-run on restart must remain safe to re-run (already the case for the audit, object-store bucket, and feature-flag seed init scripts — confirmed idempotent).
- **Restart policy coverage**: every production service must be configured to come back automatically after a reboot (restart policy present).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every production published port that is currently scoped to the host's private-network interface address MUST be changed so it binds independently of whether that interface address is known at runtime start, while remaining reachable only from the private network.
- **FR-002**: The three currently private-interface-scoped published ports — the identity-management admin console, and the two observability UIs (the metrics/traces dashboard and the tracing/analytics dashboard) — MUST each be reachable after a reboot in which the runtime started before the private-network interface was ready.
- **FR-003**: The exposure surface of those three ports MUST remain private-only after the change; reliance on the host firewall's default-deny for non-private inbound is acceptable and MUST be documented.
- **FR-004**: The data-store start-up wrapper MUST be idempotent with respect to its runtime credential file: a restart that finds a leftover read-only credential file MUST succeed rather than fail with a permission error.
- **FR-005**: The data-store start-up wrapper's first-run (fresh, no prior on-disk state) behavior MUST be unchanged by the idempotency fix.
- **FR-006**: The identity-management stack declaration MUST attach the service to every shared network its dependents require, including the shared backend network; if already present, no code change is required and the durable remediation MUST be captured as an operator redeploy step.
- **FR-007**: Every production service MUST have a restart policy that brings it back automatically after a host reboot (verify no gaps).
- **FR-008**: A runbook MUST document the full reboot-recovery posture: the already-completed host-side remediations, the repo/deploy-side fixes in this feature, the identity-service redeploy step, and a one-pass validation-reboot checklist with explicit pass/fail criteria.
- **FR-009**: All changed configuration MUST be deployable through the existing standard sync tool with no manual host-state edits, and land via a pull request to `main`.
- **FR-010**: No secret and no real topology value (base domain, private-network host name, private-network IP address) may appear in any git-tracked file; such values MUST remain externalized as deploy-time variables/placeholders. The repository's secret-scan, inline-secret, and topology-scrub gates MUST pass on the changed files.
- **FR-011**: Any private-interface-scoped bind variables that become unused by these changes MUST either be removed from the changed files or retained only where still referenced elsewhere (no orphaned fail-fast variable requirement that would break a deploy).

### Out of Scope

- Scheduled dependency-update automation (already shipped in a prior change).
- Host-side remediations themselves (graceful-shutdown drain unit, database backups, UPS/NUT) — these are already complete outside this repo and are only *documented* here, not implemented.
- Any change to the reachability posture of ports that are already all-interfaces-bound or unpublished.
- Initializing or unsealing the dormant secrets-management service (explicitly out of scope in its own stack).

### Key Entities

- **Published port binding**: the mapping that exposes a container port on the host; may be scoped to a specific interface address or to all interfaces. The private-interface-scoped variant is the one that fails when the interface address is unknown at runtime start.
- **Data-store start-up wrapper**: the entrypoint script that materializes a runtime credential file before handing off to the database process; must be safe to re-run.
- **Shared backend network**: the external network that lets downstream services discover the identity-management service by name.
- **Reboot-resilience runbook**: the operator document capturing host-side + repo-side recovery controls and the validation-reboot checklist.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a validation reboot in which the runtime starts before the private-network interface, 100% of the three affected admin/observability UIs are reachable over the private network with zero manual intervention.
- **SC-002**: A data-store container restarted over its own prior on-disk state reaches a healthy state on the first restart attempt, with zero crash-loop restarts.
- **SC-003**: After the validation reboot, the application loads collection data end-to-end with zero manual network reconnects performed by the operator.
- **SC-004**: 100% of the affected private-interface-scoped ports remain unreachable from outside the private network after the change (exposure surface unchanged).
- **SC-005**: All repository secret-scan, inline-secret, and topology-scrub gates pass on the changed files (zero findings).
- **SC-006**: The reboot-resilience runbook covers 100% of the recovery controls (host-side remediations, each repo-side fix, the redeploy step) and provides an explicit pass/fail check for every validation-reboot criterion.
- **SC-007**: Every production service has a restart policy verified present (zero gaps).

## Assumptions

- The host firewall default-denies all non-private-network inbound traffic, so all-interfaces binds remain private-only in practice (stated in the handoff; the runbook records this dependency).
- The identity-management stack already declares the shared backend network attachment; US3 is therefore expected to be a verification + operator-redeploy step rather than a code change (to be confirmed during planning against the actual declaration).
- The host-side remediations (graceful-shutdown drain, backups, UPS/NUT) are complete and correct; this feature only documents them.
- The standard sync tool and its variable store are the only mechanism for delivering deploy-time topology/secret values; the repository never contains the real values.
- The operator performs the single validation reboot after these changes merge and sync; that reboot is the end-to-end acceptance of the feature.
