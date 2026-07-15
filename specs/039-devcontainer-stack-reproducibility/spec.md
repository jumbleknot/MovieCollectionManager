# Feature Specification: Dev-Container Stack Reproducibility

**Feature Branch**: `039-devcontainer-stack-reproducibility`

**Created**: 2026-07-14

**Status**: Draft

**Input**: Close the three from-scratch reproducibility gaps surfaced by feature 038's final in-container sign-off, so any teammate on any fresh machine — a new dev container, a new clone, or a wiped data volume — reaches an identical, working environment without hand-rolled steps or operator intervention. Source: [PRD-DevContainerStackReproducibility.md](../../docs/proposals/PRD-DevContainerStackReproducibility.md) (3-gap version).

## Context

Feature 037 delivered a disposable, isolated dev container; feature 038 gave it the full toolchain and personal AI-assistant layer. The final in-container sign-off (038's T034 — the web E2E on the real dev path) proved the stack works **on the blessed setups** (a developer's long-lived host, CI, the version-pinned dev container) but **not truly from scratch**: three things had to be worked around by hand. Each is invisible on an established box because persistent data volumes and path-scoped CI hide them, so they only bite a genuinely clean environment — exactly the situation the dev container promises to make painless.

1. **The dev identity provider seeds no realm on a fresh data volume.** The authentication realm, its application clients, and the end-to-end test user exist only inside a persisted volume that was populated once, long ago, on each existing developer's machine. A fresh volume yields an empty identity provider, and login / token validation / the web E2E all fail with no obvious cause. This also turns the documented recovery for a stale-database-password crash (wipe the volume) into a second failure, because wiping the volume also erases the realm.

2. **The application compose stacks depend on one Docker Compose implementation's merge behavior.** The stacks parse and start on the newer Compose that the host and CI carry, but are rejected by the older Compose line that a plain package-manager install provides — so the stacks are not portable to an arbitrary conformant environment.

3. **A required continuous-integration check cannot report on unrelated changes.** A branch-protection-required check only runs when infrastructure files change; a change that touches only docs, dev-container config, or specs never triggers it, so it never reports a result, and the change cannot be merged through the normal path even when everything else is green — it requires a manual operator override every time.

This feature closes all three so from-scratch bring-up "just works," the stacks travel to any conformant environment, and small non-infrastructure changes merge without an override — while leaving the established-machine workflow, CI, and the production path unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A fresh environment stands up a working auth realm automatically (Priority: P1)

As a developer standing up the stack on a fresh machine (or after wiping the auth data volume), when I run the standard dev bring-up, the development authentication realm — including its application clients and the end-to-end test user — is present automatically, so login, token validation, and the web E2E work without any manual import or CI-only step.

**Why this priority**: This is the highest-impact gap. It bites **every** fresh container, every new teammate, and every volume wipe, and it directly contradicts the dev container's core promise. Without it, from-scratch onboarding and all authentication fail with no obvious cause. If only this ships, the single most painful onboarding failure is eliminated.

**Independent Test**: Delete the auth data volume, run the documented secret-generation step and the standard auth bring-up, then perform a login and confirm it succeeds — with no manual realm import, no CI overlay, and no hand-editing.

**Acceptance Scenarios**:

1. **Given** a freshly created auth data volume (no prior realm), **When** the developer runs the standard secret-generation step followed by the standard auth bring-up, **Then** the identity provider comes up with the development realm, all application clients, and the end-to-end test user present, and a BFF login succeeds with no manual import step.
2. **Given** an environment whose auth database password has drifted (the documented stale-password crash), **When** the developer applies the documented recovery of wiping the auth data volume and brings the auth stack back up, **Then** the realm is automatically re-seeded on that next bring-up and login works again — the recovery no longer leaves an empty identity provider.
3. **Given** the committed realm definition and the generated per-machine secrets, **When** the repository's secret-scanning and inline-secret checks run, **Then** they pass — the committed realm artifact contains only environment-variable placeholders and no literal secret value.

---

### User Story 2 - A required CI check reports on every change so unrelated work merges without an override (Priority: P2)

As a contributor opening a change that touches only documentation, dev-container config, or specs, when all applicable checks are green, I can merge through the normal path without asking an operator for a manual override, because the required check reports a result on my change — while a change that does touch infrastructure still runs the full scan and blocks on a real finding.

**Why this priority**: This is the cheapest fix and removes a recurring merge tax that this feature's own follow-up changes (docs, config) would otherwise keep paying. It is lower impact than the onboarding break (US1) but should land first because it unblocks everything else. Without it, every small non-infrastructure change needs operator intervention to merge.

**Independent Test**: Open one change that touches only non-infrastructure paths and confirm the required check reports success and the change merges through the normal path with no override; open one change that touches an infrastructure image reference and confirm the full scan runs and blocks on a fixable-critical finding.

**Acceptance Scenarios**:

1. **Given** a fully-green change that touches only non-infrastructure paths (docs / dev-container config / specs), **When** it is submitted for merge, **Then** the required check reports success on that change and it merges through the normal path with no manual operator override.
2. **Given** a change that adds or modifies an infrastructure image reference, **When** its checks run, **Then** the full image scan executes and the change is blocked if a fixable-critical vulnerability is found.
3. **Given** either kind of change, **When** its checks complete, **Then** the required check context is always present (reported as success when no scan was warranted, and as the real gate result when a scan ran) — it is never simply absent.

---

### User Story 3 - The stacks start identically on any conformant container tooling (Priority: P3)

As a developer or automated environment using any conformant version of the container-orchestration tooling — an older package-manager-provided version, the current version, or a future one — when I validate and start the application stacks, they parse and select the same set of services as on the currently-blessed setup, with no dependency on one implementation's merge behavior.

**Why this priority**: Currently dormant — the blessed setups are pinned to a version that works, so this does not actively break anyone today. But it is a latent portability landmine and a cheap, mechanical fix worth doing while the context is fresh, so a minimal or future environment can run the stacks unchanged.

**Independent Test**: Validate the stack configuration under both an older tooling version and the current one; confirm both succeed (no "conflicts with imported resource" style error) and that each profile selects exactly the same services as today.

**Acceptance Scenarios**:

1. **Given** an older container-orchestration tooling version that rejects the current merge behavior, **When** the developer validates the application stack configuration, **Then** it parses successfully with no conflict error.
2. **Given** the current tooling version, **When** the developer validates the same configuration, **Then** it still parses successfully.
3. **Given** either tooling version, **When** the developer selects a given run profile, **Then** the set of services started is identical to what that profile selects on today's blessed setup.

---

### Edge Cases

- **Volume exists but realm was hand-deleted** (partial state): bring-up should converge to a present, correct realm — re-seeding on a fresh/empty realm store without corrupting an already-seeded one on an established machine.
- **Established machine, established volume**: existing developers whose realm already lives in their persisted volume must see no disruption, no duplicate-import failure, and no forced re-seed on the next bring-up.
- **Realm client set drifts** from the CI or production client set over time: the development realm must stay consistent with the same source of truth so a from-scratch environment matches an established one.
- **A change touches both infrastructure and non-infrastructure paths**: the required check must still run the full scan and gate on it (the presence of an infrastructure change dominates).
- **Secret-generation step not yet run on a fresh box**: bring-up must fail clearly (missing per-machine secrets) rather than silently import a realm with unresolved placeholders.
- **A profile that today selects a specific service subset** (e.g. the non-secure BFF variant) must select exactly that subset after the portability change — no service added to or dropped from any profile.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On a freshly created auth data volume, the standard development auth bring-up MUST result in the development realm, all its application clients, and the end-to-end test user being present, with no manual import step and no continuous-integration-only overlay.
- **FR-002**: The realm seeding MUST be idempotent and non-destructive on an established environment: a machine whose realm already exists in its persisted volume MUST NOT be disrupted, duplicated, or forced to re-import on subsequent bring-ups.
- **FR-003**: Wiping the auth data volume (the documented stale-password recovery) MUST cause the realm to be automatically re-seeded on the next bring-up, so the recovery leaves a working identity provider rather than an empty one.
- **FR-004**: Any committed realm-definition artifact MUST contain only environment-variable placeholders for secret values — no literal secrets — and the repository's secret-scan and inline-secret checks MUST remain green.
- **FR-005**: The per-machine secret values the realm requires (client secrets and the development end-to-end test-user password) MUST be produced by the existing developer secret-generation step into the existing gitignored per-machine environment files — no new manual secret handling.
- **FR-006**: A first-time dev-container open MUST be able to bring the auth and application stacks up and pass the core web E2E using only committed configuration plus the existing secret-generation step — with no bespoke, hand-rolled realm-import procedure.
- **FR-007**: The branch-protection-required infrastructure-image-scan check MUST report a result (context present) on **every** change, reporting success when no infrastructure image reference changed and the real gate result when one did.
- **FR-008**: A fully-green change that does not touch infrastructure paths MUST be mergeable through the normal path without a manual operator override.
- **FR-009**: A change that adds or modifies an infrastructure image reference MUST still run the full image scan and MUST block the merge if a fixable-critical vulnerability is found.
- **FR-010**: The application compose stacks MUST parse and validate successfully under both an older package-manager-provided container-orchestration tooling version and the current version, with no dependency on any single implementation's re-declaration/merge behavior.
- **FR-011**: Each run profile MUST select exactly the same set of services after the portability change as it does on today's blessed setup — no service added to or removed from any profile.
- **FR-012**: The change MUST NOT regress the established-machine (persistent-volume) workflow, the continuous-integration end-to-end path, or the production realm/import path — all remain unchanged.
- **FR-013**: The development realm definition MUST be kept consistent with the same source of truth as the continuous-integration and production realm client sets, with a lightweight consistency safeguard against drift.
- **FR-014**: The developer-facing runbooks MUST document the from-scratch bring-up as a single documented path and MUST update the stale-password recovery note to reflect automatic re-seeding.
- **FR-015**: A regression safeguard MUST exist that verifies a fresh auth data volume yields a working login, so the from-scratch guarantee is protected the way feature 038's verification scripts protect the toolchain.

### Key Entities *(include if feature involves data)*

- **Development realm definition**: The committed, from-scratch source of the development identity configuration — the realm, its application clients, and the end-to-end test user. Carries only placeholder references for any secret value; resolved per-machine at bring-up.
- **Per-machine secret set**: The generated, gitignored values (client secrets, the development test-user password) that resolve the realm definition's placeholders on a given machine; produced by the existing secret-generation step.
- **Run profile**: A named selector that determines which subset of the application stack's services start; its selection must be invariant across the portability change and across tooling versions.
- **Required check context**: The named, branch-protection-required status that must be present on every change — success when no scan was warranted, the gate result when a scan ran.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a freshly created auth data volume, running only the documented secret-generation step and the standard auth bring-up yields a successful login with **zero** manual import or hand-editing steps.
- **SC-002**: A clean dev-container open reaches a green core web E2E using only committed configuration and the existing secret-generation step — no bespoke realm-import procedure required.
- **SC-003**: The application stack configuration validates successfully under **both** an older package-manager-provided tooling version and the current version, and each profile selects an identical service set in both — verified for every profile in use.
- **SC-004**: The secret-scan and inline-secret checks pass with the committed realm artifact present, confirming no literal secret was introduced.
- **SC-005**: A documentation-only or dev-container-only change shows the required check as success and merges through the normal path with **no** operator override; an infrastructure-touching change runs the full scan and blocks on a fixable-critical finding — both verified on one change of each kind.
- **SC-006**: The established-machine workflow, the continuous-integration end-to-end path, and the production realm path show no regression after the change (existing developers see no disruption; CI and production behave exactly as before).
- **SC-007**: Wiping the auth data volume and bringing the stack back up restores a working login automatically, confirming the stale-password recovery no longer leaves an empty identity provider.

## Assumptions

- **Dev-only scope**: Only the development realm/import path and the development/CI compose stacks are in scope. The production realm/import model is explicitly out of scope and must remain unchanged.
- **Existing secret-generation mechanism is reused**: The established developer secret-generation step (that already mints per-stack credentials into gitignored per-machine environment files) is extended to cover the realm's secrets — no new secret-handling mechanism is introduced.
- **CI realm mechanism is the proven template**: The development realm seeding mirrors the already-working continuous-integration realm-import mechanism (placeholder-only committed artifact resolved from generated per-machine environment), rather than inventing a new approach.
- **Interim version pin stays**: The prior version-pinning of the container-orchestration tooling in the dev container (from the feature-038 follow-up) remains in place as defense-in-depth even after the portability fix; this feature does not remove it.
- **Recommended sequencing** (value-priority is separate from implementation order): implement the required-check fix (US2) first as the cheapest unblocker, then the realm seed (US1) as the highest-impact fix, then the compose portability change (US3) as the mechanical de-risking. All three are independently shippable.
- **Out of scope**: reworking the feature-038 toolchain / fast-startup / personal layer; the agent/assistant E2E specs (which need the agent gateway and a language model and are covered in CI); and removing the interim tooling-version bake.
- **Realm/client set source of truth exists**: There is a single authoritative client set (shared with CI/production) from which the development realm can be derived or against which it can be consistency-checked.
