# Feature Specification: SAST & SCA Static Security Scanning

**Feature Branch**: `033-sast-semgrep`

**Created**: 2026-07-10

**Status**: Draft

**Input**: User description: "Add static application security testing (SAST) and software composition analysis (SCA) to CI/CD as a config-as-code, keyless, blocking gate, mirroring the feature-031 DAST (OWASP ZAP) pattern. Four keyless scanners bound by one shared gate harness: Semgrep code-pattern SAST over the BFF + frontend (TypeScript/JS) and the agent layer (Python) with community rulesets plus a small custom MCM ruleset; cargo audit over mc-service Rust dependencies; pnpm audit over the JS workspace; pip-audit over the agent layer. One normalized severity scale, one allowlist-as-baseline, one blocking CI job, no new CI secrets."

## Overview

Add repeatable Static Application Security Testing (SAST) and Software Composition Analysis (SCA) to the project. Where DAST (feature 031) exercises the *running* application over HTTP, this feature analyzes the source code and the dependency graph *at rest* — before anything is deployed — and makes that analysis a first-class, config-as-code capability that developers run locally and that the CI/CD pipeline enforces on every change.

Two complementary kinds of static analysis are in scope:

- **SAST (code-pattern analysis)** inspects first-party source for insecure patterns — injection, cross-site scripting, path traversal, server-side request forgery, insecure cryptography, unsafe deserialization — across the TypeScript/JavaScript surfaces (the BFF and the frontend) and the Python surface (the agent layer). It additionally enforces a small set of **project-specific invariants** already documented as house rules (e.g. no direct console logging in server code, no logging of raw tokens/JWTs, the required authentication-before-authorization ordering in request handlers).
- **SCA (dependency vulnerability analysis)** cross-references the project's locked third-party dependencies — Rust, JavaScript, and Python — against public vulnerability advisory data, flagging dependencies with known CVEs.

Together these "shift security left": a whole class of regressions is caught at code-review time rather than at runtime. The capability is delivered as one shared gate harness so that all scanners share a single normalized severity scale, a single accepted-findings allowlist, and a single blocking CI job — one required check for maintainers to reason about, not four loose gates.

This feature is **keyless**: every scanner runs offline against public advisory data with no account, license, or SaaS dependency, and it introduces **no new CI secret material**.

## Clarifications

### Session 2026-07-10

- Q: What does "new High-risk finding" mean for the CI gate? → A: Same model as DAST — the version-controlled allowlist **is** the baseline. A High/Critical finding fails the build unless it is in the allowlist; there is no stored prior-scan comparison. "New" = "not yet triaged into the allowlist." On first landing, the allowlist is seeded with every finding currently present so the main branch is green from day one.
- Q: How does secret detection relate to the existing credential-shape gate? → A: The existing repository secret-scanning gate remains the **single owner** of credential detection. The SAST scanner's own secret-detection rules stay **disabled** to avoid double-gating and reconciling two allowlists. This feature scopes strictly to code-pattern SAST and dependency SCA.
- Q: Must every scanner run on every change, or can they be change-scoped for speed? → A: **Dependency (SCA) scanning MUST run on every invocation regardless of what changed**, because a newly-published advisory can render an *unchanged* dependency vulnerable — it cannot be safely path-gated. **Code (SAST) scanning** performs a full-tree scan to establish the initial baseline, then on pull requests is scoped to the changed files for speed.
- Q: Which severities block the build? → A: A finding at **High or Critical** severity (on the normalized scale) that is not in the allowlist fails the build. Medium and Low findings are surfaced in reports as warnings but do not block.
- Q: How much of the frontend does code-SAST cover? → A: The **entire** first-party TypeScript/JavaScript tree (BFF + full frontend), with no directory carve-out. Noise in pure-UI code is managed by using curated security-focused rulesets (which target sinks, not presentation) and the seeded allowlist — not by excluding paths, so a security-relevant helper added anywhere is always covered.
- Q: What normalized severity do custom MCM-invariant rule violations get? → A: **Per rule, by security impact** — not a blanket level. Credential/token/PII-leak rules (raw token/JWT/email logging) and the auth-before-authorization ordering rule are **High** (blocking); logging-hygiene rules (e.g. direct `console.*` in server code) are **Medium** (warn-only). Each custom rule declares its own severity.
- Q: How are dependency vulnerabilities in dev-only/non-runtime packages gated? → A: **By dependency scope.** A High/Critical advisory in a runtime/production-reachable dependency blocks the build; the same advisory in a dev-/test-/build-only dependency is **downgraded to a non-blocking warning** (still reported, still allowlist-able). Rationale: only runtime dependencies reach the deployed attack surface, so a dev-tool CVE should not block unrelated changes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Repeatable local SAST & SCA scan with a unified report (Priority: P1)

A developer, before opening a pull request, runs a single documented command that statically analyzes the repository — scanning first-party code for insecure patterns and cross-referencing all locked dependencies against known-vulnerability advisories — and produces one consolidated, risk-ranked report of findings across every language surface. No running application stack is required.

**Why this priority**: This is the minimum viable slice. It delivers standalone value (a developer finds security issues before pushing) and it establishes the reusable, config-as-code scan definition, the normalized severity scale, the unified findings format, and the allowlist model that CI later depends on. Without it there is no scan to promote to CI.

**Independent Test**: Run the single documented scan command in a local checkout and confirm it produces one consolidated report that lists both code-pattern findings (across the TypeScript/JS and Python surfaces) and dependency-vulnerability findings (across the Rust, JS, and Python dependency graphs), each with a normalized severity — without needing any application service running.

**Acceptance Scenarios**:

1. **Given** a local checkout, **When** the developer runs the documented scan command, **Then** all in-scope scanners execute and their results are merged into a single machine-readable findings report plus a human-readable summary, with every finding assigned a normalized severity (Critical/High/Medium/Low).
2. **Given** the scan has completed, **When** the developer inspects the report, **Then** each finding identifies its source scanner, the rule or advisory identity, and the affected location (file+line for code findings; package+version for dependency findings).
3. **Given** a source file that violates a project-specific invariant (e.g. logging a raw token in server code), **When** the code scan runs, **Then** that violation appears as a finding attributed to the custom project ruleset.
4. **Given** any single scanner's required toolchain is unavailable, **When** the scan runs, **Then** it fails fast with a clear message identifying the missing scanner rather than silently skipping a language surface and reporting a misleading clean result.

---

### User Story 2 - CI pipeline gates merges on new High/Critical findings (Priority: P2)

The CI/CD pipeline runs the same static analysis as a **blocking** check on every pull request and push, and **fails the build** when a High- or Critical-severity finding is present that has not been triaged into the allowlist. Medium- and Low-severity findings are surfaced as warnings but do not block. Dependency scanning runs every time; code scanning is scoped to the changed files after the initial baseline.

**Why this priority**: This turns the capability into an enforced quality gate on the protected main branch, preventing High/Critical static-analysis regressions from merging. It depends on the scan definition, normalized severity scale, and allowlist delivered by User Story 1.

**Independent Test**: Open a change that introduces a deliberately insecure code pattern (or adds a dependency with a known High-severity advisory) and confirm the pipeline check fails with the finding reported in the job output/artifacts; open a benign change and confirm the check passes.

**Acceptance Scenarios**:

1. **Given** a pull request, **When** the pipeline runs, **Then** a dedicated static-analysis check executes as part of the existing guardrail checks and its consolidated report is published as a build artifact.
2. **Given** the scan reports one or more **new** (un-allowlisted) High- or Critical-severity findings, **When** the check evaluates results, **Then** the check fails and blocks the merge.
3. **Given** the scan reports only Medium- or Low-severity findings (or only allowlisted High/Critical findings), **When** the check evaluates results, **Then** the check succeeds and the non-blocking findings are recorded as warnings in the job output and artifacts.
4. **Given** a pull request that changes only a subset of the code surface, **When** the code scan runs, **Then** it analyzes at least the changed files; **and given** any change at all, **When** the pipeline runs, **Then** the dependency scan runs in full regardless of which files changed.
5. **Given** the check runs, **When** it completes, **Then** it requires no secret material — no account, license key, or credential — to obtain rules or advisory data.

---

### User Story 3 - Triaged findings can be suppressed without weakening the gate (Priority: P3)

A maintainer who has reviewed a finding and determined it is a false positive or an accepted risk records that decision in a version-controlled allowlist. Thereafter that specific finding no longer blocks the pipeline, while any new, un-triaged High/Critical finding still fails the build. The finding remains visible in reports.

**Why this priority**: Without a suppression mechanism, a noisy first scan across four scanners would either block all merges or force the team to disable the gate. The allowlist keeps the gate meaningful while managing known, reviewed noise. It builds on User Story 2's gating behavior.

**Independent Test**: Add a known High/Critical finding to the allowlist, re-run the scan, and confirm the pipeline passes for that finding; introduce a different, un-triaged High/Critical finding and confirm the pipeline still fails.

**Acceptance Scenarios**:

1. **Given** a High/Critical finding that a maintainer has triaged as a false positive or accepted risk, **When** it is added to the version-controlled allowlist with a documented justification, **Then** subsequent scans no longer fail the build for that finding.
2. **Given** a finding is in the allowlist, **When** a report is produced, **Then** the finding is still visible in the report (suppressed from gating, not hidden from view) so accepted risks remain auditable.
3. **Given** the allowlist exists, **When** a new, un-triaged High/Critical finding appears, **Then** the pipeline still fails — the allowlist suppresses only explicitly enumerated findings.
4. **Given** an allowlist entry carries an optional expiry, **When** that expiry has passed, **Then** the entry no longer suppresses its finding and the finding blocks again, prompting re-review.

---

### Edge Cases

- **Noisy first landing**: The initial introduction of four scanners across three languages will surface many pre-existing findings. The allowlist seeded at landing must render the main branch green on day one, so the gate blocks only findings introduced *after* the baseline — otherwise the gate is un-adoptable.
- **Toolchain drift in CI**: The CI check must have all required language toolchains available; a missing toolchain must fail the check loudly, never silently drop a language surface from coverage.
- **Advisory data unreachable**: If public advisory data cannot be fetched (offline runner, upstream outage), the dependency scan must fail fast rather than report a false clean result.
- **Overlap with the credential-shape gate**: Code-pattern scanning must not re-implement credential detection already owned by the existing secret-scanning gate; the two must not produce competing findings on the same credential string.
- **Duplicate findings across scanners**: The same weakness could be reported by more than one scanner; the consolidated report and the allowlist must key findings precisely enough (scanner + rule/advisory + location) that suppressing one does not accidentally suppress an unrelated finding.
- **Unfixable or unscored advisory**: A dependency advisory may have no upstream fix, or no assigned severity. The severity-normalization policy must assign such findings a defined severity (defaulting a scored-but-unmapped or unscored known-vulnerable dependency conservatively) rather than dropping them.
- **Secrets in reports**: Reports and logs published as CI artifacts must not leak any credential, token, or session identifier that might appear incidentally in scanned source or scanner output.
- **Custom-rule correctness**: A project-specific code rule that is wrong (false positives or missed cases) is itself a defect; each custom rule must ship with test fixtures proving it fires on the insecure pattern and stays silent on the safe pattern.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a repeatable, documented way to run static security analysis (both code-pattern SAST and dependency SCA) of the repository from a local developer environment, without requiring any running application service.
- **FR-002**: The system MUST provide the same static security analysis as an enforced check within the CI/CD pipeline.
- **FR-003**: Code-pattern (SAST) analysis MUST cover the **entire** first-party TypeScript/JavaScript tree (the BFF and the full frontend, with no directory carve-out) and the first-party Python surface (the agent layer), detecting common insecure patterns (such as injection, cross-site scripting, path traversal, server-side request forgery, and insecure cryptography). Noise in presentation-only code MUST be managed through curated security-focused rulesets and the allowlist rather than by excluding paths from the scan.
- **FR-004**: Code-pattern analysis MUST additionally enforce a set of project-specific security invariants encoded as custom rules, including at minimum: no direct console logging in server-side code, no logging of raw tokens/JWTs/emails, and the required authentication-before-authorization ordering in request handlers. Each custom rule MUST declare a normalized severity proportionate to its security impact: credential/token/PII-leak rules and the auth-ordering rule are High (blocking); logging-hygiene rules (e.g. direct console logging in server code) are Medium (warn-only).
- **FR-005**: Dependency (SCA) analysis MUST cross-reference the project's locked third-party dependencies for the Rust service, the JavaScript workspace, and the Python agent layer against public vulnerability advisory data, and report dependencies with known vulnerabilities.
- **FR-006**: Credential/secret detection MUST remain owned by the existing repository secret-scanning gate; this feature MUST NOT enable overlapping secret-detection rules in its code scanner. Its scope is code-pattern SAST and dependency SCA only.
- **FR-007**: All scan definitions, custom rules, severity-mapping policy, and the accepted-findings allowlist MUST be checked into the repository as version-controlled config-as-code, so scans are reproducible and reviewable.
- **FR-008**: The results of all scanners MUST be consolidated into a single machine-readable findings report (suitable for the CI gate and downstream tooling) and a human-readable summary, published by the CI check as build artifacts.
- **FR-009**: Every finding MUST be assigned a severity on one normalized scale (Critical/High/Medium/Low) via a documented mapping from each scanner's native severity, so findings from different scanners are directly comparable and gated by one policy.
- **FR-010**: The CI check MUST fail the pipeline when a High- or Critical-severity finding that is **not present in the allowlist** is reported, and MUST NOT fail the pipeline for Medium- or Low-severity findings (which are surfaced as warnings). The allowlist (FR-011) is the sole baseline — there is no comparison against a stored prior-scan report.
- **FR-011**: The system MUST support a version-controlled allowlist of accepted/false-positive findings, each with a documented justification and an optional expiry, that suppresses those specific findings from the failure gate while keeping them visible in reports.
- **FR-012**: On first introduction, the allowlist MUST be seeded with every finding then present so the protected main branch passes the gate immediately, ensuring the gate blocks only findings introduced after the baseline.
- **FR-013**: Dependency (SCA) analysis MUST run in full on every CI invocation regardless of which files changed; it MUST NOT be path-gated, because a newly-published advisory can render an unchanged dependency vulnerable.
- **FR-014**: Code-pattern (SAST) analysis MUST perform a full-tree scan to establish the baseline and MAY, on pull requests, be scoped to the changed files for speed, provided changed files are always analyzed.
- **FR-015**: The scan MUST fail fast with a clear, actionable message when a required scanner toolchain is unavailable or required advisory data cannot be obtained, rather than silently skipping a language surface or reporting a misleading clean result.
- **FR-016**: The solution MUST be fully self-hosted and keyless — no dependency on any external SaaS security service, account, or license — with all scanning running on the self-hosted CI runner and local developer machines against public rules and advisory data.
- **FR-017**: The scan MUST introduce no new CI secret material; it MUST NOT require any credential, token, or account to run in CI or locally.
- **FR-018**: Reports and logs published as artifacts MUST NOT leak any credential, token, or session identifier that appears incidentally in scanned source or scanner output.
- **FR-019**: Each custom project-specific code rule MUST ship with test fixtures demonstrating it flags the insecure pattern and does not flag the corresponding safe pattern, and these rule tests MUST be runnable as part of the project's checks.
- **FR-020**: The gate evaluation logic MUST be independently testable (allowlist hit/miss, severity mapping, and pass/fail exit behavior) via a self-contained self-test mode that requires no live scan.
- **FR-021**: Dependency (SCA) findings MUST be gated by dependency scope: a High/Critical advisory in a runtime/production-reachable dependency blocks the build, while the same advisory in a dependency used only for development, testing, or building MUST be downgraded to a non-blocking warning. Both remain visible in reports and remain allowlist-able.

### Key Entities *(include if feature involves data)*

- **Scan Definition**: The version-controlled, config-as-code description of the static analysis — which scanners run, which rulesets and custom rules apply, the code surfaces and dependency manifests in scope, and the report outputs. Shared foundation for both local and CI scans.
- **Code Scanner (SAST)**: A scanner that analyzes first-party source for insecure patterns and project-specific invariant violations across a set of language surfaces.
- **Dependency Scanner (SCA)**: A scanner that cross-references a language's locked dependency graph against public vulnerability advisory data.
- **Custom Rule**: A project-authored code-pattern rule encoding an MCM-specific security invariant, accompanied by test fixtures (insecure/safe pairs).
- **Finding**: A single reported issue with a source scanner, a rule or advisory identity, an affected location (file+line or package+version), a native severity, and a normalized severity. Findings drive the CI pass/fail decision.
- **Severity Mapping**: The documented policy translating each scanner's native severity into the one normalized Critical/High/Medium/Low scale, including how unscored known-vulnerable dependencies are classified and how dependency scope (runtime vs dev/test/build-only) downgrades a dependency finding's blocking effect.
- **Finding Allowlist**: A version-controlled list of findings triaged as false positives or accepted risks, each keyed precisely (scanner + rule/advisory + location) with a justification and optional expiry, used to suppress those findings from the failure gate without hiding them from reports.
- **Scan Report**: The consolidated output of a scan run in machine- and human-readable forms, published as CI artifacts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can run the full static analysis end-to-end from a single documented command and obtain one consolidated, risk-ranked report covering code findings on both language surfaces and dependency findings across all three dependency graphs, with no running application stack.
- **SC-002**: A pull request that introduces a High/Critical insecure code pattern is blocked by the pipeline, and the blocking finding is present in the published report artifacts.
- **SC-003**: A pull request that adds a dependency carrying a known High/Critical advisory is blocked by the pipeline, and the blocking finding is present in the published report artifacts.
- **SC-004**: A pull request with no new High/Critical findings passes the check, and its report artifacts are available for download from the CI run.
- **SC-005**: Adding a specific finding to the allowlist causes subsequent scans to pass for that finding, while an unrelated new High/Critical finding still fails the pipeline — both verifiable in a single demonstration.
- **SC-006**: On the branch that introduces this feature, the protected main branch passes the gate immediately after landing (the seeded allowlist baseline holds), with zero manual gate-disabling.
- **SC-007**: Every custom project-specific rule has passing fixture tests proving it fires on the insecure pattern and stays silent on the safe pattern.
- **SC-008**: The entire capability runs with no calls to any external SaaS security service and requires no new secret material — verifiable by the absence of any added credential in configuration and the check succeeding on a runner with no security-tool account configured.
- **SC-009**: No secret material (credentials, tokens, session identifiers) appears in any committed file, scan report, or CI log produced by this feature.
- **SC-010**: A dependency advisory published against an unchanged dependency is caught on the next CI run even when the pull request changed no dependency manifest, confirming SCA is not path-gated.
- **SC-011**: A High/Critical advisory affecting only a development/test/build dependency is reported but does not block the pipeline, while the same-severity advisory in a runtime dependency does block — both verifiable in a single demonstration.

## Assumptions

- **SAST tooling**: The code-pattern scanner is Semgrep (open-source CLI), run without any commercial/SaaS layer or login. Community rulesets cover the TypeScript/JS and Python surfaces; a small project-authored ruleset encodes MCM invariants. The specific rule packs, config format, and runner belong to the implementation plan.
- **SCA tooling**: Dependency scanning uses each ecosystem's native, keyless advisory scanner — a Rust advisory-audit tool over the Rust lockfile, the JavaScript package manager's own audit over the JS lockfile, and a Python advisory-audit tool over the Python lockfile. License/policy scanning (beyond known-vulnerability advisories) is out of scope for this version.
- **CI platform**: The check runs on the existing self-hosted Forgejo Actions runner, added to the existing guardrail workflow as a blocking, branch-protection-required check. There is no GitHub Actions execution.
- **Secret detection ownership**: The existing repository secret-scanning gate remains the sole owner of credential detection; this feature deliberately does not enable overlapping secret rules.
- **Allowlist-as-baseline**: There is no stored prior-scan comparison; the version-controlled allowlist is the entire baseline, consistent with the DAST feature's model.
- **Dependency remediation**: Automatically opening pull requests to bump vulnerable dependencies is out of scope — the existing automated dependency-update tooling handles version bumps; this feature only detects and gates.
- **Relationship to DAST**: Runtime/HTTP scanning remains owned by the DAST feature (031); this feature is strictly static (source and dependency graph at rest).
- **Toolchain availability**: The CI runner can provide the JavaScript, Python, and Rust toolchains the scanners require; advisory databases are publicly reachable and may be cached.
