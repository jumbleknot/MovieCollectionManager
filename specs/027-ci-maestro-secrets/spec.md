# Feature Specification: Keep E2E Secrets Off the Test-Runner Command Line

**Feature Branch**: `027-ci-maestro-secrets`

**Created**: 2026-07-05

**Status**: Draft

**Input**: Source PRD: [docs/proposals/ci-hardening/PRD-maestro-secrets-argv.md](../../docs/proposals/ci-hardening/PRD-maestro-secrets-argv.md) — follow-up hardening from feature 023 (homelab CI/CD): the mobile agent E2E flows pass secrets as command-line arguments to the mobile test runner, making the values readable in the host process list on the shared CI runner.

## Clarifications

### Session 2026-07-05

- Q: Which files do the doc cleanup (FR-008) and the regression guard (FR-009) cover — live surfaces only, or the whole tracked tree including historical spec artifacts? → A: Live surfaces only. Scope the rewrite and the guard to the CI runner script, active flow-file (`tests/e2e/mobile/*.yaml`) headers, and current runbooks/`CLAUDE.md`/`docs/MCM-Testing-Strategy.md`. Historical `specs/0NN/**` task/quickstart/HANDOFF records are immutable point-in-time documentation and are allowlisted (not rewritten, not scanned).

### Session 2026-07-05b (scope expansion — hardcoded credential fallbacks)

- Q: The argv cleanup removed the live test-user password (`the-live-E2E-password`) from the mobile flow headers, but that same live credential is still hardcoded as a `?? 'literal'` / `cfg(VAR, 'literal')` fallback in several test/tooling files (web Playwright global-setup, jest integration helper, python integration `conftest.py`/`kc_admin.py`, a cleanup script) and in three historical spec doc-examples. Should this feature also close that class of leak, or defer it? → A: Bring it into scope (US4). The fail-clean principle (FR-005) already forbids a `?? 'literal'` fallback — extend it from the sanctioned wrapper to **all** test/tooling code that reads an E2E credential, purge the live password literal from the whole tree (including the three historical spec examples — the credential VALUE is redacted to `$E2E_TEST_PASSWORD`, the surrounding historical record is otherwise preserved), source dev creds from the gitignored `.env.e2e.local`, and extend the whole-tree `secret-scan` gate to flag both the known literal and the credential-fallback shape so it cannot regress. The documented feature-023 throwaway CI-realm secrets in `scripts/export-ci-realm.mjs` (disposable-realm fixtures, "allowlist — do not weaken the pattern") are a distinct class and are allowlisted rather than removed; only its live-`E2E_TEST_PASSWORD` fallback is made fail-clean.

- Q (follow-up): Should the committed `ci-realm.json` (which bakes the disposable CI realm's E2E password + all confidential client secrets in clear text) and the `export-ci-realm.mjs` throwaway literals be brought into scope too, or left as documented 023 fixtures? → A: **Bring into scope as US5** — address ALL committed credential fields via Keycloak `${ENV_VAR}` placeholder substitution at import (KC 26.5.5, default-on). The 3 BFF-facing client secrets + password resolve from the existing CI secret source (canonical names → realm==BFF by construction); the 3 CI-only clients whose secret is arbitrary in the E2E path (agent-gateway fetched-at-runtime, mc-service bearer-only, mcm-bff-test/ROPC unused) get freshly-minted per-run values. Compose uses `${VAR:?}` fail-fast. Final end-to-end validation is on a CI run (the realm import + login cannot be exercised locally — no live dev-box Keycloak to regenerate from, no CI import here).

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

### User Story 4 - No hardcoded credential fallback anywhere in test/tooling code (Priority: P2)

The same live test-user password that the argv cleanup removed from the flow headers is still baked as a `?? 'literal'` / `cfg(VAR, 'literal')` fallback in the test/tooling code that authenticates against the real local stack — Playwright global setup, the jest integration Keycloak helper, the python integration `conftest.py`/`kc_admin.py`, and a cleanup script — and in three historical spec doc-examples. Because it is a fallback default, the value is used silently whenever the environment does not set it, so the live credential is embedded in the committed tree and evades the existing `secret-scan` gate (whose patterns only match other shapes). The security-conscious maintainer needs every consumer of an E2E credential to read it from the environment (sourced from the gitignored local credential file when present) and fail cleanly when it is unset — never from a hardcoded literal — and the live password value to appear nowhere in the tree.

**Why this priority**: It is the same exposure class as US1 (a live credential readable in the committed source, this time as a fallback literal rather than on argv). It is reinforcement of the same principle FR-005 already states; consolidating it here keeps the whole feature's "no hardcoded E2E credential" story coherent, but the mobile-argv leak (US1) remains the headline fix.

**Independent Test**: Grep the tree for the known live password literal → zero occurrences. Run any credential-consuming test suite with the local credential file present → it authenticates; with the credential unset and no file → it fails cleanly (or skips, for the integration suites whose documented contract is skip-when-creds-absent), never running with an empty or hardcoded value.

**Acceptance Scenarios**:

1. **Given** a test/tooling file that needs an E2E credential, **When** the credential is provided by the environment or the gitignored local credential file, **Then** the file reads that value and runs — with no literal default in the source.
2. **Given** the credential is unset and no local file exists, **When** a required-credential consumer (e.g. web E2E global setup) runs, **Then** it fails visibly rather than falling back to a hardcoded value; an integration suite whose documented contract is skip-when-absent skips cleanly instead.
3. **Given** the whole tracked tree, **When** the extended `secret-scan` gate runs, **Then** it flags the known live password literal and the credential-env-var-with-nonempty-literal-fallback shape, and passes on the cleaned tree.

---

### User Story 5 - No committed credential in the CI throwaway realm (Priority: P2)

The committed CI realm import (`infrastructure-as-code/docker/keycloak/ci-realm.json`, imported by Keycloak on CI boot) bakes the throwaway realm's actual credentials in clear text: the E2E test-user password and every confidential client secret. Even as disposable CI values, they are live credentials committed to git — the same clear-text-secret exposure this feature is closing elsewhere. The maintainer needs the committed realm to carry no secret value, while CI still imports a fully working realm.

**Why this priority**: It is the same "no clear-text secret in git" invariant as US4, applied to the one remaining committed-credential surface the feature surfaced. It is reinforcement (the CI realm is disposable), but leaving it undermines the feature's own guarantee.

**Independent Test**: Grep the committed realm file for any credential value → only `${ENV_VAR}` placeholders, no plaintext password or client-secret value. On a CI run, Keycloak imports the realm (resolving the placeholders from the container environment) and the web + mobile E2E login and agent flows pass exactly as before.

**Acceptance Scenarios**:

1. **Given** the committed CI realm file, **When** it is inspected, **Then** every client secret and the user password is a `${ENV_VAR}` placeholder — no clear-text credential is present.
2. **Given** CI boots Keycloak with the realm import and the required credential environment variables set, **When** the realm imports, **Then** each placeholder resolves from the container environment and the realm is functionally identical to the previous baked realm (login + agent flows pass).
3. **Given** a required credential environment variable is unset at import, **When** the stack is brought up, **Then** it fails fast with a clear error (compose `${VAR:?}`), never importing a realm with an unresolved/broken credential.

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
- **FR-012** (US4): Every test or tooling file that consumes an E2E credential (test-user password, provider/metadata API key, ROPC/service client secret) MUST read it from the environment — sourced from the gitignored `frontend/mcm-app/.env.e2e.local` when present — and MUST NOT supply a hardcoded literal default (`?? 'literal'`, `|| 'literal'`, `cfg(VAR, 'literal')`, `os.environ.get(VAR, 'literal')`). An empty-string default used purely as a skip/absent sentinel (`?? ''`) is permitted.
- **FR-013** (US4): When a required E2E credential is unset and no local credential file supplies it, a consumer MUST behave as fail-clean: a suite that must run (web E2E global setup, cleanup tooling) fails visibly; an integration suite whose documented contract is skip-when-credentials-absent skips cleanly. Neither may proceed with an empty or hardcoded credential.
- **FR-014** (US4): The web (Playwright) E2E path and any other credential consumer that does not already load `frontend/mcm-app/.env.e2e.local` MUST be given a loader for it (matching the existing jest `setupFiles` / python `_load_env_file` pattern), so a local run needs no manual shell export and no literal fallback.
- **FR-015** (US4): The live test-user password value MUST NOT appear anywhere in the tracked tree — including the three historical spec doc-examples, where the credential value is redacted to `$E2E_TEST_PASSWORD` (the rest of the frozen record is preserved). The whole-tree `secret-scan` gate MUST be extended to flag (a) the known live password literal and (b) a non-empty literal fallback default for one of the feature's E2E credential env vars, and MUST pass on the cleaned tree.
- **FR-017** (US5): The committed CI realm import (`ci-realm.json`) MUST NOT contain any clear-text credential value — every confidential client secret and the E2E user password MUST be a `${ENV_VAR}` placeholder that Keycloak resolves from the `keycloak-service` container environment at `--import-realm` (placeholder replacement is default-on since Keycloak 26.0.0). The placeholder env-var names for the BFF-facing clients MUST be the canonical names the BFF already uses, so the realm secret and the BFF secret resolve from the same source. The realm generator (`export-ci-realm.mjs`) MUST likewise emit placeholders (never a secret value) and MUST fail if a confidential client has no placeholder mapping.
- **FR-018** (US5): The CI provisioning MUST supply every placeholder's value to the Keycloak container environment: the BFF-facing client secrets and the E2E password from the existing CI secret source, and the CI-only clients whose secret is arbitrary in the E2E path (fetched-at-runtime / bearer-only / unused) from freshly-minted per-run values. A missing required value MUST fail the stack bring-up fast (`${VAR:?}`), never import a realm with an unresolved credential.
- **FR-016** (US4): The credential-fallback detector (FR-015b) MUST be keyed on a **curated env-var name set** — `E2E_TEST_PASSWORD`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY` (the secrets this feature manages via `.env.e2e.local` / the job env) — matching both the JS `?? 'x'` / `|| 'x'` idiom and the `get`/`getenv`/`cfg`/`_cfg("NAME", "x")` getter-default idiom. It MUST NOT use a generic `PASSWORD|SECRET|TOKEN` substring match (a tree-wide grep proved that false-positives on public `*_CLIENT_ID` / `*_AUDIENCE` / `*_TTL_SECONDS`, the deterministic LangFuse `sk-lf-mcm-dev-*` fixtures, and the feature-023 throwaway CI-realm client secrets). The env-**setting** idiom (`monkeypatch.setenv("NAME", "x")`) is NOT a fallback and MUST NOT be flagged. Empty `?? ''` / no-default forms are permitted.

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
- **SC-008** (US4): Grepping the whole tracked tree for the known live test-user password literal yields zero occurrences.
- **SC-009** (US4): Zero test/tooling files supply a hardcoded literal default for an E2E credential env-var (verified by the extended `secret-scan` gate, which self-tests the detection and passes on the cleaned tree).
- **SC-010** (US4): With the credential unset and no local file, a must-run consumer fails visibly and a skip-contract integration suite skips — neither runs with an empty or hardcoded credential.
- **SC-011** (US5): Grepping the committed `ci-realm.json` for a credential value yields only `${ENV_VAR}` placeholders — zero plaintext passwords or client-secret values (verified: the existing `secret-scan` gate stays green over the file).
- **SC-012** (US5): On a CI run the realm imports with all placeholders resolved and the web + mobile E2E login and agent flows pass unchanged; a missing required credential env var fails the bring-up fast rather than importing a broken realm.

## Assumptions

- The mobile test runner (Maestro) exposes an environment-variable ingestion channel that does not require secrets on the command line; the PRD identifies the `MAESTRO_`-prefixed shell-variable mechanism as this channel. The exact in-flow variable naming under that prefix is confirmed by a short implementation-time spike before the doc-wide cleanup.
- The CI job already injects the four E2E secrets into its process environment (from the Forgejo Actions secret store); this feature reuses that environment rather than changing secret provisioning.
- "Shared host" threat model: the CI runner is a multi-account host where the process list is readable across local accounts; a developer's single-user machine is not a meaningful `ps`-exposure threat, so the security outcome (US1) targets CI while the consolidation (US2) benefits both.
- The web (Playwright) E2E path does not use the mobile test runner, so it is out of scope for the argv leak (US1–US3). It IS in scope for the hardcoded-credential-fallback cleanup (US4): it consumes the same live test-user password as a `?? 'literal'` fallback and must be made fail-clean + sourced from `.env.e2e.local`.
- Maestro Cloud is not used and is out of scope.
- The identity/rotation of the test and API credentials themselves is unchanged; this feature only changes their delivery to the runner.
- The guard extends the project's existing secret-scan gate culture (feature 021/022) and runs in the CI guardrails workflow.

## Previously Deferred — now in scope (US5, 2026-07-05b)

Two items were surfaced while addressing US4 and initially deferred; both were then **brought into scope as US5** (FR-017/FR-018):

- **`infrastructure-as-code/docker/keycloak/ci-realm.json` committed credentials** (the E2E password + confidential client secrets): now written as `${ENV_VAR}` placeholders resolved at Keycloak import — no clear-text credential remains in the committed realm.
- **`scripts/export-ci-realm.mjs` throwaway client-secret handling**: the `CI_*_SECRET ?? 'ci-throwaway-*'` literal map was replaced by a `${ENV_VAR}`-placeholder map (canonical names), so the generator no longer emits or requires any secret value.

Residual (genuinely out of scope): the `secret-scan` fallback detector remains a **curated name set** (FR-016), not a generic `PASSWORD|SECRET|TOKEN` matcher, by deliberate design (a generic matcher false-positives on public identifiers and deterministic fixtures — see FR-016 rationale).
