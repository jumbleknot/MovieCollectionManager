# Feature Specification: Production Data-Tier Authentication & Secrets-Management Standard

**Feature Branch**: `026-prod-data-auth-vault`

**Created**: 2026-07-04

**Status**: Draft

**Input**: User description: "Deferred production-hardening feature covering two workstreams from docs/proposals/prod-hardening/PRD-Data-Auth-and-Vault.md. Workstream A: enable MongoDB authentication in prod — SCRAM credentials plus a replica-set keyfile for internal member auth, accounting for the populated-volume migration caveat (auth must be enabled without destroying existing mc_db data). Workstream B: a decision workstream — evaluate and decide whether to ratify Komodo Variables as the standard prod secrets mechanism, or adopt HashiCorp Vault as the prod secrets backbone (Vault is currently deployed dormant and agent-layer-only/optional from feature 025). Sequencing: Workstream A is implemented first, but Workstream B's direction must be decided before over-investing in A's static credential design, because Vault's dynamic database secrets engine could supersede static SCRAM creds. Both workstreams belong to this single feature."

## Overview

This is a **production defense-in-depth hardening** feature with two workstreams. Neither closes an active exposure (production is network-segmented with no host-published ports), but both replace a single protective layer with a second one for the production data tier and its secrets.

- **Workstream A — Data-tier authentication.** The two production MongoDB stores (movie data and the BFF per-user agent-config store) are currently unauthenticated, protected only by Docker network scope. Add credential-based authentication so a compromised or misattached peer on the datastore's network can no longer read or write data without a credential — done without losing existing production data.
- **Workstream B — Secrets-management standard.** Decide and document a single sanctioned production secrets mechanism: either **ratify** the current masked-Komodo-Variables approach as the standard, or **adopt** a dedicated secrets manager (Vault) as the production backbone. The decision must be made before over-investing in Workstream A's static-credential tooling, because a dynamic-database-credential capability would supersede static datastore passwords.

The primary beneficiaries are **operators and the security owner**; there is no end-user-visible behavior change (the application must continue to function identically).

## Clarifications

### Session 2026-07-04

- Q: What downtime tolerance governs the MongoDB auth cutover on the populated production volumes? → A: Extended scheduled window, ≤ 1 hour per store — a stop-start cutover prioritizing safety and verification (unhurried count checks + rollback checkpoints between steps) over speed; zero-downtime rolling is not required.
- Q: How should the populated-volume migration be rehearsed before touching production? → A: Rehearse the full cutover against a restored snapshot of the production volume in an isolated scratch environment (verify counts + rollback there) before scheduling the production window.
- Q: Does Workstream A use static SCRAM credentials or dynamic (Vault-issued) database credentials? → A: Static SCRAM in feature 026. The "Bounded" scope decision defers the full secrets-manager rollout (including any Vault dynamic-DB-credentials engine) to a follow-up feature, so A ships static least-privilege SCRAM users regardless of the US2 direction; if a manager is later adopted, the follow-up rollout may replace them with dynamic credentials.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enforce authentication on production data stores (Priority: P1)

As the security owner, I need both production MongoDB stores to require a credential, so that network reachability alone no longer grants read/write access to movie data or the per-user agent-config store.

**Why this priority**: This is the concrete, self-contained security improvement and the highest-value item. It is independently valuable even if the secrets-standard decision (US2) lands on the status quo.

**Independent Test**: From a peer on the datastore's network, an anonymous connection to either production Mongo is rejected with an authentication error; the owning service (mc-service / BFF) continues to operate normally using a least-privilege credential; and record/collection counts are identical before and after the cutover.

**Acceptance Scenarios**:

1. **Given** a production Mongo with authentication enabled, **When** a client connects with no credential, **Then** the connection is rejected with an authentication error.
2. **Given** the owning service configured with its least-privilege application credential, **When** the application performs its normal reads and writes, **Then** all operations succeed exactly as before authentication was enabled.
3. **Given** a populated production datastore volume, **When** authentication is enabled via the cutover procedure, **Then** all pre-existing data is preserved (verified record/collection counts match before and after).
4. **Given** authentication is enabled, **When** the application connects, **Then** it uses a scoped application identity limited to its own database — not an administrative/root identity.
5. **Given** the replica-set member(s), **When** they communicate internally, **Then** internal member authentication is enforced (no anonymous member can join the set).
6. **Given** the change is committed, **When** the repository secret-scanning gates run, **Then** no credential or key material is present in version control and the gates stay green.

---

### User Story 2 - Ratify a single production secrets-management standard (Priority: P1)

As the security owner, I need one documented, sanctioned mechanism for production secrets, so that there is a clear standard (no ambiguity or dual mechanisms) governing where production secrets live and how they are injected.

**Why this priority**: The decision gates US1's credential-storage design — the team must not over-invest in tooling for storing static datastore passwords one way if the sanctioned direction is a secrets manager that issues them differently. Producing the decision is cheap; making it late is expensive.

**Independent Test**: A decision record exists that names exactly one sanctioned production-secrets mechanism, gives the rationale, enumerates every production secret category it governs, and states how the existing optional agent-layer secrets path is reconciled so there is a single mechanism rather than two.

**Acceptance Scenarios**:

1. **Given** the two candidate directions (ratify the current variable-injection approach vs adopt a dedicated secrets manager as the backbone), **When** the decision is recorded, **Then** exactly one is selected with documented rationale and trade-offs (rotation, lease/TTL, audit, operational burden, availability-on-deploy).
2. **Given** the selected mechanism, **When** the decision record is reviewed, **Then** every production secret category (identity-provider DB and bootstrap, BFF client/cookie/subject-token secrets, agent gateway and agent-DB secrets, and the datastore credentials from US1) is mapped to that one mechanism.
3. **Given** an existing optional secrets path already wired for the agent layer, **When** the decision is applied, **Then** the record states whether that path is kept, unified, or retired — leaving no dual mechanism ambiguity.
4. **Given** the decision, **When** it is checked against the project constitution, **Then** it is compliant (both candidate directions are permitted by the Secrets Management principle; the record notes which is a ratification vs an enhancement).

---

### User Story 3 - Produce the secrets-backbone migration plan (Priority: P3, conditional)

As an operator, if the US2 decision adopts a dedicated secrets manager as the backbone, I need a documented, actionable migration plan for moving every core-stack production secret onto that manager, so that the rollout can be executed as a well-scoped follow-up feature without re-deriving the design.

**Why this priority**: Conditional and lower priority — it applies **only** if US2 selects the "adopt a secrets manager" direction. If US2 ratifies the status quo, this story is not executed. **Scope decision (2026-07-04): the full core-stack rollout is deliberately deferred to a follow-up feature.** This feature (026) delivers Workstream A + the ratified US2 decision + (if a manager is adopted) this migration plan — it does **not** perform the full core-stack secret migration itself. That keeps 026 bounded and shippable.

**Independent Test**: A documented migration plan exists that enumerates every core-stack secret category, sequences the migration, defines the rotation procedure, defines the behavior when the manager is unavailable at deploy, defines the "secret-zero" bootstrap for the injector, and states how the previously-optional agent-layer path is unified into the single mechanism.

**Acceptance Scenarios**:

1. **Given** the adopted secrets manager, **When** the migration plan is reviewed, **Then** every core-stack secret category is listed with its target location and a migration sequence.
2. **Given** the plan, **When** rotation is described, **Then** a rotation procedure is documented that requires no code change to execute.
3. **Given** the plan, **When** manager-unavailable-at-deploy is considered, **Then** the fallback/blocking behavior is defined (no silent clear-text fallback).
4. **Given** the per-user bring-your-own-credentials model, **When** the plan is written, **Then** it states that user-provided provider credentials remain per-run and are never centralized into the shared secrets manager.
5. **Given** the plan, **When** the "secret-zero" bootstrap is considered, **Then** how the deploy-time injector authenticates to the manager is defined and does not reintroduce a clear-text secret in git.

---

### Edge Cases

- **Auth enabled on an already-initialized datastore**: the cutover must move an initialized, populated store from no-auth to enforced-auth without a destroy-and-recreate — a staged transition, rehearsed on a copy of the data before touching production.
- **Replica-set initialization after auth is on**: the one-time set-initialization/reconfigure step must itself present the administrative credential once authentication is active.
- **Keyfile permissions too permissive**: the internal-member-auth key must be rejected by the datastore if group/world-readable — provisioning must set restrictive ownership/permissions or the service refuses to start.
- **Rollback**: if the cutover fails partway, there must be a defined path back to the last-known-good state without data loss.
- **Secrets-manager "secret-zero" bootstrap** (US3 only): how the deploy-time injector authenticates to the manager must be defined and must not itself reintroduce a clear-text secret in git.
- **Both datastores treated uniformly**: the movie-data store and the BFF agent-config store must both be authenticated so the pattern is consistent (not one hardened and one left open).

## Requirements *(mandatory)*

### Functional Requirements

**Workstream A — Data-tier authentication**

- **FR-001**: Both production MongoDB stores (movie data and the BFF agent-config store) MUST require authentication; an anonymous connection MUST be rejected.
- **FR-002**: Each owning service MUST connect using a least-privilege application identity scoped to only its own database; an administrative/root identity MUST NOT be used at application runtime.
- **FR-003**: Internal replica-set member authentication MUST be enforced (a shared key or equivalent) so no unauthenticated member can join the set.
- **FR-004**: Enabling authentication MUST preserve all pre-existing production data — verified by matching record/collection counts before and after the cutover.
- **FR-005**: The cutover procedure MUST be documented and rehearsed against a restored snapshot of the production volume in an isolated scratch environment (verifying record/collection counts and the rollback path there) before being applied to production, and MUST include a rollback path that does not lose data.
- **FR-006**: No credential, password, or key material introduced by this feature MAY appear in version control; the existing inline-secret and whole-tree secret-scan gates MUST remain green.
- **FR-007**: All datastore credentials and key material MUST be provisioned through the sanctioned secrets mechanism selected in US2 (fail-fast when unset; no clear-text default/fallback).
- **FR-008**: The one-time replica-set initialization/reconfiguration tooling MUST authenticate with the administrative credential once authentication is enabled.
- **FR-009**: Development and CI environments MUST remain on their existing simpler (unauthenticated-datastore) flow — this feature changes production posture only.

**Workstream B — Secrets-management standard**

- **FR-010**: The feature MUST produce a single documented decision selecting exactly one sanctioned production-secrets mechanism (ratify the current variable-injection approach, or adopt a dedicated secrets manager as the backbone).
- **FR-011**: The decision MUST be made before Workstream A's static-credential storage tooling is finalized, so that A's credential handling aligns with the chosen direction.
- **FR-012**: The decision record MUST enumerate every production secret category and map each to the chosen mechanism.
- **FR-013**: The decision MUST reconcile the existing optional agent-layer secrets path so exactly one mechanism governs production secrets (no unexplained dual mechanism).
- **FR-014**: The decision MUST preserve the "no clear-text in git + fail-fast on unset" guarantees and the per-user bring-your-own-credentials model (user provider credentials remain per-run, never centralized).
- **FR-015**: The decision MUST be recorded as compliant with the project constitution's Secrets Management principle, noting whether it is a ratification of the status quo or an enhancement.
- **FR-016** *(conditional on US2 selecting the adopt-a-manager direction)*: The feature MUST produce a documented migration plan for moving every core-stack production secret onto the adopted manager — enumerating secret categories, migration sequence, rotation procedure, manager-unavailable behavior, injector "secret-zero" bootstrap, and agent-layer unification. The full core-stack rollout itself is deferred to a follow-up feature and is NOT executed here.

### Key Entities *(include if feature involves data)*

- **Production datastore**: a movie-data store and a BFF agent-config store; each currently unauthenticated, each reachable by exactly one owning service after network scoping.
- **Application identity**: a least-privilege credential per owning service, scoped to that service's database only.
- **Administrative identity**: a privileged credential used only for one-time setup/initialization, never at application runtime.
- **Internal-member key**: shared key material enforcing authentication between replica-set members.
- **Production secret category**: a class of production secret (identity-provider DB/bootstrap, BFF client/cookie/subject-token, agent gateway/agent-DB, datastore credentials) governed by the chosen secrets mechanism.
- **Secrets-management decision record**: the single authoritative document naming the sanctioned mechanism, its rationale, the secret-category mapping, and the agent-layer reconciliation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of production MongoDB stores reject an unauthenticated connection (both stores, verified).
- **SC-002**: 0 application-runtime connections use an administrative/root identity — every service connects with a least-privilege, database-scoped identity.
- **SC-003**: 0 records lost across the authentication cutover — pre- and post-cutover record/collection counts match exactly for both stores.
- **SC-004**: The application's end-user behavior is unchanged after the cutover — the full end-to-end regression passes with no functional difference attributable to authentication.
- **SC-005**: 0 credentials or key material added by this feature appear in version control; all secret-scanning gates stay green.
- **SC-006**: Exactly 1 sanctioned production-secrets mechanism is documented, with 100% of production secret categories mapped to it and the agent-layer path explicitly reconciled.
- **SC-007**: The authentication cutover for each store completes within a scheduled maintenance window of ≤ 60 minutes, using a reversible procedure that was rehearsed at least once against a restored production-volume snapshot in a scratch environment before production.
- **SC-008** *(conditional on the adopt-a-manager decision)*: A migration plan exists covering 100% of core-stack production secret categories, with a documented rotation procedure, defined manager-unavailable behavior, and defined injector bootstrap — ready to execute as a follow-up feature (the rollout itself is out of scope for 026).

## Assumptions

- **Milestone B stability**: production full-app stacks are already live and stable; this feature layers on top of the existing network-segmentation posture rather than replacing it.
- **Both datastores in scope for Workstream A**: the movie-data store and the BFF agent-config store are both authenticated for a uniform pattern (per the source PRD).
- **Planned maintenance window is acceptable**: a scheduled downtime of up to 1 hour per store for the authentication cutover on the populated production volumes is acceptable for this homelab-class production environment; the cutover is a safety-first stop-start (unhurried verification + rollback checkpoints), and zero-downtime rolling cutover is explicitly not required.
- **Rehearsal environment**: a scratch environment can be provisioned and a production-volume snapshot restored into it to rehearse the cutover at full fidelity before the production window.
- **Static application credentials as the default for Workstream A**: unless the US2 decision selects a dynamic-database-credential capability, Workstream A uses static least-privilege application credentials; if US2 selects a manager with dynamic DB credentials, A's credential handling adapts to issue short-lived credentials instead.
- **US2 decision precedes US1 finalization**: the secrets-standard direction is decided before Workstream A's credential-storage tooling is locked in, per the source PRD's sequencing.
- **Scope excludes**: network-model changes, service mesh / mutual-TLS between services, and changes to at-rest payload encryption — all explicitly out of scope per the source PRD.
- **Existing agent-layer secrets path**: an optional, environment-gated secrets path already exists for the agent layer (feature 025); US2 decides its fate rather than assuming it.
- **Source artifacts**: `docs/proposals/prod-hardening/PRD-Data-Auth-and-Vault.md` (primary), `docs/PRD-Vault.md` (context), and `docs/runbooks/prod-control-tower.md` (feature 025 operational context) inform this feature.
