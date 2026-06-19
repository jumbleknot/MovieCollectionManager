# Feature Specification: Per-User Movie Assistant Configuration

**Feature Branch**: `018-per-user-agent-config`

**Created**: 2026-06-18

**Status**: Draft

**Input**: User description: "docs\PRD-PerUserAgentConfig.md — Make the movie assistant opt-in and bring-your-own-everything: disabled by default for every new user, no shared model and no shared movie-metadata key, each user supplies and validates their own provider credentials from the Profile screen, stored encrypted and scoped per user."

## Clarifications

### Session 2026-06-18

- Q: Must the movie-metadata (TMDB) key be present to enable the assistant, or is it optional with graceful degradation? → A: Required to enable — the metadata key is a required credential alongside the provider credential; the assistant cannot be enabled or run without it.
- Q: When a user switches model providers, what happens to a previously stored secret for the other provider? → A: Retain it — the non-active provider's stored secret is kept (so a self-hosted-provider user can retain a hosted-provider key to unlock the escalation tier per FR-008); switching only changes the active base provider.
- Q: What does clearing/removing the assistant configuration (FR-016) do? → A: Disable + wipe secrets — set the assistant disabled and erase all stored secrets, but keep non-secret settings (provider selection, connection detail, spend ceiling); re-enabling later requires only re-supplying secrets.
- Q: Is there a responsiveness target for the live credential checks (save-time validation and test-connection)? → A: Bounded target — live checks should complete within ≤5 seconds and time out with an actionable failure rather than hanging indefinitely.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assistant is off until I opt in (Priority: P1)

A brand-new user signs in and uses the app. The movie assistant is not present and does nothing on their behalf — no assistant entry point appears and no request is made to any model provider or movie-metadata service until the user deliberately turns the assistant on and finishes configuring it.

**Why this priority**: This is the core safety and cost-control promise of the feature. Without it, every user inherits a shared capability the operator must pay for and manage. It is the gate every other story depends on, and it is independently valuable on its own — even with nothing else built, "the assistant costs nothing and does nothing until you ask for it" is a shippable, demonstrable guarantee.

**Independent Test**: Sign in as a freshly created user who has never configured the assistant. Confirm the assistant entry point is absent, and confirm that no model-provider or movie-metadata call is attempted for that user. Attempting to start an assistant interaction returns a clear "assistant not configured" result with no external call and no charge.

**Acceptance Scenarios**:

1. **Given** a new user with no saved assistant configuration, **When** they open the app and any screen that would host the assistant, **Then** the assistant entry point is not shown.
2. **Given** a new user with no saved assistant configuration, **When** an assistant interaction is somehow requested for that user, **Then** the request is refused immediately with a typed "assistant not configured" outcome, and no model-provider or movie-metadata call is made and no cost is incurred.
3. **Given** a user whose configuration exists but is not enabled, **When** an assistant interaction is requested, **Then** it is refused the same way as an unconfigured user.

---

### User Story 2 - Enable and configure my own assistant (Priority: P1)

From the Profile screen, a user turns on the Movie Assistant, chooses one of the supported model providers, supplies the credential or connection detail that provider needs, and supplies their own movie-metadata service key. When they save, the app immediately verifies each supplied credential by performing a live check; if everything checks out, the configuration is stored — secrets encrypted — and the assistant becomes available. If any credential is invalid, the user is told exactly which field is wrong and nothing is saved.

**Why this priority**: This is what makes the assistant usable per user and removes all shared operator-supplied credentials. It is the heart of "bring your own everything." It is independently testable and, combined with US1, forms the MVP: a user can go from "off" to "working assistant with my own credentials."

**Independent Test**: As a configured-from-scratch user, open Profile, enable the assistant, select a provider, enter valid credentials plus a valid movie-metadata key, and save. Confirm the save succeeds, the assistant entry point appears, and an assistant interaction succeeds using those credentials. Separately, attempt a save with a deliberately invalid credential and confirm a per-field error is shown and nothing is persisted.

**Acceptance Scenarios**:

1. **Given** an authenticated user on the Profile screen, **When** they enable the assistant, pick a provider, enter the provider's required credential/connection detail and a valid movie-metadata key, and save, **Then** each credential is verified by a live check, the configuration is saved with secrets stored encrypted, and the assistant becomes available to that user.
2. **Given** a user filling in the configuration, **When** they submit a credential that fails its live check, **Then** the save is rejected with a per-field message identifying which credential is wrong and why, and no part of the configuration is persisted.
3. **Given** a user who already has secrets saved, **When** they change a non-secret setting and save without re-entering a secret, **Then** the existing stored secret is preserved unchanged.
4. **Given** a saved secret credential, **When** the configuration is viewed, **Then** the screen shows a "configured" indicator and never displays the stored secret value.
5. **Given** a user who selects a provider whose tier does not support the assistant's highest-capability ("escalation") behavior, **When** they configure, **Then** the screen clearly states that the higher-capability behavior is unavailable unless they also supply the credential the escalation tier requires — it is surfaced, not silently dropped.

---

### User Story 3 - Re-test a saved credential without re-entering it (Priority: P2)

Some time after configuring, a user wants to confirm their saved credentials still work (e.g., a key may have been revoked). From the Profile screen they press "Test connection" and the app re-runs the live checks against their already-stored credentials and reports per-credential status, without ever asking the user to re-type a secret and without sending any secret to the user's device.

**Why this priority**: Credentials expire or get revoked; users need a way to confirm health without the friction and risk of re-entering secrets. Valuable but not required for the initial enable-and-use flow, so it ranks below the P1 stories.

**Independent Test**: As a user with saved, valid credentials, press "Test connection" and confirm a per-credential "ok" status is shown without any secret entry. Then revoke/spoil one credential server-side and press "Test connection" again, confirming the corresponding credential is reported as failing while no secret value is exposed to the client.

**Acceptance Scenarios**:

1. **Given** a user with saved credentials, **When** they press "Test connection", **Then** the live checks run against the stored credentials and a per-credential status is shown, with no secret re-entry required and no secret value returned to the client.
2. **Given** a user whose stored credential has since become invalid, **When** they press "Test connection", **Then** that credential is reported as failing with a reason, while still-valid credentials report "ok".

---

### User Story 4 - Disable the assistant (Priority: P2)

A user who previously enabled the assistant turns it off from the Profile screen. The assistant entry point disappears and no further assistant interactions run for that user until they re-enable it.

**Why this priority**: The opt-in promise must be reversible. Lower than enabling because a user must first be able to enable before disabling matters, but still essential for user control.

**Independent Test**: As an enabled, configured user, toggle the assistant off and save. Confirm the assistant entry point disappears and that a subsequent assistant interaction is refused with the "assistant not configured / disabled" outcome and makes no external call.

**Acceptance Scenarios**:

1. **Given** an enabled user, **When** they disable the assistant and save, **Then** the assistant entry point is no longer shown and any subsequent assistant interaction is refused with no external call.
2. **Given** a user who disables the assistant, **When** they later re-enable it, **Then** their previously saved provider selection and non-secret settings are still present (the user is not forced to reconfigure from scratch), subject to any required secrets still being on file.

---

### User Story 5 - Cap my own spend (Priority: P3)

A user optionally sets a personal spend ceiling for assistant usage. When set, their assistant interactions are stopped once that ceiling is reached. When left unset, the existing system-wide default ceiling applies, so behavior is unchanged for users who never touch it.

**Why this priority**: Because each user now pays their own provider, a personal cap is a useful guardrail, but the system already has a default ceiling, so this is an enhancement rather than a prerequisite.

**Independent Test**: As a configured user, leave the cost limit unset and confirm the existing default ceiling governs runs. Then set a personal ceiling and confirm interactions are short-circuited once that personal ceiling is exceeded, using the existing cost-ceiling outcome keyed to that user.

**Acceptance Scenarios**:

1. **Given** a configured user who has not set a personal spend ceiling, **When** they use the assistant, **Then** the existing system-wide default ceiling governs their usage unchanged.
2. **Given** a configured user who has set a personal spend ceiling, **When** their accumulated usage would exceed that ceiling, **Then** the interaction is short-circuited with the existing cost-ceiling outcome, scoped to that user's own usage.

---

### Edge Cases

- **Provider switch retains the other provider's secret**: A user configured for one provider switches to the other. The newly required credential must be validated, and the new base provider must operate without needing the other provider's secret. The previously stored secret for the non-active provider is **retained** (not wiped) — so a self-hosted-provider user who also holds a hosted-provider key keeps escalation available per FR-008.
- **Partial credentials**: Assistant is enabled but a required credential for the chosen provider is missing. The assistant must be treated as not runnable and the user told what is missing, rather than failing mid-interaction.
- **Movie-metadata key missing but movie-metadata capability invoked**: A user without a movie-metadata key triggers a capability that needs it. The system must fail gracefully with a clear reason rather than an opaque error.
- **Live check times out or the provider is unreachable during save**: Save must not silently succeed; the user must see an actionable failure and nothing is persisted.
- **Concurrent edits / re-save without re-entering secrets**: Saving non-secret changes must never wipe or corrupt an existing stored secret.
- **Escalation requested by an escalation-incapable configuration**: The assistant must degrade to the user's base provider rather than error, and the limitation must have been surfaced in the UI beforehand.
- **A revoked credential discovered only at interaction time**: The interaction must fail with a clear, user-safe message and must not leak the credential or internal detail.

## Requirements *(mandatory)*

### Functional Requirements

#### Default state & gating

- **FR-001**: New users MUST have no saved assistant configuration, and in that state the assistant MUST be disabled and its entry point MUST NOT be presented.
- **FR-002**: An assistant interaction MUST be permitted only when the requesting user has a saved configuration that is enabled AND has all credentials required by the chosen provider present AND has a movie-metadata key on file. In any other case the system MUST refuse the interaction immediately with a typed "assistant not configured" outcome and MUST NOT contact any model provider or movie-metadata service and MUST NOT incur any cost.

#### Per-user configurable fields

- **FR-003**: A user MUST be able to set whether the assistant is enabled or disabled.
- **FR-004**: A user MUST be able to select exactly one model provider from the supported set (currently two providers).
- **FR-005**: For the chosen provider, the user MUST be able to supply that provider's required detail: a connection/location detail for the self-hosted provider (non-secret) OR an authentication credential for the hosted provider (secret).
- **FR-006**: A user MUST supply their own movie-metadata service key (secret). This key is a required credential: the assistant cannot be enabled or run without it (per FR-002), and it is used by any capability that retrieves movie metadata.
- **FR-007**: A user MUST be able to optionally set a personal spend ceiling. When unset, the system-wide default ceiling applies; when set, the user's ceiling governs their own usage.
- **FR-008**: The assistant's highest-capability ("escalation") behavior MUST require the hosted-provider credential. A user without that credential MUST still be able to use the assistant on their base provider, with the assistant degrading gracefully, and the unavailability of escalation MUST be surfaced to the user rather than silently failing.

#### Profile screen

- **FR-009**: The Profile screen MUST present a dedicated assistant configuration section containing: an enable/disable control, a provider selector, the provider-specific field(s), the movie-metadata key field, an optional spend-ceiling field (empty means "use default"), a Save control, and a Test connection control.
- **FR-010**: Secret fields MUST be write-only in the UI — the screen MUST show a "configured" indicator and a masked/empty input and MUST NEVER display a stored secret value.
- **FR-011**: Configuration and editing MUST be available with equivalent behavior on both web and mobile clients.

#### Validation, persistence, and testing of credentials

- **FR-012**: On save, the system MUST validate each credential being set by performing a live check against the relevant provider/service. Each live check MUST complete within a bounded time (target ≤5 seconds) and, on timeout or unreachable provider, MUST surface an actionable per-field failure rather than hanging. On any failure, the system MUST reject the save with a per-field reason and MUST persist nothing.
- **FR-013**: On successful validation, the system MUST store the configuration with all secret values encrypted at rest, scoped to the single owning user, and durable across sessions and restarts.
- **FR-014**: A save that omits a secret field MUST leave the previously stored secret unchanged, allowing non-secret edits without re-entering keys.
- **FR-015**: A user MUST be able to re-test their already-saved credentials on demand; the system MUST run the live checks against the stored credentials and return per-credential status WITHOUT requiring re-entry and WITHOUT returning any secret value to the client.
- **FR-016**: A user MUST be able to clear their assistant configuration. Clearing MUST set the assistant to disabled and erase all stored secrets, while preserving non-secret settings (provider selection, non-secret connection detail, and spend ceiling), so that re-enabling later requires only re-supplying the secrets.

#### Scoping, access control, and audit

- **FR-017**: All configuration operations MUST require an authenticated, authorized user and MUST be strictly scoped to that user; the owning user identity MUST be derived from the validated session, never from client-supplied input.
- **FR-018**: Reads of the configuration MUST return only non-secret information (enabled state, provider, non-secret connection detail, presence indicators for each secret, the spend ceiling, and last-updated time). Secret values MUST NEVER be returned to the client.
- **FR-019**: Create, update, delete, and test operations on the configuration MUST emit audit events identifying the user (by stable user identifier only), with no secret material in any log entry.

#### Per-interaction credential use

- **FR-020**: When an assistant interaction is permitted, the system MUST resolve the requesting user's provider selection and decrypt the needed secrets only transiently in memory for that single interaction, supplying them to the assistant runtime through the existing per-interaction context channel.
- **FR-021**: All previously shared, operator-supplied model and movie-metadata credential paths MUST be removed from the user-facing runtime so that provider, model selection, and metadata access derive from per-user configuration rather than shared system configuration.
- **FR-022**: Decrypted secrets MUST exist only per-interaction and in-memory; they MUST NEVER be written to persisted assistant state, telemetry/observability traces, diagnostic spans, or logs.

#### Secret hygiene

- **FR-023**: The master key protecting per-user secrets, and any per-user credentials used by tests, MUST be sourced only from a secret store or local secret configuration that is never committed; they MUST NEVER appear as literals in code, fixtures, recorded test artifacts, snapshots, or committed configuration.
- **FR-024**: The system's log redaction MUST cover the new secret fields so that no secret material can be emitted in logs.
- **FR-025**: An automated guard MUST fail the build if a credential-shaped secret is committed, and recorded test artifacts used for regression gating MUST contain no authorization headers or credential values.

### Key Entities *(include if feature involves data)*

- **Per-User Assistant Configuration**: The single per-user record capturing whether the assistant is enabled, which provider is selected, the provider's non-secret connection detail, the encrypted provider credential (when the hosted provider is chosen), the encrypted movie-metadata key, an optional personal spend ceiling (absent means "use default"), and a last-updated timestamp. Scoped one-to-one to a user identity. Secret attributes are stored encrypted and are never exposed in reads.
- **Supported Provider**: An enumeration of the model providers the assistant supports (currently two), each defining which detail it requires (a non-secret connection detail vs. a secret credential) and whether it can serve the escalation tier.
- **Credential Validation Result**: A per-credential outcome ("ok" or a failure with a reason) produced by a live check, used both at save-time validation and at on-demand re-testing. Never carries the secret value itself.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A brand-new user triggers zero model-provider and zero movie-metadata calls until they explicitly opt in — verifiable by observing that no such call occurs for an unconfigured user across any app flow.
- **SC-002**: With no shared operator-supplied credentials present in the user-facing runtime, a configured user's assistant still works and an unconfigured user's interaction is short-circuited — demonstrating that no shared-credential path remains.
- **SC-003**: Per-user configuration and secrets persist across sessions and process restarts, and an encrypt-then-read round trip returns the original secret while the stored form is not the plaintext.
- **SC-004**: Saving with an invalid credential is rejected with a per-field error and persists nothing; a saved credential can be re-tested with no re-entry and yields a correct per-credential status.
- **SC-005**: A user who sets no personal spend ceiling experiences the existing default ceiling unchanged; a user who sets one has their interactions short-circuited at their own ceiling.
- **SC-006**: No credential value appears in any committed file, log line, telemetry trace, diagnostic span, or persisted assistant state — verified by automated secret scanning plus targeted assertions, all green.
- **SC-007**: Enable, configure, save, test-connection, and disable all pass end-to-end on both web and mobile clients.
- **SC-008**: Save-time validation and test-connection live checks return a result within 5 seconds (success or actionable failure), and never leave the user waiting on an indefinite hang when a provider is unreachable.

## Assumptions

- **Supported providers are unchanged**: Only the two currently supported model providers are offered. The configuration model is extensible to future providers, but adding new providers is out of scope.
- **Model-name selection stays operator-set**: Users choose only their provider and supply credentials; the per-tier model *names* remain operator-set defaults. Letting users override per-tier model names is out of scope (per PRD open question 1, default assumption taken).
- **Escalation tier is always the hosted provider**: The highest-capability tier always uses the hosted provider, so escalation is available only to users who have the hosted-provider credential on file (per FR-008).
- **No shared/team/org configuration**: Configuration is strictly per individual user; there is no sharing across users.
- **No billing/quota changes beyond the personal ceiling**: Users now pay their own provider directly via their own credential; no new cost-accounting system is introduced beyond the existing ceiling mechanism the personal ceiling overrides.
- **No agent capability changes**: The assistant's intents, tools, and behavior are unchanged; this feature only governs how the assistant is enabled and credentialed per user.
- **No production migration of shared-env deployments**: There is no existing production user base relying on shared configuration, so the only "migration" is updating the test/golden harness to seed per-user configuration instead of relying on shared system configuration.
- **Master-key rotation is a follow-up**: A strategy for re-encrypting secrets if the master encryption key rotates is acknowledged as future work and out of scope here (per PRD open question 3).
- **Existing identity, session, and authorization mechanisms are reused**: The feature relies on the established authenticated-and-authorized user model; the owning user is always derived from the validated session.
