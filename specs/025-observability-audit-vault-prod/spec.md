# Feature Specification: Production Observability, Audit & Vault Stacks

**Feature Branch**: `025-observability-audit-vault-prod`

**Created**: 2026-07-03

**Status**: Draft

**Input**: User description: "from docs/proposals/prod-hardening/PRD-024-Observability-Audit-Vault-Prod.md → feature 024-observability-audit-vault-prod"

## Overview

The application's four production stacks (auth, movie-service, BFF, movie-assistant) are live, deployed as config-as-code. The supporting **Control Tower** capabilities — LLM observability, infrastructure telemetry, policy enforcement, feature flags, and append-only audit — were built earlier as env-gated, no-op-by-default integrations that currently only run in the development environment. This feature promotes those capabilities to production as new independently-deployable stacks and then wires the running production application to emit to them.

A deliberate operator-safety property runs through the whole feature: promoting a capability to production is a two-step, reversible act — first the supporting service is deployed (running but unused), then the production application is switched to consume it. Turning the consumption off again returns the application to its prior behavior with no code change.

## Clarifications

### Session 2026-07-03

- Q: When the authorization-policy engine is enabled in production but unreachable at request time, how should policy-guarded assistant actions behave? → A: Fail-closed — deny the guarded action (secure default, matches the project's default-deny posture). This is distinct from the unset/no-op contract, where policy is intentionally not enforced at all.
- Q: Should the prod-observability stack run always-on or opt-in? → A: Always-on, with explicit memory caps on the heavy services (continuous LLM/infra capture); opt-in is only a fallback if the host capacity check fails.
- Q: How is the write-only `agent-audit` user provisioned in production? → A: A one-shot init service in the audit stack runs the provisioning script and exits — self-provisioning and reproducible (no manual operator step), skipping cleanly when its password env is unset.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tamper-evident agent audit trail in production (Priority: P1)

An operator needs an independent, append-only record of what the AI assistant did on behalf of users in production — who asked for what, which actions were authorized or denied — stored so that the writing service itself cannot alter or erase history after the fact.

**Why this priority**: Highest security value for the least effort — one service, one secret, one consumer wiring. It gives production a forensic trail that survives compromise of the writing service, and it is the smallest, lowest-risk slice, making it the safest first promotion.

**Independent Test**: Deploy the audit stack alone, wire the production BFF/assistant to it, drive one assistant action end-to-end, and confirm a corresponding audit record appears in the store and that the writing credential cannot read back, modify, or delete existing records.

**Acceptance Scenarios**:

1. **Given** the audit stack is deployed but not yet consumed, **When** the operator inspects it, **Then** the stack reports healthy and the running application's behavior is unchanged (no audit records written).
2. **Given** the production application is wired to the audit store, **When** a user drives an assistant action that authorizes or denies an operation, **Then** a corresponding audit event is written to the append-only store.
3. **Given** an audit event exists, **When** the writing credential attempts to modify, delete, or read back existing audit history, **Then** the operation is rejected (write-only enforcement).
4. **Given** the audit store is unreachable or the audit env is unset, **When** the application handles a request, **Then** the request still succeeds (audit is best-effort, never a hard dependency).

---

### User Story 2 - LLM & infrastructure observability, policy, and feature flags in production (Priority: P2)

An operator needs visibility into what the AI assistant costs and how it behaves per turn in production (traces, latency, cost), infrastructure telemetry across services, the ability to enforce runtime authorization policy, and the ability to flip operational feature flags (kill-switch, escalation, degrade) without redeploying.

**Why this priority**: High operational value but the largest and heaviest stack (analytics database, telemetry collector, policy engine, flag service), so it follows the audit slice and requires a capacity check before enabling. Bundled because these services deploy and are consumed as one operational unit.

**Independent Test**: Deploy the observability stack, confirm each service is healthy, wire the production application, then independently verify: one LLM turn produces a trace; infrastructure activity produces telemetry; a policy denial is enforced; and toggling a feature flag changes application behavior without a redeploy.

**Acceptance Scenarios**:

1. **Given** the observability stack is deployed but not yet consumed, **When** the operator inspects it, **Then** every service reports healthy and the running application's behavior is unchanged.
2. **Given** the production application is wired to LLM observability, **When** a user completes one assistant turn, **Then** at least one per-turn trace (with cost/latency) is recorded and viewable.
3. **Given** the production application is wired to infrastructure telemetry, **When** the application handles traffic, **Then** at least one telemetry signal (trace/metric) from the application is visible in the telemetry backend.
4. **Given** a policy that denies a specific action is active, **When** a user attempts that action via the assistant, **Then** the action is denied and the denial is enforced by the running application.
5. **Given** an operational feature flag (e.g., assistant kill-switch), **When** the operator flips it, **Then** the application's behavior changes accordingly without any redeploy.
6. **Given** any observability env var is unset, **When** the application runs, **Then** the corresponding integration is a silent no-op and behavior is unchanged.

---

### User Story 3 - Dormant production-grade Vault, ready for future adoption (Priority: P3)

An operator wants a production-shaped secrets service present in the production environment now — persistent, secure, and ready to be initialized the day it is adopted — without adopting it as the secrets backbone yet and without shipping an insecure development-mode server that would lose all data on restart.

**Why this priority**: Lowest immediate value (nothing consumes it yet) but explicitly decided IN for v1 so the environment is ready when adoption happens. It is deployed dormant, so it carries no operational tax and does not couple to the application.

**Independent Test**: Deploy the Vault stack, leave it uninitialized and sealed, and confirm it reports healthy in the deployment control plane while dormant, persists across a restart, and exposes no secret material in committed configuration.

**Acceptance Scenarios**:

1. **Given** the Vault stack is deployed uninitialized and sealed, **When** the deployment control plane evaluates its health, **Then** it reports healthy (dormant is a healthy state).
2. **Given** the Vault container is restarted, **When** it comes back up, **Then** its storage persists (no data loss) and it remains uninitialized/sealed.
3. **Given** the dormant Vault, **When** the committed configuration is inspected, **Then** no root token or secret material is present (it is not a development-mode server).
4. **Given** the dormant Vault, **When** the production application runs, **Then** nothing consumes Vault and application behavior is unchanged.

---

### Edge Cases

- **Capacity exhaustion**: The observability and audit stacks add several gigabytes of memory-hungry analytics/telemetry services to the production host alongside the running application. What happens if the host lacks headroom? Explicit memory caps must be set, and the heaviest stack must be capacity-checked before enabling.
- **Partial wiring**: A stack is deployed but the consumer env is only partially set — the application must degrade to no-op for the unset integrations, never fail.
- **Supporting service outage**: An observability/audit service becomes unreachable at runtime — the application must not fail user requests as a result (best-effort emission). The policy engine is the exception: when enabled but unreachable it fails-closed (denies the guarded action) rather than failing the whole request open.
- **Vault mistakenly initialized**: The dormant Vault must not be initialized as part of this feature; if it is initialized, that is out of scope and a separate adoption effort.
- **Restart tax**: A dormant, uninitialized Vault must not impose an unseal-on-restart burden while unused.

## Requirements *(mandatory)*

### Functional Requirements

**Stack deployment (supporting services)**

- **FR-001**: The system MUST deploy an append-only audit store to production as an independently-deployable stack, isolated so that only the assistant and BFF can reach it.
- **FR-002**: The audit store MUST enforce write-only access for the application's audit credential (no read-back, modify, or delete of existing records). The write-only audit user MUST be provisioned by a self-contained, one-shot init step in the stack (runs then exits), reproducible on a fresh deploy with no manual operator action, and skipping cleanly when its provisioning password is unset.
- **FR-003**: The system MUST deploy an observability stack to production containing LLM-turn observability, infrastructure telemetry, runtime authorization policy, and a feature-flag service, each independently healthy. The stack MUST run always-on with explicit memory caps set on the memory-heavy services (analytics database, JVM services) so its footprint is bounded; opt-in operation is a fallback only if a host capacity check fails.
- **FR-004**: The system MUST deploy a production-grade secrets service (Vault) to production with persistent storage, deployed uninitialized and sealed (dormant), NOT in development mode.
- **FR-005**: The dormant secrets service MUST report healthy to the deployment control plane while uninitialized and sealed, and MUST persist its storage across restarts.
- **FR-006**: Every new stack MUST follow the established production convention: pinned upstream images (no build/scan/digest pipeline), fail-fast secret references, externally pre-created networks and volumes, internal-only (no published ports), healthchecks with ordered startup, and restart-on-failure.
- **FR-007**: Each new stack MUST be deployable and demonstrable independently of the others, and independently of consumption by the application.

**Application wiring (consumers)**

- **FR-008**: The system MUST allow the production application (BFF and assistant) to be switched to consume each new capability purely by setting environment configuration — with NO application code changes.
- **FR-009**: When a capability's environment configuration is unset, the corresponding integration MUST be a silent no-op that leaves the application's prior behavior unchanged (additive, reversible contract preserved).
- **FR-010**: Wiring the application to the new capabilities MUST be phaseable: deploying a supporting stack MUST NOT by itself change application behavior; behavior changes only when the consumer configuration is added.
- **FR-011**: The running application MUST NOT fail user requests when an observability or audit service is unreachable (best-effort emission). When the authorization-policy engine is enabled but unreachable, the application MUST fail-closed — deny the policy-guarded action (secure default). This differs from the unset/no-op contract (FR-009), where policy is intentionally not enforced.

**Secrets, topology & governance**

- **FR-012**: No clear-text secret or private topology (real hostnames, domains, tokens) may be committed to the repository for any new stack — all real secret values MUST be supplied via the deployment control plane's variable store at deploy time.
- **FR-013**: All committed configuration for the new stacks MUST pass the repository's automated secret-scan and topology-scrub guardrails.
- **FR-014**: Real secret values for the new stacks MUST be provisioned as deployment-control-plane variables, and consumer configuration MUST reference them the same way the existing production stacks do.
- **FR-015**: Internal service addressing MUST use container-name-based internal DNS only — no host/domain literals in committed configuration.

**Scope guards**

- **FR-016**: This feature MUST NOT change the CI build/scan/digest pipeline (all new services use upstream images).
- **FR-017**: This feature MUST NOT initialize the Vault service, migrate existing secret variables into Vault, or wire auto-unseal/deploy-time secret injection (secrets-backbone adoption is a separate, later effort).
- **FR-018**: This feature MUST NOT introduce database-authentication or other data-layer hardening changes unrelated to the three stacks above.

### Key Entities

- **Audit stack**: A production, network-isolated, append-only record of assistant actions/authorizations, writable but not readable/erasable by the application credential.
- **Observability stack**: The bundle of LLM-turn observability, infrastructure telemetry, runtime authorization policy, and feature-flag services deployed as one production unit.
- **Vault stack (dormant)**: A production-shaped, persistent, uninitialized/sealed secrets service present-but-unused, ready for a future adoption decision.
- **Consumer configuration**: The set of environment values that switch the production BFF/assistant from no-op to emitting/enforcing against the new stacks.
- **Deployment control-plane variables**: The store of real secret values injected at deploy time; the only place real secrets and private topology exist.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Each of the three new stacks reports healthy in the deployment control plane after deploy (audit; observability's full service set; dormant Vault reporting healthy while uninitialized/sealed).
- **SC-002**: After wiring, one production assistant turn produces at least one recorded per-turn LLM trace (with cost/latency), viewable by an operator.
- **SC-003**: After wiring, at least one infrastructure telemetry signal from the running production application is visible in the telemetry backend.
- **SC-004**: An authorization-policy denial configured in production is enforced against a real assistant action (the action is blocked).
- **SC-005**: A feature-flag change flipped by an operator takes effect on the running production application with no redeploy.
- **SC-006**: A real assistant action produces a corresponding audit event in the append-only store, and the application's audit credential cannot modify, delete, or read back existing audit records.
- **SC-007**: The dormant Vault persists its storage across a container restart and remains uninitialized/sealed with no secret material in committed configuration.
- **SC-008**: With every new capability's consumer configuration unset, the production application's behavior is byte-for-byte unchanged from before the feature (additive no-op contract holds).
- **SC-009**: All committed configuration for the feature passes the repository's secret-scan and topology-scrub guardrails (zero committed secrets/topology).
- **SC-010**: Each stack can be brought up, demonstrated, and torn down independently without affecting the running application or the other new stacks.

## Assumptions

- **Reuse of existing integrations**: The application-side integrations for observability, audit, policy, and flags already exist and are env-gated; enabling them in production requires only configuration, not code (per the source proposal, confirmed).
- **Upstream images only**: All new services run pinned upstream images and therefore skip the CI build/scan/digest pipeline and deploy purely from committed configuration plus control-plane variables — matching the existing Keycloak/auth stack model.
- **Capacity default (decided)**: The observability and audit services run **always-on** with explicit memory caps set (heap/analytics limits) so LLM/infra capture is continuous. A host capacity check precedes enabling the heavy observability stack; making it opt-in is a fallback only if that check fails, not the default.
- **Audit-user provisioning (decided)**: The write-only audit user is created at runtime by a one-shot init service in the audit stack (see Clarifications), from an environment-supplied password that skips cleanly when unset.
- **Policy delivery**: Authorization policies are delivered by mounting from the deployment checkout (matching the development layout), with the path confirmed to resolve under the deploy-time clone.
- **Networking**: New stacks attach to the appropriate shared/dedicated internal networks so that only the intended consumers (assistant/BFF) can reach them, mirroring existing service-isolation patterns.
- **Vault placement**: The dormant Vault is co-located with the production auth/identity stack (matching the development layout), splittable into a standalone stack later if its lifecycle diverges.
- **Vault dormancy**: v1 deploys Vault dormant only; initializing it and adopting it as the secrets backbone is explicitly deferred to a separate effort.
