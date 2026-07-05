# Feature Specification: Keep E2E Secrets Off the Test-Runner Command Line

**Feature Branch**: `027-ci-maestro-secrets`

**Created**: 2026-07-05

**Status**: Draft

**Input**: Source PRD: [docs/proposals/ci-hardening/PRD-maestro-secrets-argv.md](../../docs/proposals/ci-hardening/PRD-maestro-secrets-argv.md) — follow-up hardening from feature 023 (homelab CI/CD): the mobile agent E2E flows pass secrets as command-line arguments to the mobile test runner, making the values readable in the host process list on the shared CI runner.

## Clarifications

### Session 2026-07-05

- Q: Which files do the doc cleanup (FR-008) and the regression guard (FR-009) cover — live surfaces only, or the whole tracked tree including historical spec artifacts? → A: Live surfaces only. Scope the rewrite and the guard to the CI runner script, active flow-file (`tests/e2e/mobile/*.yaml`) headers, and current runbooks/`CLAUDE.md`/`docs/MCM-Testing-Strategy.md`. Historical `specs/0NN/**` task/quickstart/HANDOFF records are immutable point-in-time documentation and are allowlisted (not rewritten, not scanned).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - No live secret exposed in the process list during CI runs (Priority: P1)

The mobile agent E2E suite runs on a shared self-hosted CI runner. Today each flow is launched with its secrets (test-user password, model-provider API key, movie-metadata API key) expanded onto the runner's command line, so any local account on that host can read the live values from the process list (`ps` / `/proc/<pid>/cmdline`) for the duration of the run. The security-conscious operator needs those secrets delivered to the test runner by a channel that never surfaces them in the process list.

**Why this priority**: This is the actual exposure that motivated the feature — a live credential readable by any co-tenant of a shared host. It is the minimum viable outcome; everything else is reinforcement.

**Independent Test**: Run the CI agent-flow suite and, while a flow is executing, inspect the process list on the runner for the test-runner process and its children. The known secret values must not appear in any process's arguments. Delivered value: the credentials are no longer casually readable on the shared host.

**Acceptance Scenarios**:

1. **Given** the CI runner holds the four E2E secrets in its job environment, **When** a mobile flow is executed through the sanctioned runner path, **Then** none of the secret values appear in the arguments of the test-runner process or any child process.
2. **Given** a flow references a secret internally (e.g. the login step needs the test-user password), **When** the flow runs without any secret on the command line, **Then** the flow still receives the value and completes exactly as before.
3. **Given** a required secret is unset in the environment, **When** the runner is invoked, **Then** it does not substitute a placeholder/literal value; the flow fails visibly rather than running with an empty or fake credential.

---

### User Story 2 - One sanctioned way to run a flow, shared by CI and dev (Priority: P2)

The argv-secret pattern is duplicated across the CI runner script, ~30 flow-file header comments, and several spec/runbook snippets, so it keeps getting copy-pasted into new flows. A developer (or the CI job) needs a single, documented, safe way to run any mobile flow locally or in CI so the leaky pattern stops propagating.

**Why this priority**: Without a single blessed path, the fix to the CI script alone will erode as new flows copy the old examples. Consolidation is what makes the hardening durable, but it is not itself the security fix.

**Independent Test**: A developer follows the documented invocation to run a single flow locally against a saved (gitignored) credential source, with no secret typed on the command line, and the flow passes. The same path is what CI uses.

**Acceptance Scenarios**:

1. **Given** a developer has their E2E credentials stored in the gitignored local credential file, **When** they run a flow through the sanctioned path with no secret on the command line, **Then** the flow authenticates and runs.
2. **Given** the CI runner and a developer machine, **When** each runs the agent flows, **Then** both use the same sanctioned invocation path (not two divergent commands).
3. **Given** the flow-file headers and runbook snippets, **When** a reader looks up "how do I run this flow", **Then** the documented example uses the sanctioned path and shows no secret on the command line.

---

### User Story 3 - Automated guard prevents re-introducing the leak (Priority: P3)

Because the leaky pattern is easy to copy back in, the maintainers need an automated check that fails the build if any tracked script or document passes a secret to the test runner on the command line.

**Why this priority**: A guard converts a one-time cleanup into a lasting invariant, matching the project's existing secret-scan gate culture. It is valuable but only meaningful once US1/US2 have removed the existing violations.

**Independent Test**: Add a deliberate command-line secret argument to a tracked file and confirm the guard fails; remove it and confirm the guard passes on the clean tree.

**Acceptance Scenarios**:

1. **Given** the guard is wired into the CI guardrails, **When** a tracked file introduces a test-runner argument whose name looks like a credential (matching key/password/secret/token), **Then** the check fails with a clear message pointing to the offending line.
2. **Given** the cleaned tree, **When** the guard runs, **Then** it passes.
3. **Given** a non-secret runner argument (e.g. a collection name used by a test), **When** the guard runs, **Then** it does not flag it.

---

### Edge Cases

- **Optional secret unset**: a provider key that is legitimately absent in some environments must be skipped silently by the runner (not defaulted to a literal), while a required secret being absent surfaces as a visible flow failure (see US1 scenario 3).
- **Non-secret parameters**: parameters that are not credentials (e.g. a per-test collection name) may still be passed on the command line and must not be flagged by the guard.
- **Local run without the credential file**: if a developer runs the sanctioned path with no credential file and no environment values, the behavior must be a clear failure, not a silent run with empty credentials.
- **Child processes**: the test runner may spawn child processes (device driver, emulator bridge); the "no secret in the process list" guarantee must hold for those too, not only the top-level process.
- **Guard false-negatives on aliases**: the guard should catch the credential-argument shape regardless of surrounding quoting or line continuation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: E2E secrets MUST be delivered to the mobile test runner through a channel that does not place the secret values in any process's command-line arguments (top-level or child).
- **FR-002**: Flows MUST continue to receive the values they need internally (test-user identity/password, provider API key, metadata API key) with no change to the flows' observable behavior.
- **FR-003**: The system MUST provide a single sanctioned invocation path for running a mobile flow, used by both the CI runner and developer machines.
- **FR-004**: The sanctioned path MUST source developer credentials from a gitignored local credential file when present, so a local run needs no secret on the command line.
- **FR-005**: When a required secret is unset, the system MUST NOT substitute a hardcoded or placeholder value; it MUST fail cleanly so the missing credential is visible (no `:-literal` / `?? 'literal'` fallback).
- **FR-006**: An optional secret that is legitimately unset MUST be skipped without error.
- **FR-007**: The CI agent-flow runner MUST be updated to use the sanctioned path and MUST NOT pass any secret on the command line.
- **FR-008**: The command-line-secret invocation MUST be repointed to the sanctioned path across the **live surfaces**: the CI runner script, the active mobile flow-file (`tests/e2e/mobile/*.yaml`) header comments, and the current developer-facing docs (runbooks, `CLAUDE.md`, `docs/MCM-Testing-Strategy.md`). Historical spec artifacts under `specs/0NN/**` (task/quickstart/HANDOFF records) are immutable point-in-time documentation and MUST NOT be rewritten.
- **FR-009**: An automated guard MUST fail the build if any **in-scope** tracked script or document (the live surfaces of FR-008) passes a credential-named argument (matching key/password/secret/token) to the test runner on the command line, and MUST allow non-secret arguments. The guard MUST exclude (allowlist) historical `specs/0NN/**` records so it does not fail on frozen documentation of past state.
- **FR-010**: No secret value may be committed to git at any point; the existing inline-secret and secret-scan gates MUST remain green.
- **FR-011**: The set of secrets injected into the CI job and the mechanism that injects them MUST remain unchanged — this feature only changes how those secrets are handed to the test runner.

### Key Entities

- **E2E secret**: a live credential needed by a flow — test-user identity, test-user password, model-provider API key, movie-metadata API key. Distinguished from a non-secret parameter by name shape (contains key/password/secret/token).
- **Sanctioned runner path**: the single documented entry point for executing a mobile flow, responsible for delivering secrets off-argv and for the fail-clean-on-unset behavior.
- **Local credential file**: a gitignored file on a developer machine holding E2E credentials, sourced by the sanctioned path so local runs need no command-line secret.
- **Regression guard**: an automated check over the in-scope tracked files that rejects command-line credential arguments to the test runner; allowlists historical `specs/0NN/**` records.
- **Live surfaces**: the currently-maintained files where the invocation pattern is read and copied — the CI runner script, active mobile flow-file headers, and current developer docs (runbooks, `CLAUDE.md`, `docs/MCM-Testing-Strategy.md`). The target of both the cleanup and the guard.
- **Historical spec artifacts**: frozen point-in-time records under `specs/0NN/**` (task/quickstart/HANDOFF files); documentation of past state, not rewritten and not scanned.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During a CI agent-flow run, inspecting the process list for the test-runner process and every child yields zero occurrences of any known secret value.
- **SC-002**: 100% of mobile agent flows in the CI suite run green through the sanctioned path with no secret on the command line.
- **SC-003**: A developer can run any single mobile flow locally through the sanctioned path with zero secrets typed on the command line.
- **SC-004**: Zero **in-scope** tracked scripts or documents (the FR-008 live surfaces) pass a credential-named argument to the test runner on the command line after the cleanup (verified by the guard, which allowlists historical `specs/0NN/**` records).
- **SC-005**: The regression guard fails on a deliberately introduced command-line secret argument and passes on the clean tree (self-test demonstrated).
- **SC-006**: With a required secret unset, the sanctioned path fails visibly (non-zero outcome, clear message) and never runs a flow with an empty or placeholder credential.
- **SC-007**: The existing inline-secret and whole-tree secret-scan gates remain green; no secret value is added to git.

## Assumptions

- The mobile test runner (Maestro) exposes an environment-variable ingestion channel that does not require secrets on the command line; the PRD identifies the `MAESTRO_`-prefixed shell-variable mechanism as this channel. The exact in-flow variable naming under that prefix is confirmed by a short implementation-time spike before the doc-wide cleanup.
- The CI job already injects the four E2E secrets into its process environment (from the Forgejo Actions secret store); this feature reuses that environment rather than changing secret provisioning.
- "Shared host" threat model: the CI runner is a multi-account host where the process list is readable across local accounts; a developer's single-user machine is not a meaningful `ps`-exposure threat, so the security outcome (US1) targets CI while the consolidation (US2) benefits both.
- The web (Playwright) E2E path does not use the mobile test runner and is out of scope.
- Maestro Cloud is not used and is out of scope.
- The identity/rotation of the test and API credentials themselves is unchanged; this feature only changes their delivery to the runner.
- The guard extends the project's existing secret-scan gate culture (feature 021/022) and runs in the CI guardrails workflow.
