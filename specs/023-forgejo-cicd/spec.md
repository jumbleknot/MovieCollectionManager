# Feature Specification: Self-Hosted Forgejo Actions CI/CD (GitHub Actions Retirement)

**Feature Branch**: `023-forgejo-cicd`

**Created**: 2026-06-23

**Status**: Draft

**Input**: User description: "Build the self-hosted Forgejo Actions CI/CD pipeline on the existing homelab server and retire GitHub Actions completely, so every push is built, tested, and (on the deploy branch) deployed to production by the homelab pipeline — with GitHub reduced to a push-mirror only. Then feature 022 (production public-hostname authentication) deploys *through* this pipeline rather than being hand-deployed. Normative stage list: docs/proposals/homelab-setup/PRD-CI.md §2.5."

## Overview

Today the repository's automated checks run on **GitHub Actions**, and there is no automated path to production at all — production is deployed by hand. The companion homelab program described this backwards: hand-configure production first, then "someday" build a pipeline (the deferred "Phase 15") to deploy it. The homelab foundation needed for that pipeline now exists and is running — a self-hosted Forgejo forge with a registered Actions runner, a Komodo deployment controller bound to an isolated production container host, Forgejo's built-in container registry, and a self-hosted build cache — but nothing yet *uses* it for CI or CD.

This feature builds that pipeline and inverts the order. It moves all continuous-integration checks onto **Forgejo Actions** on the homelab build host, adds the missing **continuous-deployment** path (build images → scan → publish to the homelab registry → controller redeploys production → health-verify → roll back on failure), and **retires GitHub Actions entirely**, leaving GitHub as a backup push-mirror with no role in the build or deploy path. With the pipeline in place, the production public-hostname authentication work (feature 022) becomes a *consumer* of the pipeline: it supplies production configuration artifacts and is deployed through the pipeline, never by hand.

It deliberately does not change application behavior or business logic, and it does not stand up the homelab infrastructure (server, runner, controller, registry, build cache) — that already exists. It changes only *where* and *how* the project is built, tested, published, and deployed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Guardrail checks run on the homelab forge (Priority: P1)

A contributor pushes a branch to the homelab forge and the repository's cheap guardrail checks — the inline-secret gate, the whole-tree secret scan, the resource-naming gate, and the agent-layer gates — run automatically on the homelab build host and report pass/fail back on the commit, performing exactly the same checks they perform on the cloud CI today. This slice is independently shippable: it needs only the already-running runner and proves the runner, secret plumbing, and check parity end to end before any heavier workload is ported.

**Why this priority**: Every later stage runs on the same runner and depends on the same secret/variable plumbing and the same green guardrails. Getting the fast, low-risk checks running and green first de-risks everything that follows, and it is the smallest slice that demonstrates the forge can run the project's checks at all.

**Independent Test**: Push a branch with a deliberately compliant change and confirm every ported guardrail check runs on the homelab runner and reports green on the commit; push a change that violates a guardrail (an inline credential-shaped string, an unapproved network name) and confirm the corresponding check runs and fails the commit with the same finding the cloud CI would have produced.

**Acceptance Scenarios**:

1. **Given** the ported guardrail workflows on the homelab forge, **When** a contributor pushes a branch, **Then** the inline-secret gate, whole-tree secret scan, resource-naming gate, and agent-layer gates each run on the homelab runner and report status on the commit.
2. **Given** a push that introduces an inline credential-shaped string, **When** the guardrail checks run, **Then** the secret-scan check fails and names the offending file, identically to the cloud CI behavior.
3. **Given** a push that introduces an unapproved Docker network name, **When** the guardrail checks run, **Then** the resource-naming check fails.
4. **Given** the guardrail workflows reference any credential, **When** they execute, **Then** the credential is sourced from the forge's CI secret/variable store and never appears as a literal in a committed workflow file.

---

### User Story 2 - Full application test suite runs on the homelab forge (Priority: P2)

A contributor's push triggers the full continuous-integration suite on the homelab build host: affected-project lint, build, and unit/integration tests across all three languages (using the self-hosted build cache); provisioning of a reproducible test environment from a committed identity-realm export and generated throwaway secrets; bring-up of the resident backend and agent stack; the web end-to-end suite against the containerized backend; a release-variant mobile build; and the mobile agent end-to-end flows on a hardware-accelerated emulator — all without the local development bundler and without host-network workarounds. On failure, diagnostic artifacts (screenshots, view hierarchy, container logs) are uploaded.

**Why this priority**: This is the bulk of CI value and the reason the homelab host exists — it removes the local bundler crashes, host-network fragility, and login-timing flakes that made the interactive mobile-agent loop unreliable. It depends on US1's runner/secret plumbing being proven, and it must be green before any deployment path is trusted to gate on it.

**Independent Test**: From a clean checkout, push to a working branch and confirm the suite provisions its own environment (realm imports, secrets generated, stack healthy), runs the web E2E suite green against the containerized backend, builds the release mobile artifact, and runs all mobile agent flows green on the emulator — with no dependency on a hand-prepared host — and that a forced failure uploads the diagnostic artifacts.

**Acceptance Scenarios**:

1. **Given** a clean checkout pushed to a working branch, **When** the CI suite runs, **Then** it provisions the test environment from the committed realm export and generated secrets without any manual setup step.
2. **Given** the resident backend and agent stack, **When** the web end-to-end suite runs against the containerized backend, **Then** it passes without the local development bundler and without host-network workarounds.
3. **Given** the mobile agent end-to-end flows, **When** they run on the hardware-accelerated emulator, **Then** each flow passes, run in isolation so the per-user rate limit and short-lived token window are not exceeded.
4. **Given** a failing end-to-end run, **When** the job finishes, **Then** emulator screenshots, view hierarchy, and container logs are uploaded as retrievable artifacts.
5. **Given** affected-project selection and the self-hosted build cache, **When** consecutive runs touch unrelated projects, **Then** unaffected projects are not rebuilt or retested.

---

### User Story 3 - Green builds deploy themselves to production (Priority: P3)

When CI is green on the designated deploy branch, the pipeline builds a container image per service, scans each image for known critical vulnerabilities, publishes the passing images to the homelab registry pinned by both tag and immutable digest, and signals the deployment controller to pull those exact images and redeploy the production stacks on the isolated production host. A post-deploy health probe confirms the deployment converged; if it fails, the controller rolls back to the previously deployed digest. Production runs the exact artifact that was tested — it is never rebuilt for production.

**Why this priority**: This is the continuous-deployment half — the capability that did not exist before in any form. It depends on US1 (guardrails) and US2 (a trustworthy green CI signal) and turns "tested" into "deployed" without a human running deploy commands. It is the prerequisite that lets feature 022 deploy through the pipeline.

**Independent Test**: Merge a green change to the deploy branch and confirm the pipeline builds and scans each service image, publishes them to the homelab registry by tag and digest, triggers the controller to redeploy the production stacks from those digests, and that the production health probe passes; then force a post-deploy probe failure and confirm the controller rolls back to the prior digest.

**Acceptance Scenarios**:

1. **Given** a green CI run on the deploy branch, **When** the deploy stage runs, **Then** each service image is built, scanned, and — only if free of critical vulnerabilities — published to the homelab registry with both a tag and an immutable digest.
2. **Given** published images, **When** the deployment controller redeploys production, **Then** it pulls the images by the exact digest produced in this run — production is not rebuilt from source.
3. **Given** a completed redeploy, **When** the post-deploy health probe runs, **Then** a passing probe marks the deploy successful and a failing probe triggers an automatic rollback to the previously deployed digest.
4. **Given** an image with a critical vulnerability, **When** the scan stage runs, **Then** the image is not published and the deploy does not proceed.
5. **Given** the build/test host and the production host, **When** any pipeline stage runs, **Then** build/test workloads and production workloads remain on separate isolated container hosts with separate networks and volumes.

---

### User Story 4 - GitHub Actions is fully retired (Priority: P4)

A maintainer completes the cutover: the cloud CI workflows are removed from the repository, GitHub is configured as a push-mirror target only (it receives commits for backup and visibility but runs no checks and performs no deploys), and any merge gating that previously depended on cloud CI status now depends on the homelab pipeline's status. The cutover is documented, including a rollback path to temporarily re-enable cloud CI if the homelab runner is unavailable.

**Why this priority**: It realizes the "switch completely" intent and removes the split-brain risk of two CI systems disagreeing. It is last because retiring the old system is only safe once the homelab pipeline (US1–US3) is demonstrably green and trusted.

**Independent Test**: Confirm no cloud CI workflow remains in the repository, that a push still mirrors to GitHub but triggers no cloud CI run there, that merge gating references the homelab pipeline's checks, and that the documented rollback procedure to re-enable cloud CI is present and accurate.

**Acceptance Scenarios**:

1. **Given** the completed cutover, **When** the repository is inspected, **Then** no cloud CI workflow definitions remain in the tracked tree.
2. **Given** a push to the homelab forge, **When** it mirrors to GitHub, **Then** GitHub receives the commits but starts no cloud CI run.
3. **Given** branch-merge gating, **When** a change is proposed, **Then** the required checks are the homelab pipeline's checks, not cloud CI's.
4. **Given** the homelab runner is unavailable, **When** a maintainer follows the documented rollback, **Then** cloud CI can be temporarily re-enabled to unblock work.

---

### Edge Cases

- **Runner unavailable.** If the homelab runner is down when a push arrives, no checks run and nothing merges or deploys; the documented rollback (US4) allows temporarily re-enabling cloud CI. The pipeline must fail closed (no deploy), never deploy on an absent or errored CI signal.
- **Hardware-accelerated emulator under rootless isolation.** The mobile emulator requires kernel virtualization access; if that access is unavailable to the isolated runner user, the mobile E2E stage fails loudly rather than silently skipping — a skipped mobile suite must never be mistaken for a passing one.
- **Image published but deploy fails.** A published image whose deploy fails the health probe must trigger rollback to the prior digest and leave the registry image in place (for diagnosis), without leaving production in a half-deployed state.
- **Deploy branch vs. working branch.** Pushes to a working branch run CI only (stages stop before publish); only the designated deploy branch runs the publish-and-deploy stages. A working-branch push must never deploy.
- **Secret present in CI store but absent in production store.** CI secrets and production secrets live in separate stores; a value available to CI must not be assumed available to production, and a missing production secret must abort the deploy with a message naming the variable rather than deploying with a fallback.
- **Cache poisoning / stale cache.** A corrupt or stale build-cache entry must not produce a green result for code that would otherwise fail; cache is an accelerator, never the source of truth for pass/fail.
- **Mirror divergence.** If the GitHub mirror push fails, the homelab pipeline result still stands (mirror is backup-only and not in the critical path), but the failure must be visible so the mirror can be repaired.

## Requirements *(mandatory)*

### Functional Requirements

#### Guardrail parity on the homelab forge (US1)

- **FR-001**: The repository's guardrail checks — inline-secret gate, whole-tree secret scan, resource-naming gate, and agent-layer gates — MUST run on the homelab build host on every push, triggered by the homelab forge.
- **FR-002**: Each ported guardrail check MUST perform the same validation and produce the same pass/fail outcome as its cloud-CI predecessor for the same input.
- **FR-003**: A guardrail check MUST report its status back on the pushed commit so it can gate merges.
- **FR-004**: Any credential referenced by a workflow MUST be sourced from the forge's CI secret/variable store; no credential literal may appear in a committed workflow file (the inline-secret and whole-tree secret gates MUST continue to pass for all files this feature adds).

#### Full application CI on the homelab forge (US2)

- **FR-005**: A push to a working branch MUST trigger affected-project lint, build, and unit/integration tests across the frontend, backend, and agent layers, using the self-hosted build cache so unaffected projects are skipped.
- **FR-006**: The CI suite MUST provision its test environment reproducibly from a clean checkout — importing a committed identity-realm export and generating throwaway per-run secrets — with no dependency on a hand-prepared host.
- **FR-007**: The CI suite MUST bring up the resident backend and agent stack in the correct order (identity provider before the services that depend on it) and confirm health before running end-to-end suites.
- **FR-008**: The web end-to-end suite MUST run against the containerized backend without the local development bundler and without host-network workarounds.
- **FR-009**: The CI suite MUST build the release-variant mobile artifact and run the mobile agent end-to-end flows on a hardware-accelerated emulator, each flow isolated so the per-user rate limit and short-lived token window are not exceeded.
- **FR-010**: On any end-to-end failure, the suite MUST upload diagnostic artifacts (emulator screenshots, view hierarchy, container logs).
- **FR-011**: The committed identity-realm export used by CI MUST carry only throwaway CI secrets; no production secret may be committed.

#### Continuous deployment (US3)

- **FR-012**: On a green CI run on the designated deploy branch, the pipeline MUST build one container image per service.
- **FR-013**: Each built image MUST be scanned for known vulnerabilities, and an image with a critical finding MUST NOT be published and MUST block the deploy.
- **FR-014**: Passing images MUST be published to the homelab registry pinned by both a tag and an immutable digest.
- **FR-015**: The deployment controller MUST redeploy production by pulling the exact image digests produced in the same run — production MUST NOT be rebuilt from source for deployment (promotion by digest).
- **FR-016**: After redeploy, a post-deploy health probe MUST run; a passing probe marks the deploy successful and a failing probe MUST trigger an automatic rollback to the previously deployed digest.
- **FR-017**: Build/test workloads and production workloads MUST run on separate isolated container hosts with separate networks and volumes.
- **FR-018**: CI secrets and production secrets MUST live in separate stores (CI secrets in the forge's Actions secret store; production secrets in the deployment controller's secret store or a vault); neither may be committed to git.
- **FR-019**: A required production secret that is unset MUST abort the deploy with a message naming the missing variable, never deploy with a fallback default.
- **FR-020**: Publish-and-deploy stages MUST run only on the designated deploy branch; a push to any working branch MUST run CI only and never deploy.

#### Cutover and retirement (US4)

- **FR-021**: All cloud CI workflow definitions MUST be removed from the tracked repository.
- **FR-022**: GitHub MUST be retained as a push-mirror target only — it receives commits for backup/visibility and runs no checks and performs no deploys.
- **FR-023**: Merge gating that previously depended on cloud CI status MUST be repointed to the homelab pipeline's checks.
- **FR-024**: The cutover MUST be documented, including a rollback procedure to temporarily re-enable cloud CI if the homelab runner is unavailable.
- **FR-025**: The pipeline MUST fail closed: if the CI signal is absent or errored, no merge gate passes and no deploy proceeds.

#### Cross-cutting: reproducibility, the 022 dependency, and documentation consistency

- **FR-026**: The prod mobile artifact MUST be built by this pipeline (resolving the prior open question of which CI system builds it — it is this homelab pipeline, not cloud CI), baking the public application host URL from a CI variable rather than a hard-coded value.
- **FR-027**: Feature 022's production deployment MUST be effected through this pipeline: 022 supplies the production configuration artifacts (identity-provider production config and realm, backend public-origin configuration, client redirect targets, and the prod mobile artifact's baked URL) and is deployed by the pipeline, not by hand. (Operator-only steps that remain manual — publishing the two public routes at the edge and seeding real production secret values into the controller/vault — are documented, not automated by this feature.)
- **FR-028**: The four homelab-setup proposal documents and all feature-022 artifacts MUST be reconciled so the "build the pipeline first, then deploy 022 through it" sequencing and the GitHub→Forgejo cutover are consistent across the tree (no document may still describe the pipeline as a deferred future dependency or production as hand-deployed).

### Key Entities *(include if data involved)*

- **Guardrail workflow**: A homelab-forge automation that runs one or more repository guardrail checks on push and reports status on the commit.
- **CI workflow**: The homelab-forge automation that runs the full affected lint/build/test plus web and mobile end-to-end suites against a provisioned, containerized environment.
- **CD workflow**: The homelab-forge automation that, on the deploy branch, builds, scans, publishes, deploys, health-verifies, and (on failure) rolls back.
- **Committed CI realm export**: The reproducible identity-provider configuration imported in CI, carrying throwaway CI secrets only — distinct from the production realm artifact owned by feature 022.
- **Service image**: A built, scanned container artifact published to the homelab registry and identified by an immutable digest; the unit of promotion to production.
- **Production stack**: The set of production compose definitions the deployment controller redeploys from published digests on the isolated production host.
- **CI secret store / production secret store**: Two separate credential stores — one for build/test, one for production — neither committed to git.
- **GitHub push-mirror**: The retained external mirror that receives commits for backup/visibility and runs no checks or deploys after cutover.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the repository's guardrail checks run on the homelab build host on push and produce the same pass/fail verdict as the cloud-CI predecessor for the same input.
- **SC-002**: From a clean checkout, the full CI suite provisions its own environment and runs to completion (web E2E green, all mobile agent flows green) with zero manual host-preparation steps.
- **SC-003**: The web end-to-end suite and every mobile agent end-to-end flow pass on the homelab runner without the local development bundler and without host-network workarounds.
- **SC-004**: A green change merged to the deploy branch reaches production with no human running build, publish, or deploy commands.
- **SC-005**: Production runs the exact image digest produced and tested in the same pipeline run in 100% of deploys (no rebuild-for-prod).
- **SC-006**: An image with a critical vulnerability is never published and never deployed.
- **SC-007**: A forced post-deploy health-probe failure rolls back to the prior digest, leaving production on a known-good version.
- **SC-008**: After cutover, no cloud CI workflow remains in the tracked tree, a push mirrors to GitHub without starting any cloud CI run, and merge gating references only the homelab pipeline's checks.
- **SC-009**: Both repository secret guardrails (inline-secret and whole-tree scan) pass with zero findings for all files this feature introduces, and no credential literal appears in any committed workflow file.
- **SC-010**: Starting a production deploy with a required secret unset aborts with a message naming the missing variable, in 100% of cases (no silent fallback).
- **SC-011**: Feature 022's production deployment is performed by this pipeline (not hand-run), and all four homelab-setup proposal documents plus the feature-022 artifacts describe the same "pipeline first, deploy 022 through it" sequencing with no contradictions.

## Assumptions

- **The homelab foundation already exists and is running.** The build host, the isolated production host, the forge with its registered Actions runner, the registry, the deployment controller, and the self-hosted build cache are provisioned and operational. Standing any of these up is out of scope; this feature authors the workflows and deploy wiring that use them.
- **The forge is the source of truth.** The homelab forge is the primary repository; GitHub is a backup mirror. The branch where prior cloud-CI work lives remains a reusable asset to port from.
- **Reusable assets carry over.** The existing cloud-CI workflow definitions and the existing release-mobile build script are the porting source; the platform changes but the build/test logic mostly survives.
- **Email/SMTP remains stubbed in production for now** (inherited from feature 022) — the pipeline deploys whatever 022's configuration specifies; opening self-registration with a real mail provider is a separate prerequisite, not part of this feature.
- **Host parameterization and secret conventions from prior features apply.** Public hosts are `mcm.${BASE_DOMAIN}` (application) and `auth.${BASE_DOMAIN}` (identity), the real domain is injected at deploy and never committed, and every credential in a tracked file is a fail-fast reference with no literal and no fallback default — enforced by the existing CI gates, which this feature keeps green.
- **The deploy branch is a single designated branch.** Continuous deployment targets one production environment from one deploy branch; multi-environment promotion beyond an optional staging smoke-test step is out of scope this iteration.
- **Application behavior is unchanged.** This feature changes only where and how the project is built, tested, published, and deployed — not domain logic, screens, or APIs.
- **Out of scope**: standing up the homelab infrastructure (already done); iOS end-to-end; performance/load testing; multi-node/HA orchestration; replacing the local development inner loop for non-agent work.
