# Feature Specification: Prod/CI Shared-Host Port Isolation & Keycloak DB-Network Resilience

**Feature Branch**: `029-prod-ci-port-isolation`

**Created**: 2026-07-06

**Status**: Draft

**Input**: User description: "Prod/CI shared-host port isolation and Keycloak DB-network resilience (hardening born from the 2026-07-06 prod-auth outage)."

## Context

The production stacks and the CI runner run on **one physical homelab host**, under two separate rootless container daemons that publish ports into the **same host port space**. On 2026-07-06 the production identity service went down: feature 028 had changed its admin UI port to bind **all host interfaces**, which then collided with the CI end-to-end test suite's own identity service bound on the host's loopback interface using the **same port number**. Whenever CI had that service running, the production identity service could not bind its port on a redeploy/restart, failed to start, was stranded from its networks, and crash-looped — taking prod auth (and therefore the whole app's login) offline. A leftover CI stack that had been running for hours held the port and made every prod recreate fail.

Two independent fragilities were exposed: (1) a **host-port collision** between prod and CI, and (2) a **container-network re-attach race** where the identity service could come back missing the internal network to its own database. This feature hardens both so a prod redeploy or reboot is safe regardless of CI activity, and prevents recurrence with an automated guard.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prod auth survives redeploy/reboot regardless of CI activity (Priority: P1)

As the homelab operator, when I redeploy or reboot production while CI is running its test suite (which stands up its own copies of the same services), the production identity service must still start cleanly and stay healthy — its admin port must never contend with CI for the same host port.

**Why this priority**: This is the outage. A prod deploy that races a CI run currently takes production authentication offline. The whole application depends on it.

**Independent Test**: With the CI test stacks up (holding their host ports), redeploy the production auth stack and confirm the production identity service binds its admin port, starts, and reports healthy — no "address already in use", no crash-loop.

**Acceptance Scenarios**:

1. **Given** the CI test suite has its identity service running on the shared host, **When** the production auth stack is redeployed, **Then** the production identity service binds its admin port successfully and reaches a healthy state.
2. **Given** production auth is healthy, **When** its admin UI is opened over the private network, **Then** it responds on its production-reserved port.
3. **Given** the production admin port change, **When** the identity service issues tokens, **Then** the public issuer/discovery endpoint is unchanged (the port change affects only the private admin surface, not the public auth hostname).
4. **Given** a request from outside the private network to the production admin port, **Then** it is refused by the host firewall (exposure posture unchanged).

---

### User Story 2 - Prod auth always reaches its own database on recreate (Priority: P1)

As the homelab operator, whenever the production auth stack is recreated (redeploy/reboot), the identity service must always be able to resolve and reach its **own** database, even if the shared cross-stack networks briefly fail to re-attach.

**Why this priority**: The same outage also showed the identity service coming back unable to resolve its database host (a network re-attach race), independently of the port issue. Without its database it crash-loops regardless of the port fix.

**Independent Test**: Recreate the auth stack repeatedly and confirm the identity service always resolves its database host and starts — the database link is created and attached as part of the stack bring-up, not dependent on a pre-existing shared resource.

**Acceptance Scenarios**:

1. **Given** the auth stack is recreated, **When** the identity service starts, **Then** it resolves its database host name and connects on the first start attempt.
2. **Given** a recreate in which the shared cross-stack networks are slow/fail to re-attach, **When** the identity service starts, **Then** its database connectivity is unaffected (the DB link is owned by the auth stack, not a shared external resource).
3. **Given** the change to how the DB link is managed, **When** the stack is deployed, **Then** the database data is preserved (no data loss from the network-management change).

---

### User Story 3 - A config change can never reintroduce a prod/CI port collision (Priority: P2)

As a developer changing any compose file, I need an automated check that fails my change if a production-published host port would overlap a CI/dev-published host port, so the outage class cannot recur through a future edit.

**Why this priority**: The fix for US1 is only durable if it's enforced. Without a guard, a future prod or CI service could pick an overlapping port and silently reintroduce the collision. Important, but preventative rather than the outage itself.

**Independent Test**: Introduce a deliberate overlapping port in a prod compose and confirm the guard fails; remove it and confirm the guard passes; run the guard's self-test.

**Acceptance Scenarios**:

1. **Given** the guard, **When** it scans the production and CI/dev compose files and finds no overlapping published host port, **Then** it passes.
2. **Given** a production compose that publishes a host port also published by a CI/dev compose, **When** the guard runs, **Then** it fails and names the offending port and files.
3. **Given** the guard is wired into the automated checks, **When** any change is proposed, **Then** the guard runs as part of the required checks with a self-test proving it detects a planted collision.

---

### User Story 4 - CI never leaves stacks holding host ports (Priority: P2)

As the homelab operator, every CI end-to-end run must tear down the stacks it brought up — even when the run fails or is cancelled — so a leftover CI stack can never linger holding a host port that a production redeploy needs.

**Why this priority**: A 6-hour-old leftover CI stack held the port during the incident. Teardown hygiene removes the most common trigger. Important but secondary to the structural port partition (US1), which protects prod even if a CI stack is up.

**Independent Test**: Force a CI run to fail mid-suite and confirm the auth and app stacks it created are torn down by the end of the job; confirm no CI stack remains holding a host port afterward.

**Acceptance Scenarios**:

1. **Given** a CI end-to-end run that completes successfully, **When** the job ends, **Then** the stacks it started are removed.
2. **Given** a CI end-to-end run that fails or is cancelled mid-suite, **When** the job ends, **Then** the stacks it started are still removed (teardown runs regardless of outcome).

---

### Edge Cases

- **Concurrent prod redeploy + CI run**: after this feature, they must not contend for any host port (structural guarantee, not timing-dependent).
- **Public issuer unchanged**: the admin-port move must not alter the public auth hostname/issuer that clients and backend services validate against.
- **Data preservation**: changing how the DB link network is managed must not remove the database's data volume.
- **Firewall dependency**: the admin ports remain bound on all host interfaces and stay private-only via the host firewall default-deny; that dependency is documented and must not be weakened.
- **Guard false-positives**: the collision guard must not flag a prod port and a CI port that are the *same number* but genuinely cannot co-exist on the host only when they actually would collide (i.e., it compares host-published ports, and must have a self-test to prove correct detection).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every production-published admin/UI host port MUST be moved into a documented **production-reserved port range** that does not overlap any CI/dev-published host port. This applies to all currently-published prod admin ports (the identity admin console, and the two observability UIs), not only the one that collided.
- **FR-002**: The production identity service admin port MUST no longer share a host port number with the CI/dev identity service; after the change, a prod redeploy MUST succeed while the CI identity service is running.
- **FR-003**: The production admin ports MUST keep binding all host interfaces (retaining feature 028's boot-race fix) and MUST remain private-only via the host firewall default-deny; this firewall dependency MUST be documented.
- **FR-004**: Any admin hostname/URL configuration tied to a moved port (e.g., the identity admin console URL) MUST be updated to the new port so the admin surface remains reachable.
- **FR-005**: The public auth issuer/discovery surface MUST be unchanged by this feature (the port move affects only the private admin surface).
- **FR-006**: A guard MUST statically scan production compose files and CI/dev compose files and FAIL if any production-published host port overlaps a CI/dev-published host port; it MUST name the offending port and files, and MUST provide a self-test that proves it detects a planted collision.
- **FR-007**: The collision guard MUST be wired into the repository's automated required checks so every proposed change is evaluated.
- **FR-008**: The intra-stack network linking the production identity service to its own database MUST be managed by the auth stack itself (created and attached atomically on every bring-up), rather than depending on a pre-existing shared/external resource — so the identity service can always reach its database on recreate.
- **FR-009**: The genuinely cross-stack shared networks (used by multiple stacks) MUST remain shared/external; only the intra-stack database link changes ownership.
- **FR-010**: Changing how the database link network is managed MUST NOT remove or reset the database's persisted data.
- **FR-011**: The CI end-to-end job MUST tear down every stack it brings up at the end of the run, including when the run fails or is cancelled.
- **FR-012**: All changes MUST contain no secret and no real topology value (base domain, private-network host name, private-network IP) in any git-tracked file, and MUST be deployable through the existing standard deploy mechanism, landing via pull request to the main branch.
- **FR-013**: A production-reserved port-range convention MUST be documented so future production services pick non-overlapping ports by construction.

### Out of Scope

- Moving CI and production onto separate physical hosts.
- Changing the CI/dev services' own port numbers.
- Reverting feature 028's all-interfaces bind back to a private-interface-scoped bind.
- Any change to the public auth hostname, issuer, or the cross-stack shared networks' external status.

### Key Entities

- **Production-reserved port range**: the documented band of host ports production admin UIs publish from, guaranteed disjoint from CI/dev ports.
- **Published host port**: a host-side port a compose file exposes; the unit the collision guard compares across prod vs CI/dev.
- **Collision guard**: the static check that fails on any prod↔CI/dev host-port overlap.
- **Intra-stack database link**: the network connecting the identity service to its own database; moves from shared/external to auth-stack-owned.
- **CI end-to-end teardown**: the always-run cleanup that removes CI stacks so none linger holding host ports.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the CI test stacks running, a production auth redeploy succeeds and the identity service reaches healthy with **zero** "address already in use" failures and zero crash-loop restarts.
- **SC-002**: Across repeated auth-stack recreates, the identity service resolves and connects to its database on the **first** start attempt 100% of the time.
- **SC-003**: 100% of production-published admin host ports fall within the documented production-reserved range and have **zero** overlap with any CI/dev-published host port.
- **SC-004**: The collision guard fails on a planted prod↔CI port overlap and passes on the clean tree (self-test green), and runs in the required automated checks.
- **SC-005**: A CI end-to-end run that is forced to fail mid-suite leaves **zero** CI stacks/containers holding host ports afterward.
- **SC-006**: The public auth issuer/discovery endpoint is byte-for-byte unchanged before and after the feature (no client/backend re-configuration required).
- **SC-007**: No secret or real topology literal appears in any changed git-tracked file (secret-scan, inline-secret, and topology-scrub guards pass), and the change deploys via the existing mechanism.

## Assumptions

- The host firewall default-denies all non-private-network inbound, so an all-interfaces bind remains private-only in practice (feature 028 posture, reused).
- The CI/dev services' published host ports are the authoritative "CI/dev port set" the guard compares against; CI keeps its current ports (out of scope to change them).
- The database's data lives on a persisted volume that is not removed by re-managing the intra-stack network (external/named data volume).
- The operator will perform a clean redeploy of the production auth stack after this feature merges; until then production auth runs via a manual network re-attach and MUST NOT be redeployed.
- The intra-stack database-link network has no consumer outside the auth stack (verified during planning), making it safe to convert from shared/external to stack-owned.
