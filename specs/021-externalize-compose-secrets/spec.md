# Feature Specification: Externalize Docker Compose Credentials

**Feature Branch**: `021-externalize-compose-secrets`

**Created**: 2026-06-21

**Status**: Draft

**Input**: User description: "Externalize all clear-text credentials from tracked Docker Compose files into gitignored per-stack .env files using Compose ${VAR:?} interpolation, removing plaintext secrets from version control."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - No plaintext credentials in tracked compose files (Priority: P1)

A developer (or an automated secret scanner) inspects the version-controlled Docker Compose files and finds **zero** clear-text credentials — every password, secret, API token, and connection-string password is referenced indirectly and resolved from an untracked local source at runtime.

**Why this priority**: This is the security objective. Today ~25 clear-text dev credentials are committed across the four stacks' component compose files, which is a security-policy violation and trips secret scanners. Removing them from version control is the single outcome that resolves the reported problem; everything else exists to make this sustainable.

**Independent Test**: Run the credential-scan gate against the tracked compose tree. It passes only when no secret-shaped key holds a literal value. Independently delivers value even without the convenience tooling: the repo is scanner-clean.

**Acceptance Scenarios**:

1. **Given** the tracked compose files, **When** the credential-scan gate runs, **Then** it reports zero inlined credentials and exits successfully.
2. **Given** a compose file where a secret is given an inline default (e.g. `${VAR:-plaintext}`), **When** the gate runs, **Then** it fails, because an inline default re-leaks the plaintext.
3. **Given** a value shared by multiple services (e.g. a database password used in a server's password field and in a client's connection URL), **When** the files are inspected, **Then** every occurrence references the same single variable.
4. **Given** a stack is started with no resolved value for a required variable, **When** bring-up is attempted, **Then** it fails fast with a clear message naming the missing variable and where to set it — rather than starting with an empty or default credential.

---

### User Story 2 - One-command local setup preserves the dev workflow (Priority: P2)

A developer cloning the repo for the first time runs a single setup step that produces the local secret values, then brings up any stack exactly as before. The opt-in stacks (observability, audit) still start healthy, and cross-service contracts (services that must share a value) continue to authenticate.

**Why this priority**: Removing plaintext must not break the local dev loop. Fail-fast variables mean a fresh clone cannot start a stack until local values exist; a frictionless, repeatable way to produce them keeps the workflow as smooth as the previous copy-and-go experience.

**Independent Test**: On a clean checkout, run the setup step, then bring up each stack. All services reach a healthy state and inter-service authentication succeeds. Re-running setup does not overwrite existing local values.

**Acceptance Scenarios**:

1. **Given** a clean checkout with no local secret values, **When** the developer runs the setup step, **Then** local secret values are generated for every required variable, satisfying each variable's format requirements (e.g. a fixed-length hex key, a complexity-constrained password, a structured token).
2. **Given** generated local values exist, **When** the developer runs the setup step again, **Then** existing values are preserved (idempotent) unless an explicit force option is given.
3. **Given** generated local values, **When** each stack is brought up, **Then** every service becomes healthy and services that share a credential authenticate against each other.
4. **Given** a value that an external consumer must match exactly (a deterministic cross-consumer test fixture), **When** values are generated, **Then** that value remains the documented fixed value rather than a random one.
5. **Given** the generated local values, **When** the repository status is checked, **Then** none of the generated value files are tracked by version control, while their placeholder templates are tracked.

---

### User Story 3 - Historical credentials purged from git history (Priority: P3)

A maintainer removes the previously committed credential strings from the repository's git history so that a clone of any past commit no longer exposes them, completing the remediation.

**Why this priority**: Removing secrets from the working tree leaves them recoverable from history. Scrubbing history closes that gap. It is lowest priority because it is a coordinated, history-rewriting operation that must follow the working-tree change and does not block it; the generated values differ from the historical ones, so the historical strings are already dead.

**Independent Test**: After the scrub, searching the full git history for each known historical credential string returns no matches; the working tree still builds and stacks still start.

**Acceptance Scenarios**:

1. **Given** the working-tree externalization is merged, **When** the history scrub runs, **Then** searching all history for each known historical credential returns no matches.
2. **Given** the scrub rewrites shared history, **When** it is performed, **Then** collaborators are notified that existing clones and open change-sets must be re-synced.
3. **Given** the scrub is complete, **When** any stack is brought up from the current tree, **Then** it still starts healthy (the scrub did not alter live behavior).

---

### Edge Cases

- A credential appears inside a non-`environment` location — a container start command, a health check, a one-shot bootstrap script, or embedded inside a connection-string URL. All such occurrences must be externalized, not just `environment` entries.
- A credential is shared across two different stacks (e.g. a value produced in one stack but consumed by a service in another). Generation must keep the value consistent for every consumer.
- A service image provides no file-based secret mechanism. The chosen indirection must work regardless of image support.
- A developer edits a placeholder template to add a new variable. Setup must pick it up on the next run.
- The placeholder templates themselves must never accumulate real secret values over time.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every clear-text credential currently inlined in version-controlled Docker Compose files MUST be replaced by an indirect reference resolved from an untracked local source at runtime. In scope: the `auth`, `mcm`, `audit`, and `observability` stacks and every component file they include. Out of scope: the BFF and mc-service services, which already externalize their secrets.
- **FR-002**: Required-credential references MUST fail fast when unresolved (no inline default value), so a stack cannot start with an empty or placeholder credential.
- **FR-003**: A credential value used in more than one place MUST be expressed as a single canonical variable referenced at every occurrence, including occurrences inside start commands, health checks, bootstrap scripts, and connection-string URLs.
- **FR-004**: Real secret values MUST be randomly generated for local development; deterministic cross-consumer test fixtures (values an external consumer must match exactly) MUST retain their fixed documented value and live in the tracked placeholder template.
- **FR-005**: The system MUST provide a repeatable setup step that produces a complete set of local credential values from tracked placeholder templates, honoring each variable's format constraints, and that is idempotent (preserves existing values unless explicitly forced).
- **FR-006**: Generated local value files MUST be excluded from version control; their placeholder templates MUST be included in version control.
- **FR-007**: Each stack's runtime invocation MUST be wired to load its local credential values so that a single configuration source resolves all references across that stack's included component files.
- **FR-008**: An automated gate MUST scan the tracked compose files and fail when any secret-shaped key holds a literal value instead of an indirect reference; the gate MUST run in continuous integration alongside the existing resource-naming gate.
- **FR-009**: The local-development documentation MUST instruct first-time contributors to run the setup step before bringing up any stack.
- **FR-010**: After the working-tree change is merged, the previously committed credential strings MUST be removed from git history as a separate, coordinated step that does not block or alter the working-tree change.
- **FR-011**: All opt-in stacks (observability, audit) and the default app/auth flows MUST continue to start healthy and pass existing end-to-end validation after externalization.

### Key Entities *(include if feature involves data)*

- **Credential variable**: A named secret used by one or more services. Attributes: canonical name, format/complexity constraints, whether it is randomly generated or a fixed deterministic fixture, the set of locations that reference it.
- **Placeholder template**: A tracked, per-stack file enumerating every credential variable a stack needs, with placeholder (non-secret) values; the contract a fresh clone fills in.
- **Local value file**: An untracked, per-stack file holding the actual resolved credential values for one developer's machine.
- **Credential-scan gate**: An automated check that asserts the tracked compose tree contains no literal credential values.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A scan of all tracked Docker Compose files finds 0 clear-text credentials.
- **SC-002**: A secret scanner run against the repository's tracked tree reports 0 findings in the compose files (down from the current ~25).
- **SC-003**: A first-time contributor can go from a clean clone to a healthy stack with exactly one setup command plus the normal bring-up command — no manual secret entry.
- **SC-004**: Each of the four stacks starts and reaches a healthy state using only generated local values, and all inter-service authentication succeeds.
- **SC-005**: The credential-scan gate runs in CI and fails any change that reintroduces a literal credential into a tracked compose file.
- **SC-006**: After the history scrub, a search of the entire git history for each known historical credential string returns 0 matches.
- **SC-007**: Existing end-to-end validation (web E2E and the opt-in observability/audit smoke checks) passes unchanged after externalization.

## Assumptions

- The affected credentials are dev-only values, not production secrets; the goal is removing plaintext from version control and establishing a sustainable convention, not introducing a production secrets-management platform (the existing Vault posture remains the production path).
- The runtime supports variable interpolation across all relevant file locations (service environment, start commands, health checks, bootstrap scripts, and connection-string URLs), so a single indirection mechanism can cover every occurrence.
- The repository is shared; history rewriting requires collaborator coordination and is therefore sequenced last and kept independent of the working-tree change.
- The existing gate-script and Nx-target conventions (mirroring the resource-naming gate and the `up-*` stack targets) are the appropriate integration points.
- Deterministic cross-consumer fixtures are limited to values an external consumer (e.g. an agent gateway or a verification test) must match exactly; all other values are safe to randomize per machine.
