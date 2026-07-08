# Feature Specification: DAST Security Scanning (OWASP ZAP)

**Feature Branch**: `031-dast-zap-scanning`

**Created**: 2026-07-08

**Status**: Draft

**Input**: User description: "DAST security scanning with OWASP ZAP (OSS only, no StackHawk/SaaS). Two-part capability: (1) a repeatable local one-off scan and (2) integration into the Forgejo Actions CI/CD pipeline. Targets: the client-facing BFF (session-cookie auth), mc-service Rust/Axum API (bearer JWT), and the agent gateway/MCP layer (bearer JWT); Keycloak is explicitly out of scope. Scans must be authenticated against protected endpoints using a dedicated test user. Local one-off = passive baseline scan; CI = full active scan against an ephemeral throwaway stack. ZAP config is config-as-code checked into the repo, emitting HTML/JSON/SARIF reports as build artifacts. CI policy: gate the pipeline on any new High-risk finding, warn on Medium/Low; support a false-positive/accepted-finding allowlist. Must fit the self-hosted homelab constraints."

## Overview

Add repeatable Dynamic Application Security Testing (DAST) to the project. A DAST scanner exercises the running application over HTTP the way an attacker would — spidering reachable endpoints and probing them for security weaknesses (injection, broken access control, missing security headers, information disclosure, insecure cookies, TLS misconfiguration). This feature makes such scanning a first-class, config-as-code capability that developers can run locally and that the CI/CD pipeline enforces on every relevant change.

Because nearly all business logic (collections, movies, agent flows) sits behind Keycloak OAuth, scans MUST be **authenticated** to have value — an unauthenticated scan only reaches the login/registration surface. The scanner therefore authenticates as a dedicated, non-privileged test user before scanning protected endpoints.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Repeatable local authenticated baseline scan (Priority: P1)

A developer, before opening a pull request, runs a single documented command that spins up (or reuses) a local application stack, authenticates as a dedicated test user, performs a **non-destructive** dynamic scan of the application's HTTP surface, and produces a human-readable report of security findings ranked by risk. The scan covers the client-facing BFF, the mc-service API, and the agent gateway.

**Why this priority**: This is the minimum viable slice — it delivers standalone value (a developer can find security regressions before pushing) and it establishes the reusable, config-as-code scan definition, authenticated-scanning approach, and report format that CI later depends on. Without it, there is no scan to promote to CI.

**Independent Test**: Bring up the local stack, run the documented scan command, and confirm a report is produced that lists findings against authenticated (post-login) endpoints — not merely the public login surface. Verify the scan does not create, mutate, or delete application data.

**Acceptance Scenarios**:

1. **Given** a running local stack and a valid dedicated test user, **When** the developer runs the local scan command, **Then** the scanner authenticates and produces HTML, JSON, and SARIF reports listing findings grouped by risk level (High/Medium/Low/Informational).
2. **Given** the scan has completed, **When** the developer inspects the crawled URL inventory, **Then** it includes protected application endpoints reachable only after authentication, confirming the scan ran as an authenticated user.
3. **Given** the baseline (non-destructive) scan mode, **When** the scan runs against the local stack, **Then** no application records are created, modified, or deleted as a result of the scan.
4. **Given** the scanner cannot obtain a valid authenticated session, **When** the scan starts, **Then** it fails fast with a clear error rather than silently producing an empty or public-only report.

---

### User Story 2 - CI pipeline gates merges on new High-risk findings (Priority: P2)

The CI/CD pipeline runs an authenticated **active** dynamic scan (which sends attack payloads and may mutate data) against a disposable, throwaway application stack, and **fails the build** when a new High-risk finding is present. Medium- and Low-risk findings are surfaced as warnings but do not block. The scan runs only when application code that affects the HTTP surface changes, consistent with how the existing end-to-end job is path-gated.

**Why this priority**: This turns the capability into an enforced quality gate, preventing High-risk regressions from reaching the protected main branch. It depends on the scan definition and authenticated-scan approach delivered by User Story 1.

**Independent Test**: Open a change that introduces a deliberately vulnerable endpoint on the throwaway stack and confirm the pipeline fails with the finding reported; open a benign change and confirm the pipeline passes and publishes the report artifacts.

**Acceptance Scenarios**:

1. **Given** a pull request that touches the application HTTP surface, **When** the pipeline runs, **Then** an authenticated active scan executes against an ephemeral throwaway stack and its HTML/JSON/SARIF reports are published as build artifacts.
2. **Given** the active scan reports one or more **new** High-risk findings, **When** the scan job evaluates results, **Then** the job fails and blocks the merge.
3. **Given** the active scan reports only Medium- or Low-risk findings, **When** the scan job evaluates results, **Then** the job succeeds and the findings are recorded as warnings in the job output and artifacts.
4. **Given** a change that does not touch the application HTTP surface (e.g., documentation- or config-only), **When** the pipeline runs, **Then** the active scan job is skipped, consistent with existing path-gating.
5. **Given** the active scan runs against the throwaway stack, **When** it mutates or destroys data, **Then** no persistent or shared environment is affected.

---

### User Story 3 - Triaged findings can be suppressed without weakening the gate (Priority: P3)

A maintainer who has reviewed a finding and determined it is a false positive, or an accepted risk, records that decision in a version-controlled allowlist. Thereafter that specific finding no longer blocks the pipeline, while any **new**, un-triaged High-risk finding still fails the build.

**Why this priority**: Without a suppression mechanism, a noisy first scan would either block all merges or force the team to disable the gate entirely. The allowlist keeps the gate meaningful while managing known noise. It builds on User Story 2's gating behavior.

**Independent Test**: Add a known finding to the allowlist, re-run the scan, and confirm the pipeline passes; introduce a different, un-triaged High-risk finding and confirm the pipeline still fails.

**Acceptance Scenarios**:

1. **Given** a High-risk finding that a maintainer has triaged as a false positive or accepted risk, **When** it is added to the version-controlled allowlist with a documented justification, **Then** subsequent scans no longer fail the build for that finding.
2. **Given** a finding is in the allowlist, **When** a report is produced, **Then** the finding is still visible in the report (suppressed from gating, not hidden from view) so accepted risks remain auditable.
3. **Given** the allowlist exists, **When** a new, un-triaged High-risk finding appears, **Then** the pipeline still fails — the allowlist suppresses only explicitly enumerated findings.

---

### Edge Cases

- **Test user provisioning**: The dedicated scan test user must exist in the target environment's identity realm (local dev realm and the CI throwaway realm). If the user is absent or its credentials are wrong, the scan MUST fail fast with a clear message.
- **Session/token expiry during a long scan**: An active scan may run longer than a normal access-token lifetime. The scan MUST keep a valid authenticated session for its full duration (or re-authenticate) so protected endpoints do not start returning auth failures partway through, which would produce false "not vulnerable" results.
- **Destructive scan hitting shared data**: The active scan MUST only ever run against a disposable stack. There must be a guard preventing it from being pointed at a shared or production environment.
- **Scanner reachability of internal-only services**: mc-service and the agent gateway are normally private (BFF is the sole caller). The scan environment must expose them to the scanner without permanently widening their exposure in real deployments.
- **Empty or public-only crawl**: If authentication silently fails and the scan only reaches public endpoints, this MUST be detectable (e.g., by asserting protected URLs appear in the crawl) rather than reported as a clean pass.
- **Port conflicts on the shared homelab host**: The scan's stack and any published ports must not collide with production or other CI workloads that share the host's port space.
- **Secrets in reports**: Reports and logs published as artifacts MUST NOT leak the test user's credentials, tokens, or session identifiers.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a repeatable, documented way to run a dynamic (DAST) security scan of the running application from a local developer environment.
- **FR-002**: The system MUST provide a dynamic security scan that runs within the CI/CD pipeline.
- **FR-003**: Scans MUST authenticate as a dedicated, non-privileged test user and exercise endpoints that are only reachable after authentication, covering the client-facing BFF, the mc-service API, and the agent gateway/MCP layer.
- **FR-004**: Keycloak MUST be excluded from the scan scope (it is a hardened third-party product maintained via image updates, not project code).
- **FR-005**: The local scan MUST default to a **non-destructive** mode that does not create, modify, or delete application data.
- **FR-006**: The CI scan MUST run in an **active** mode (sending attack payloads) against an **ephemeral, disposable** application stack where data loss is acceptable, reusing the project's existing throwaway stack bring-up and throwaway identity realm.
- **FR-007**: The scan definition and its configuration MUST be checked into the repository as version-controlled config-as-code, so scans are reproducible and reviewable.
- **FR-008**: Each scan MUST produce reports in a human-readable format and in machine-readable formats suitable for CI artifacts and downstream tooling (HTML, JSON, and SARIF), and the CI job MUST publish these as build artifacts.
- **FR-009**: The CI scan MUST fail the pipeline when a new High-risk finding is present, and MUST NOT fail the pipeline for Medium- or Low-risk findings (which are surfaced as warnings).
- **FR-010**: The system MUST support a version-controlled allowlist of accepted/false-positive findings, each with a documented justification, that suppresses those specific findings from the failure gate while keeping them visible in reports.
- **FR-011**: The CI scan MUST be path-gated so it runs only when application code affecting the HTTP surface changes, consistent with the existing end-to-end job, and MUST be skipped otherwise.
- **FR-012**: The scan MUST detect and fail fast when it cannot establish an authenticated session, rather than producing a misleading public-only or empty report.
- **FR-013**: The scan MUST maintain a valid authenticated session for the full duration of the scan (including long active scans), re-authenticating if necessary.
- **FR-014**: The solution MUST be fully self-hosted with no dependency on any external SaaS security service; all scanning runs on the self-hosted CI runner and local developer machines.
- **FR-015**: All secrets required by the scan (test user credentials, any tokens) MUST be sourced from the pipeline's secret store (and local environment) and MUST NOT be committed to the repository or leaked into reports, logs, or artifacts.
- **FR-016**: Any host ports published by the scan's stack MUST NOT collide with production or other CI/dev workloads sharing the same host, consistent with the project's prod/CI port-isolation rules.
- **FR-017**: There MUST be a safeguard that prevents the destructive active scan from being executed against a shared or production environment.

### Key Entities *(include if feature involves data)*

- **Scan Definition**: The version-controlled, config-as-code description of a scan — its target(s), authentication method, scan intensity (baseline vs active), crawl scope, and report outputs. Shared foundation for both local and CI scans.
- **Scan Target**: A running service exposed to the scanner (the BFF, mc-service, or the agent gateway), each with its own base URL and authentication style (session-cookie for the BFF; bearer token for the API and agent gateway).
- **Scan Test User**: A dedicated, non-privileged identity in the target realm used solely by the scanner to reach authenticated endpoints. Distinct per environment (local dev realm, CI throwaway realm).
- **Finding**: A single reported security issue with a risk level (High/Medium/Low/Informational), a rule identity, and the affected request. Findings drive the CI pass/fail decision.
- **Finding Allowlist**: A version-controlled list of findings triaged as false positives or accepted risks, each with a justification, used to suppress those findings from the failure gate without hiding them from reports.
- **Scan Report**: The output of a scan run in human- and machine-readable formats (HTML/JSON/SARIF), published as CI artifacts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can run the local baseline scan end-to-end from a single documented command and obtain a risk-ranked report, with no manual authentication steps beyond providing the dedicated test-user credentials.
- **SC-002**: The scan's crawled URL inventory demonstrably includes protected, post-authentication application endpoints (not just the public login/registration surface) for all in-scope targets.
- **SC-003**: The local baseline scan completes without creating, modifying, or deleting any application data (verified by comparing application state before and after the scan).
- **SC-004**: A pull request that introduces a High-risk vulnerability on the throwaway stack is blocked by the pipeline, and the blocking finding is present in the published report artifacts.
- **SC-005**: A pull request with no High-risk findings passes the scan gate, and its report artifacts are available for download from the CI run.
- **SC-006**: Adding a specific finding to the allowlist causes subsequent scans to pass for that finding, while an unrelated new High-risk finding still fails the pipeline — both verifiable in a single demonstration.
- **SC-007**: Changes that do not touch the application HTTP surface do not trigger the active scan job (the job is skipped), keeping pipeline time unaffected for such changes.
- **SC-008**: No secret material (test-user credentials, tokens, session identifiers) appears in any committed file, scan report, or CI log.
- **SC-009**: The entire scanning capability operates with no calls to any external SaaS security service.

## Assumptions

- **Tooling**: The DAST scanner is OWASP ZAP (open-source), used without any commercial/SaaS layer (no StackHawk or equivalent). The specific ZAP configuration format and runner belong to the implementation plan.
- **CI platform**: Scans run on the existing self-hosted Forgejo Actions `act_runner`; secrets come from the Forgejo Actions secret store. There is no GitHub Actions execution.
- **Stack reuse**: The CI active scan reuses the existing end-to-end job's stack bring-up (ephemeral application containers) and the throwaway CI identity realm rather than introducing a parallel environment.
- **Test user**: A dedicated non-privileged scan test user (with `mc-user`-equivalent access) exists (or will be provisioned) in both the local dev realm and the CI throwaway realm; it is not an administrator.
- **PR gating**: The active scan runs on pull requests that touch the application HTTP surface and gates merges to the protected main branch; documentation/config-only changes skip it. A separate scheduled cadence is out of scope for this feature.
- **In-scope targets' exposure**: mc-service and the agent gateway are made reachable to the scanner only within the scan environment; their normal private-network posture in real deployments is unchanged.
- **Baseline vs active split**: The local one-off scan is the non-destructive baseline mode; the destructive active scan is reserved for CI against the throwaway stack. Running the active scan locally is possible but only against a disposable local stack.
- **Existing infrastructure**: The project's existing Keycloak realm import mechanism, Docker Compose stacks, and secret-generation tooling are available to provision the scan environment and test user.
