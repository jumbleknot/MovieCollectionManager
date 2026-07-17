# Feature Specification: Admin Registration Control + Agent Add/Import/Navigate Reliability

**Feature Branch**: `040-admin-registration-agent-fixes`

**Created**: 2026-07-15

**Status**: Draft

**Input**: User description: Four bundled items — (1) an mc-admin can turn off user self-registration app-wide; (2) when adding a movie from TMDB the assistant asks whether the user owns it, then opens the movie detail page; (3) a large spreadsheet import that asks comma/article clarification questions must not silently stop before importing; (4) "navigate to &lt;collection&gt;" must open that collection instead of mis-searching for a movie.

## Overview

This feature bundles one new administrative capability with three reliability fixes to the AI assistant. The items are independent slices — each is separately testable, demonstrable, and shippable — but were grouped by an explicit product decision into a single feature spanning the auth/admin surface (Item 1) and the AI agent layer (Items 2–4).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reliably open a collection by asking (Priority: P1)

A signed-in user tells the assistant to open one of their collections (e.g., "navigate to Test Import collection"). The assistant opens that collection. When the requested name is ambiguous, the assistant offers the matching collections; selecting one opens it. The assistant never reinterprets an "open/navigate to a collection" request as a search for a movie inside whatever collection is currently on screen.

**Why this priority**: This is a broken core interaction today — the assistant cannot reliably fulfil one of its most basic navigation intents, and once it mis-fires it stays stuck interpreting every follow-up as an in-collection movie search. Highest user-visible impact.

**Independent Test**: Drive the exact reported flow (ask to navigate → pick from the disambiguation buttons → confirm the collection screen opens; also ask with an explicit "&lt;name&gt; collection" phrasing and confirm it opens). Passes without touching Items 1, 2, or 3.

**Acceptance Scenarios**:

1. **Given** the user owns collections "Wish List", "Test Import", and "Movie Collection" and is viewing "Movie Collection", **When** the user says "navigate to Test Import collection", **Then** the assistant opens the "Test Import" collection screen (it does not report "couldn't find … in your Movie Collection collection").
2. **Given** the user's request matches more than one collection or matches none exactly, **When** the assistant offers a "Which collection?" choice and the user selects "Test Import", **Then** the assistant opens the "Test Import" collection — not a movie search for "Test Import".
3. **Given** the assistant just resolved a collection choice, **When** the user makes another navigate request, **Then** it is interpreted as navigation (the assistant does not remain anchored to a previously-viewed collection).
4. **Given** the user asks to navigate to a name that matches no owned collection, **When** the assistant responds, **Then** it responds in a navigation context (e.g., offers to look again / lists collections), not as a failed movie search inside the current collection.

---

### User Story 2 - Finish a large spreadsheet import without silent failure (Priority: P2)

A user imports a large spreadsheet of movies. The assistant asks clarifying questions about titles containing commas (distinguishing a leading article like "The" from a genuine comma such as "Girl, Interrupted"). After the user answers, the import proceeds to the preview/approval step and completes. The import never stops silently: if it cannot proceed, the user is told why.

**Why this priority**: Bulk import is a headline capability and today it can silently abandon mid-clarification, appear to hang on large files, or stop with no message — the user cannot tell whether it timed out, errored, or succeeded partially. High impact for anyone importing at scale.

**Independent Test**: Import a spreadsheet of 200+ rows including at least ten comma-containing titles; answer each clarification; confirm the flow reaches the approval/preview and applies, and that any inability to proceed produces an explicit message. Passes without touching Items 1, 3(navigate), or 4.

**Acceptance Scenarios**:

1. **Given** an in-progress import that has asked a comma/article clarification, **When** the user answers it (including an answer that does not exactly match a suggested option), **Then** the import continues (the pending question is re-asked if the answer was unclear) — it is never silently discarded and re-interpreted as a brand-new request.
2. **Given** a large multi-collection import, **When** the assistant checks existing movies to avoid duplicates, **Then** it completes those checks without being throttled into a partial, silently-incorrect duplicate assessment.
3. **Given** an import encounters an unexpected error at any point before the approval step, **When** it cannot continue, **Then** the user receives an explanatory message ("import failed: …") rather than a blank/no reply.
4. **Given** a large spreadsheet with many clarification questions, **When** the user works through them, **Then** the assistant remains responsive (the whole parsed spreadsheet is not re-processed from scratch on every question).
5. **Given** the import reaches the apply step and some rows are duplicates, **When** it applies, **Then** those rows are reported as skipped and the import still completes for the rest.

---

### User Story 3 - Admin disables user self-registration (Priority: P2)

An administrator (a user holding the mc-admin role) opens an in-app admin settings screen and turns off user self-registration for the whole application. New visitors can then no longer reach or complete self-registration. The administrator can turn it back on at any time. The default is that self-registration is allowed (unchanged from today).

**Why this priority**: A concrete, self-contained new capability with clear operational value (closing signups). Independent of the agent-layer items.

**Independent Test**: As an mc-admin, toggle self-registration off; confirm the "Create Account" entry point disappears for a signed-out visitor and a direct registration attempt is refused; toggle back on and confirm registration works again. Confirm a non-admin cannot change the setting. Passes without touching Items 2–4.

**Acceptance Scenarios**:

1. **Given** an mc-admin on the admin settings screen with self-registration enabled, **When** they turn it off, **Then** the setting is persisted and applies application-wide.
2. **Given** self-registration is disabled, **When** a signed-out visitor reaches the login screen, **Then** the "Create Account" entry point is not shown, and any direct attempt to register is refused with a clear message.
3. **Given** self-registration is disabled, **When** the mc-admin turns it back on, **Then** new visitors can register again.
4. **Given** a signed-in user who is **not** an mc-admin, **When** they attempt to read or change the registration setting, **Then** the attempt is refused (they cannot view or use the admin control).
5. **Given** a fresh deployment with no prior setting, **When** a visitor registers, **Then** registration is allowed (default preserves current behavior).

---

### User Story 4 - Ownership prompt and detail navigation when adding from TMDB (Priority: P3)

When a user adds a movie to a collection from a TMDB result via the assistant, the assistant asks whether the user owns the movie (Yes/No) before creating it, records the answer, and — after the movie is added — opens that movie's detail page so the user can review it.

**Why this priority**: A correctness-and-UX improvement (today ownership is silently forced to "owned", and the user is left on the chat with no confirmation screen). Valuable but lower urgency than the broken/blocking items above.

**Independent Test**: Add a movie from a TMDB search via the assistant; confirm an ownership Yes/No question appears before the add; answer "No" and confirm the stored movie is not marked owned; confirm the app lands on the new movie's detail page. Passes without touching Items 1–3.

**Acceptance Scenarios**:

1. **Given** the assistant has found a movie on TMDB to add, **When** it proceeds, **Then** it asks "Do you own this movie?" (Yes/No) before the movie is created.
2. **Given** the user answers "Yes", **When** the movie is added, **Then** it is stored as owned.
3. **Given** the user answers "No", **When** the movie is added, **Then** it is stored as not owned (and still added to the chosen collection).
4. **Given** the movie has been added, **When** the add completes, **Then** the app opens that movie's detail page automatically.
5. **Given** the user declines/cancels at the ownership prompt or the subsequent confirmation, **When** they do so, **Then** no movie is added.

---

### Edge Cases

- **Registration toggled mid-flow**: a visitor has the registration form open when an admin disables registration — the submit is refused with a clear message (server-side enforcement is authoritative; hiding the entry point is a convenience).
- **First admin bootstrap**: how a user first obtains the mc-admin role is out of scope (assigned in the identity provider); the feature only governs behavior for users who already hold it.
- **Public read exposure**: the "is registration enabled?" state must be readable without authentication (the signed-out screens need it) and reveals only that single boolean — no other settings.
- **Import — unclear answer**: an answer that matches no offered option re-asks the same clarification rather than dropping the import.
- **Import — partial duplicates**: rows already present are reported as skipped; the import completes for the remainder.
- **Navigate — no match**: a requested collection name matching nothing owned yields a navigation-context response (offer to look again / list collections), never a movie-search failure inside the current collection.
- **Navigate — exact vs fuzzy**: an unambiguous name opens directly; an ambiguous or partial name offers a choice.
- **Add — ownership on re-add of an existing movie**: adding a movie already in the collection is reported as a duplicate skip (existing behavior), regardless of the ownership answer.

## Requirements *(mandatory)*

### Functional Requirements

**Item 1 — Admin registration control**

- **FR-001**: The system MUST provide an application-wide setting that controls whether user self-registration is allowed, defaulting to allowed so existing behavior is preserved when no setting has been saved.
- **FR-002**: Only a user holding the administrator (mc-admin) role MUST be able to view and change the self-registration setting; all non-admin attempts (read or write) MUST be refused.
- **FR-003**: The system MUST provide an in-app admin control (screen) for an administrator to view and toggle the self-registration setting.
- **FR-004**: When self-registration is disabled, the system MUST refuse any user self-registration attempt with a clear, user-facing message, enforced server-side (independent of whether the client hid the entry point).
- **FR-005**: When self-registration is disabled, the signed-out experience MUST NOT present a registration entry point ("Create Account"); when enabled, it MUST present it.
- **FR-006**: The current allowed/disallowed state MUST be readable by unauthenticated clients (the signed-out screens), exposing only that single boolean and no other administrative data.
- **FR-007**: The system MUST record who last changed the setting and when, for audit purposes, and MUST emit an audit event when the setting changes, when a registration attempt is refused due to the setting, and when an administrative-settings request is refused for lack of authentication (401) or authorization (403) — consistent with the platform's audit requirement for access-denied and auth-failure events.

**Item 2 — TMDB add: ownership + navigation**

- **FR-008**: When adding a movie sourced from TMDB, the assistant MUST ask the user whether they own the movie (Yes/No) before the movie is created.
- **FR-009**: The assistant MUST store the movie's ownership according to the user's answer (owned when Yes, not owned when No); it MUST NOT force ownership to a fixed value.
- **FR-010**: A "No" ownership answer MUST still add the movie to the chosen collection with `owned=false` (ownership and collection membership are independent); this MUST be verified by a direct assertion on the created movie (collection membership + `owned=false`), not only inferred from the resulting screen.
- **FR-011**: After the movie is successfully added, the app MUST open that movie's detail page automatically.
- **FR-012**: If the user declines or cancels at the ownership question or the add confirmation, the system MUST NOT create the movie.

**Item 3 — Spreadsheet import reliability**

- **FR-013**: The import MUST continue after each answered clarification question; an answer that does not clearly match an offered option MUST cause the pending question to be re-asked, never a silent abandonment of the in-progress import.
- **FR-014**: The import MUST always surface a user-facing outcome; any error before the approval step MUST produce an explanatory message rather than a silent stop or blank reply.
- **FR-015**: The import's existing-movie (duplicate) checks MUST NOT be throttled in a way that yields a silently partial or incorrect duplicate assessment on large, multi-collection imports.
- **FR-016**: The import MUST remain responsive across many clarification turns on large spreadsheets (it MUST NOT reprocess or re-carry the entire parsed spreadsheet on every clarification turn). The reference used to carry the parsed spreadsheet between turns MUST stay valid for the full duration of a single import session (across all its clarification turns), so a large multi-turn import cannot fail because the reference expired mid-session.
- **FR-017**: On apply, rows that already exist MUST be reported as skipped and the import MUST complete for the remaining rows, with a per-row outcome summary.

**Item 4 — Navigate-to-collection routing**

- **FR-018**: A request to open/navigate to a collection MUST be routed as navigation and MUST open the named collection when it can be resolved.
- **FR-019**: When a navigate request is ambiguous, the assistant MUST offer the candidate collections; selecting one MUST open that collection (it MUST NOT be reinterpreted as a movie search).
- **FR-020**: A resolved collection selection or an explicit "&lt;name&gt; collection" request MUST NOT be misclassified as an in-collection movie search.
- **FR-021**: The assistant MUST NOT remain anchored to a previously-viewed collection such that subsequent navigate requests are mis-scoped; a navigate request that names no owned collection MUST yield a navigation-context response (offer to look again / list collections), not a movie-search failure inside the current collection. This no-match navigate branch MUST be covered by an explicit test.

**Cross-cutting**

- **FR-022**: All new and changed user-facing behavior MUST be covered by tests following the repository's TDD process, with web and mobile end-to-end parity for the user-facing flows (Items 1, 2, 4) and unit + integration coverage for the import reliability changes (Item 3).
- **FR-023**: Any change to the assistant's model-decision (golden) surface — specifically the intent classification for "navigate to &lt;collection&gt;" (Item 4) — MUST be accompanied by re-recording the affected golden reference and explicit human approval before merge. Items 2 and 3 MUST remain off the golden surface (no new intents; pure code over existing intents).

### Key Entities *(include if feature involves data)*

- **Application Settings (global)**: A single, application-wide settings record (not per-user). Attributes: whether user self-registration is allowed (boolean, default allowed); the identity of the administrator who last changed it; the timestamp of the last change. There is exactly one such record for the whole application.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After an mc-admin disables self-registration, a signed-out visitor can no longer reach or complete registration (no entry point shown; a direct attempt is refused) within one screen refresh, in 100% of attempts.
- **SC-002**: After re-enabling, a new visitor can complete registration again in 100% of attempts.
- **SC-003**: A non-admin user can never read or change the registration setting (0% success on such attempts).
- **SC-004**: With no saved setting, self-registration remains allowed (default behavior unchanged) in 100% of fresh-deployment checks.
- **SC-005**: In 100% of TMDB-sourced adds via the assistant, the user is asked about ownership before the movie is created, and the stored ownership matches the user's answer.
- **SC-006**: In 100% of successful TMDB-sourced adds, the app lands on the new movie's detail page without the user navigating manually.
- **SC-007**: A spreadsheet import of at least 200 rows containing at least 10 comma-containing titles completes to the approval/apply step, with every answered clarification advancing the import and zero silent stops.
- **SC-008**: Whenever an import cannot proceed, the user receives an explanatory message — 0 occurrences of a blank/no reply on failure.
- **SC-009**: "Navigate to &lt;collection&gt;" opens the correct collection (directly when unambiguous, or after a single selection when ambiguous) in 100% of the reported scenarios, with 0 occurrences of the request being handled as an in-collection movie search.
- **SC-010**: The navigate interaction never becomes anchored to a previously-viewed collection — repeated navigate requests each resolve on their own merits in 100% of checks.

## Assumptions

- The mc-admin role is assigned in the identity provider (Keycloak); this feature governs behavior for users who already hold it and does not implement admin-role assignment or first-admin bootstrap.
- Self-registration in this application flows through the backend/identity-admin path rather than the identity provider's own self-service registration page; therefore the toggle must be enforced by the application, and the identity provider's built-in registration flag is not, by itself, sufficient.
- The assistant's existing capabilities are reused as-is: TMDB enrichment, the human-in-the-loop approval/confirmation surface, in-app navigation actions, spreadsheet parsing, and the per-request rate limiting. This feature adjusts their orchestration, not their existence.
- The single-record application-settings store is a new, small persistence surface analogous to the existing per-user assistant-configuration store.
- Ownership is a simple stored attribute of a movie; a "No" answer marks the movie not owned but does not move it to any special collection.
- Web (Playwright) and mobile (Maestro) are both in-scope client surfaces for the user-facing flows, consistent with the repository's E2E parity requirement.

## Dependencies

- The identity provider must be available for registration and role checks (existing dependency).
- The movie-collection backend service and the assistant's tool servers must be running for add/import/navigate flows (existing dependency); agent gateway and tool-server images must be rebuilt after any agent-source change so the deployed behavior matches the code.
- Re-recording the intent-classification golden reference for Item 4 requires the model surface used for that recording and explicit human approval.

## Out of Scope

- Auto-routing un-owned movies to a "Wish List" (or any) collection based on the ownership answer.
- The spreadsheet-import `/resume` path dropping whole-tab exclusions (a separate, known bug deferred to its own backlog item).
- Any identity-provider registration settings beyond the single app-wide on/off control (e.g., email-as-username, password policies).
- First-admin bootstrap / assigning the mc-admin role.
- Additional admin settings beyond the self-registration toggle (the admin screen is introduced but scoped to this one control).
