# Feature Specification: SAST/SCA Baseline Hardening

**Feature Branch**: `034-hardening`

**Created**: 2026-07-11

**Status**: Draft

**Input**: User description: "Remediate the pre-existing security findings surfaced by the feature-033 SAST/SCA baseline (docs/proposals/sast-sca-hardening-backlog.md): (1) upgrade vulnerable runtime dependencies with known High advisories across the Python agent layer, the JS workspace, and Rust; (2) harden the 5 container images that run as root to use a non-root user (mc-service is the reference); (3) tighten CI/CD supply-chain controls (pin actions to immutable refs, add dependency release-age cooldowns, triage shell-injection-prone workflow steps). As each finding is fixed, remove its security/sast/allowlist.yaml entry so the SAST gate enforces the fix and the baseline burns down. Exclude the verified false-positives; treat dev/build-only advisories as opportunistic/non-blocking."

## Overview

Feature 033 delivered the SAST/SCA scanning capability and, per its scope (FR-012), *detected and gated* pre-existing security findings without fixing any of them — it seeded `security/sast/allowlist.yaml` with a baseline of 55 blocking findings so `main` stayed green. This feature is the **remediation follow-up**: it actually fixes those findings and burns the allowlist down, so that the SAST gate transitions from "acknowledging known debt" to "enforcing that the debt stays fixed."

The unit of progress is deliberately simple and verifiable: **each finding that is genuinely fixed has its `allowlist.yaml` entry deleted**. Because the gate (`scripts/check-sast-findings.mjs`) fails on any un-allowlisted blocking finding, deleting an entry converts that finding from "accepted" into "must never regress." The scan re-run after the fix proves the finding is gone (the deleted entry no longer matches anything), and any future reintroduction re-blocks the build. The allowlist shrinks monotonically; the false-positive and accepted-risk entries are the only ones that legitimately remain.

The work splits into four independently shippable slices ordered by security value:

- **Runtime dependency CVEs (highest value)** — production-reachable dependencies with known High advisories across all three language ecosystems, all with a fixed version available.
- **Container non-root hardening** — five app-tier images run as root; `backend/mc-service` already drops to a non-root user and is the reference pattern.
- **CI/CD supply-chain hardening** — mutable action tags, missing dependency release-age cooldowns, and shell-injection-prone workflow steps.
- **Dev/build-only dependency CVEs (opportunistic)** — advisories on tooling/test/build dependencies that are not runtime-reachable, hence non-blocking, but still worth clearing.

This feature changes only dependency versions, container user configuration, CI workflow definitions, and the allowlist. It introduces no new application behavior and no new CI secret material.

## Clarifications

### Session 2026-07-11

- Q: What is the definitive completion signal? → A: `node scripts/check-sast-findings.mjs` stays **green** with a **materially smaller** allowlist — every remediated finding's entry is deleted, and the only remaining entries are the documented false-positives/accepted-risks and any dep bump that could not be applied (with a recorded reason). The scan is re-run on Linux/CI-equivalent file discovery, not only on Windows (feature 033 lesson: Semgrep file discovery differs by platform).
- Q: How are transitive-only dependency advisories remediated when no direct dependency declares the vulnerable package? → A: Via a lockfile-targeted upgrade (`cargo update -p <pkg>`, `uv lock --upgrade-package <pkg>`, or a pnpm override) rather than adding a direct dependency. If the transitive parent pins an incompatible range so the fixed version cannot be resolved, the entry stays allowlisted with a recorded "blocked by upstream constraint" justification instead of being deleted.
- Q: What happens to a runtime dep bump that breaks the build or tests? → A: It is not forced. The bump is reverted, the finding's allowlist entry is retained (or re-added) with an updated justification citing the specific incompatibility, and it is recorded as carried-forward debt. A green gate with an honest allowlist beats a broken build with an empty one.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Runtime dependency CVEs remediated (Priority: P1)

A maintainer wants the application's production-reachable dependencies to be free of known High-severity advisories, so that a deployed release is not shipping a documented vulnerability. Today the SAST/SCA baseline carries 19 runtime advisories across 13 packages, all suppressed only because they pre-existed the gate. The maintainer bumps each package to its fixed version, re-runs the scan to confirm the advisory is gone, and deletes the corresponding allowlist entry so a regression re-blocks.

**Why this priority**: These are the only findings that represent a *live, production-reachable* vulnerability. They are the reason the hardening branch exists. Fixing them delivers the highest security value and can ship on its own.

**Independent Test**: Bump the runtime dependencies (Python agent layer, JS workspace, Rust), re-run the SCA scan, and confirm each targeted advisory no longer appears in `findings.json` and its allowlist entry can be deleted with the gate still green. Verify the affected services still build and their existing test suites pass.

**Acceptance Scenarios**:

1. **Given** the Python agent layer pins vulnerable `aiohttp`/`cryptography`/`langchain`/`langchain-anthropic`/`langsmith`/`pydantic-settings`/`starlette`, **When** each is upgraded to its fixed version and `uv sync` re-locks, **Then** the pip-audit portion of the scan reports none of those advisories and every corresponding pip-audit allowlist entry is deleted.
2. **Given** the JS workspace lockfile carries vulnerable `form-data`/`hono`/`undici` (runtime copy), **When** each is upgraded to at least its fixed version, **Then** the pnpm-audit portion reports none of those advisories and their allowlist entries are deleted.
3. **Given** the Rust lockfile carries transitive `crossbeam-epoch` below the fixed version, **When** it is upgraded via a lockfile-targeted update, **Then** cargo-audit no longer reports RUSTSEC-2026-0204 and its allowlist entry is deleted.
4. **Given** a dependency bump that breaks a build or an existing test, **When** the failure is confirmed reproducible, **Then** the bump is reverted, the allowlist entry is retained with an updated justification, and the gate stays green.

---

### User Story 2 - Container images run as a non-root user (Priority: P2)

A maintainer wants the five app-tier container images (BFF/Expo server, agent gateway, and the three MCP servers) to drop from root to a dedicated non-root user before their entrypoint runs, matching the hardening `backend/mc-service` already applies. This reduces the blast radius if any of those processes is compromised.

**Why this priority**: Defense-in-depth. These containers currently run only on the trusted internal Docker network, so this is not an active exposure — but it is a cheap, high-signal hardening that removes an entire finding class (`dockerfile.security.missing-user`) from the baseline.

**Independent Test**: Add a non-root `USER` to each of the five Dockerfiles (mirroring mc-service), rebuild each image, confirm the container still starts and serves, re-run the SAST scan, and confirm `dockerfile.security.missing-user` no longer fires for those files so the allowlist entry can be deleted.

**Acceptance Scenarios**:

1. **Given** the five app-tier Dockerfiles never set `USER`, **When** each adds a dedicated non-root user owning its writable paths and switches to it before `CMD`, **Then** the SAST scan reports no `dockerfile.security.missing-user` finding for those files.
2. **Given** the non-root hardening is applied, **When** each image is rebuilt and started, **Then** the service starts successfully, can read its code, and can write to any runtime-writable path (caches, temp) it needs.
3. **Given** all five images are hardened, **When** the shared `dockerfile.security.missing-user` allowlist entry is evaluated, **Then** it matches no remaining finding and is deleted (or narrowed if any image legitimately cannot drop root, with a recorded reason).
4. **Given** the hardened BFF and agent-gateway images, **When** the web E2E regression and containerized agent E2E run, **Then** they pass, proving the non-root change did not break the real user path.

---

### User Story 3 - CI/CD supply-chain controls tightened (Priority: P3)

A maintainer wants the CI/CD pipeline to resist supply-chain tampering: third-party actions pinned to immutable commit SHAs (not re-pointable tags), a cooldown before brand-new dependency releases can be auto-merged, and workflow `run:` steps that never interpolate attacker-controllable input directly into a shell.

**Why this priority**: These protect the pipeline itself — the thing that builds and deploys every release. Lower immediate exposure than a live runtime CVE, but a compromised action or a malicious just-published release is a high-impact class. Shippable independently of the dependency and container work.

**Independent Test**: Pin the actions in `.forgejo/workflows/*.yml` to full commit SHAs, add release-age cooldowns to the package-manager configs, triage each `run-shell-injection` finding, re-run the SAST scan, and confirm the corresponding findings clear so their allowlist entries can be deleted; confirm the workflows still parse and run.

**Acceptance Scenarios**:

1. **Given** `.forgejo/workflows/*.yml` reference actions by mutable tags (`@v4`), **When** each is pinned to a full commit SHA (with the human-readable version retained as a trailing comment), **Then** `github-actions-mutable-action-tag` no longer fires and the workflows still run green in CI.
2. **Given** `renovate.json` has no release-age cooldown, **When** a `minimumReleaseAge` is added, **Then** the `minimum-release-age` finding clears and brand-new releases are no longer eligible for immediate auto-merge.
3. **Given** each `run-shell-injection` finding in `app-ci.yml`/`cd-deploy.yml`, **When** it is triaged and — where the interpolated value is not provably a trusted internal output/secret — refactored to pass the value via `env:` and reference `"$VAR"`, **Then** either the finding clears (refactored) or its allowlist entry is retained with a specific per-step justification (confirmed trusted, not attacker-controlled).
4. **Given** the pnpm/npm supply-chain policy gaps, **When** a trust policy / minimum-release-age / exotic-sub-dependency policy is added where the toolchain supports it, **Then** the corresponding Medium findings clear or are documented as accepted with rationale.

---

### User Story 4 - Dev/build-only dependency CVEs cleared (Priority: P4)

A maintainer wants to opportunistically clear advisories on tooling, test, and build-only dependencies. These are not runtime-reachable, so they are non-blocking (the gate treats them as warnings), but clearing them reduces scanner noise and keeps the tooling current.

**Why this priority**: Lowest security value — not production-reachable, and non-blocking by policy. Purely opportunistic; safe to defer or drop if any bump is disruptive.

**Independent Test**: Bump the dev/build-only dependencies, re-run the scan, and confirm the advisories drop out of the warning set without regressing any build or test.

**Acceptance Scenarios**:

1. **Given** dev/build-only advisories on `undici` (7.x dev copy), `vite`, `ws`, `minimatch`, `picomatch`, `http-proxy-middleware`, `esbuild`, `tmp`, and `quick-xml` (Rust dev), **When** each is bumped to its fixed version, **Then** the scan's warning set no longer lists them and no build or test regresses.
2. **Given** any dev-dep bump that proves disruptive, **When** the disruption is confirmed, **Then** the bump is dropped and the advisory remains a non-blocking warning (no allowlist entry is required for dev-scope advisories, which are warnings, not blockers).

---

### Edge Cases

- **A fixed version is not yet resolvable** (a transitive parent pins an incompatible range): the finding stays allowlisted with a "blocked by upstream constraint" justification rather than being deleted; it is recorded as carried-forward debt, not a silent skip.
- **A bump introduces a new advisory** (the fixed version itself has a fresh CVE): treat as a new finding — either bump further to a clean version or allowlist the new advisory with fresh triage; never delete an entry while leaving the package vulnerable.
- **Platform-dependent scan results** (Semgrep file discovery differs Windows vs Linux — feature 033 lesson): the burn-down is validated against the Linux/CI file-discovery result, not only local Windows, so an entry is never deleted on the basis of a finding that Windows simply failed to discover.
- **An action has no immutable SHA to pin** (e.g. a local/composite action): it is exempt from SHA-pinning with a recorded reason.
- **A `run-shell-injection` step's value is genuinely trusted** (a fixed internal job output, not PR-controllable): it stays allowlisted with a specific justification rather than being force-refactored.
- **Non-root user breaks a writable path** (a cache or temp dir the process must write): file ownership is corrected in the image build so the non-root user can write, rather than reverting to root.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Python agent layer runtime dependencies MUST be upgraded to versions that clear their known High advisories — `aiohttp` (→ 3.14.1), `cryptography` (→ 48.0.1), `langchain` (→ 1.3.9), `langchain-anthropic` (→ 1.4.6), `langsmith` (→ 0.8.18), `pydantic-settings` (→ 2.14.2), and `starlette` (→ 1.3.1) — and the lockfile MUST be re-locked to reflect them.
- **FR-002**: The JavaScript workspace runtime dependencies MUST be upgraded to clear their advisories — `form-data` (≥ 4.0.6), `hono` (≥ 4.12.25), and the runtime `undici` (≥ 6.27.0) — updating the lockfile (via override where the vulnerable package is transitive).
- **FR-003**: The Rust transitive dependency `crossbeam-epoch` MUST be upgraded to ≥ 0.9.20 via a lockfile-targeted update to clear RUSTSEC-2026-0204.
- **FR-004**: The five app-tier container images (`frontend/mcm-app/Dockerfile`, `agents/movie-assistant/Dockerfile`, and the three `mcp-servers/*/Dockerfile`) MUST run their entrypoint as a dedicated non-root user, following the `backend/mc-service` reference, with writable runtime paths owned by that user.
- **FR-005**: Third-party actions referenced in `.forgejo/workflows/*.yml` MUST be pinned to full immutable commit SHAs (retaining the human-readable version as a comment), except local/composite actions that have no SHA to pin (documented exemption).
- **FR-006**: A dependency release-age cooldown MUST be configured — `minimumReleaseAge` in `renovate.json`, plus a pnpm minimum-release-age / trust policy and an npm minimum-release-age where the toolchain supports it — so freshly published releases are not immediately eligible for auto-merge.
- **FR-007**: Each `run-shell-injection` workflow step MUST be triaged; where the interpolated value is not provably a trusted internal output/secret it MUST be refactored to pass the value through `env:` and reference it as a quoted shell variable; genuinely-trusted steps MAY remain with a specific recorded justification.
- **FR-008**: Dev/build-only advisory dependencies (`undici` 7.x dev copy, `vite`, `ws`, `minimatch`, `picomatch`, `http-proxy-middleware`, `esbuild`, `tmp`, `quick-xml`) SHOULD be bumped opportunistically; disruptive bumps MAY be dropped without penalty since these are non-blocking warnings.
- **FR-009**: For every finding actually remediated, its entry in `security/sast/allowlist.yaml` MUST be deleted so the SAST gate re-blocks any regression; entries MUST NOT be deleted for findings that are still present.
- **FR-010**: The verified false-positives / accepted-risks MUST remain allowlisted and documented, and MUST NOT be treated as remediation targets — specifically `gcm-no-tag-length` (agent-config-crypto), `bypass-tls-verification` (audit-sink opt-in), `logger-credential-disclosure` (token_exchange status-code-only), the `mcm-no-token-logging`/`mcm-auth-before-authz` unit-test hits, and `mcm-no-console-in-bff` (logger transport).
- **FR-011**: After each remediation slice, the full SAST/SCA scan MUST be re-run and the gate (`scripts/check-sast-findings.mjs`) MUST stay green; the burn-down MUST be validated against Linux/CI-equivalent file discovery, not only local Windows.
- **FR-012**: Any dependency bump that breaks a build or an existing test MUST be reverted rather than forced; its allowlist entry is retained with an updated justification citing the specific incompatibility, and it is recorded as carried-forward debt.
- **FR-013**: The affected services' existing verification suites MUST pass after remediation — at minimum the agent layer's own tests for Python bumps, the JS unit tests + web E2E regression for JS bumps and the BFF/agent container hardening, mc-service tests for the Rust bump, and CI workflow validity for the pipeline changes.

### Key Entities

- **Allowlist entry**: A record in `security/sast/allowlist.yaml` (scanner, id, locationPattern, justification, addedBy, optional expiry) that suppresses one finding from the blocking gate while keeping it visible in reports. Remediation deletes it; carried-forward debt updates its justification.
- **Finding**: One scanner result (`scanner`, advisory/rule `id`, `location`, severity, blocking flag) in `security/sast/reports/findings.json`. A finding is "remediated" when a re-scan no longer produces it.
- **Runtime vs dev/build scope**: The SCA classification that determines whether an advisory is blocking (runtime-reachable) or a non-blocking warning (dev/test/build-only). Governs whether clearing it requires an allowlist deletion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After remediation, `node scripts/check-sast-findings.mjs` exits green (no un-allowlisted blocking findings) against Linux/CI-equivalent file discovery.
- **SC-002**: All 19 runtime dependency advisories across the 13 P1 packages are either cleared (advisory absent from a fresh scan, allowlist entry deleted) or explicitly recorded as carried-forward debt with a specific upstream-constraint justification — none remain silently allowlisted as "Renovate will handle it."
- **SC-003**: The `dockerfile.security.missing-user` finding no longer fires for any of the five app-tier images, and its allowlist entry is deleted (or narrowed to any image that provably cannot drop root, with a recorded reason).
- **SC-004**: No third-party action in `.forgejo/workflows/*.yml` is referenced by a mutable tag; `github-actions-mutable-action-tag` produces zero findings (excluding documented local/composite exemptions), and the `minimum-release-age` finding on `renovate.json` is cleared.
- **SC-005**: Every `run-shell-injection` finding is resolved to either "refactored (finding cleared)" or "retained with a per-step trusted-value justification" — none is left with the original generic baseline justification.
- **SC-006**: The `security/sast/allowlist.yaml` blocking-finding entry count is materially smaller than the feature-033 baseline; the only remaining blocking entries are documented false-positives/accepted-risks (FR-010) and any recorded carried-forward debt (FR-012).
- **SC-007**: The web E2E regression passes and the containerized agent E2E passes after the container hardening and JS bumps, proving the real user path still works end-to-end.
- **SC-008**: The affected services build and their existing test suites pass after remediation (agent layer tests, JS unit tests, mc-service tests), and CI workflows remain valid and green.

## Assumptions

- The fixed versions named in the backlog (2026-07-11) are the current best targets; if a newer patch has since superseded them, the newer clean version is used instead.
- Local dev, CI, and prod container network topology is unchanged — the non-root hardening is defense-in-depth on the existing trusted internal network, not a response to a new exposure.
- The feature-033 SAST/SCA harness, severity map, and gate behavior are unchanged; this feature consumes them and edits only the allowlist, not the scanner configuration or rules.
- Renovate remains the ongoing owner of routine dependency currency; this feature performs the one-time catch-up bump for the flagged advisories and adds the release-age cooldown, after which Renovate maintains them.
- The existing repository secret-scanning gate remains the single owner of credential detection (feature 033 decision); this feature does not enable Semgrep's secret rules.
- Dev/build-only advisories are non-blocking warnings by policy; clearing them is best-effort and requires no allowlist bookkeeping.
- The scan is authoritatively validated on Linux/CI file discovery; local Windows runs are indicative only (feature 033 platform-discovery lesson).
