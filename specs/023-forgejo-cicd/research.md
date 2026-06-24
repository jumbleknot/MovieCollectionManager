# Phase 0 Research: Forgejo Actions CI/CD

Resolves the unknowns from the plan's Technical Context. Each item: **Decision · Rationale · Alternatives**.

## R1 — Forgejo Actions YAML compatibility & marketplace actions

**Decision**: Port the five workflows to `.forgejo/workflows/*.yml` using the same GitHub-Actions YAML schema. Keep `runs-on: ubuntu-latest` (the registered runner advertises the `ubuntu-latest:docker://node:22-bookworm` label, so it matches). Continue using `uses:` marketplace actions (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`, `actions/setup-java`, `android-actions/setup-android`, `reactivecircus/android-emulator-runner`, `actions/upload-artifact`); the `act_runner` resolves `uses:` against GitHub by default. Pin every action to a tag already in use today (no version drift during the port).

**Rationale**: PRD-CI.md §2.1 explicitly chose Forgejo Actions because the workflows "port with minimal edits (GitHub-Actions-compatible YAML)." Minimizing edits during the platform move isolates "did the port work?" from "did I also change behavior?".

**Alternatives**: Rewriting steps to avoid marketplace actions (pure shell) — rejected: large rewrite, loses the proven android-emulator-runner KVM handling. Gitea-native action forks — rejected: unnecessary while GitHub resolution works; revisit only if a specific action fails on the runner (captured as an implementation risk, surfaced via `log`/job failure, not silently skipped).

**Residual risk** (verify at implementation, fail loudly): `android-emulator-runner` under rootless Docker + `--device /dev/kvm`. Mitigation already documented (Server-Setup-Runbook §2.4): the Android job may run on a dedicated kvm-capable runner label (`kvm:host`) while everything else stays fully rootless. A missing-KVM condition MUST fail the job, never skip the mobile suite (spec Edge Cases).

## R2 — Self-hosted Nx remote cache client wiring

**Decision**: Wire `nx.json` / the workflow env to the existing self-hosted cache server via two env vars set in CI (not committed literals): `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` (a Forgejo Actions **variable**) and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` (a Forgejo Actions **secret**). Keep `nx.json` `targetDefaults` cache flags as-is (build/test/lint cacheable; `e2e`/`test:integration` not). Use `nx affected` for lint/build/unit in `app-ci.yml`.

**Rationale**: nx.json is currently local-cache-only; the cache *server* already exists (infra confirmed). Driving the client by env keeps the token out of git and lets the same `nx.json` work locally (no token → local cache) and in CI (token → remote cache). The deprecated `@nx/s3-cache`/`@nx/shared-fs-cache` (CVE-2025-36852) are avoided — the custom OpenAPI cache server is the supported path (Server-Setup-Runbook §Phase 8).

**Alternatives**: Nx Cloud — rejected by PRD-CI (self-hosted only, no Nx Cloud). Committing the token in `nx.json` — rejected: violates §Secrets Management and would trip the secret-scan gate.

## R3 — Image build, tag, and digest promotion

**Decision**: Build all six service images **through their Nx targets** (`nx build mc-service`, `nx docker-build mcm-app`, `nx build movie-assistant`, `nx build movie-mcp|web-api-mcp|spreadsheet-mcp`) — these already wrap `docker build -t <svc>:latest -f <path> .` from repo root. In CD, retag each to `${REGISTRY}/${NS}/<svc>:${GIT_SHA}`, push, and capture the returned `@sha256:` **digest** from `docker push`/`docker buildx imagetools inspect`. Promotion to prod uses the **digest**, never `:latest` or the SHA tag. `${REGISTRY}` and `${NS}` come from Forgejo Actions variables; registry login uses a `secrets.FORGEJO_REGISTRY_TOKEN`.

**Rationale**: Reuses the constitution-mandated Nx build path (no parallel raw-docker build to drift). The SHA tag gives a human-readable handle; the digest gives the immutability FR-015 requires. Host/namespace as variables keeps infra topology out of committed YAML (plan Constraints).

**Alternatives**: `:latest`-only promotion — rejected: not immutable, breaks rollback-to-prior-digest. Rebuilding images on the prod daemon — rejected: violates "promote by digest, never rebuild for prod" (FR-015).

## R4 — Komodo deploy, single-step, health probe & rollback

**Decision**: Each prod compose file is a **Komodo Stack** (prod-auth, prod-app, plus the upstream data-store stacks). CD, after pushing images, hands Komodo the new digests and triggers a redeploy via the Stack's webhook (`secrets.KOMODO_WEBHOOK_*`) / Komodo API. Deploy is **single-step direct to prod** (per clarify). A **post-deploy health probe** (curl the public `mcm.`/`auth.` health/discovery endpoints + container health) runs after convergence; on failure, Komodo **rolls back to the previously deployed digest** (Komodo retains the prior digest). No staging stack this iteration.

**Rationale**: Matches the clarified single-step decision and Komodo's documented digest-pin + prior-digest-rollback capability (PRD-CI §2.6, Server-Setup-Runbook §Phase 9). The probe + rollback is the safety net that justifies skipping staging at single-box scale.

**Alternatives**: Two-step staging→prod — explicitly deferred by the clarify (adds a staging stack + smoke stage). CI SSH-ing into the prod daemon to run compose — rejected: breaks ci/prod isolation (FR-017) and bypasses Komodo's rollback bookkeeping.

**Doc-reconciliation flag**: Server-Setup-Runbook §Phase 9 and PRD-CI §2.6 currently say "two-step promotion (recommended)." These MUST be reconciled to single-step + digest-rollback (FR-028 task) so the docs match the clarified decision.

## R5 — CI environment provisioning (the original blocker) via `ci-realm.json`

**Decision**: Commit `infrastructure-as-code/docker/keycloak/ci-realm.json` — a **throwaway** realm export (realm `grumpyrobot`, the `movie-collection-manager` client + `mc-admin`/`mc-user` roles, the `E2E_TEST_USER` with `mc-user`, and **throwaway** client secrets safe to commit). The CI workflow: runs `node scripts/gen-dev-secrets.mjs` to mint the per-stack `stacks/*.env`, fills `keycloak/.env.local` + `secrets/keycloak_db_password.txt` and `frontend/mcm-app/.env.docker` from CI secrets, wires Keycloak `--import-realm` against `ci-realm.json`, then brings up the stack. This closes the `android-e2e.yml` "BLOCKED (ci-provisioning)" TODO.

**Rationale**: FR-006/FR-011 require reproducibility from a clean checkout. The realm export is the documented fix (PRD-CI §4.3). Throwaway secrets in `ci-realm.json` are explicitly permitted; real prod secrets never appear (separate store).

**Alternatives**: Hand-prepared runner state — rejected: not reproducible, the exact failure that blocked the GitHub job. Generating the realm at runtime via Admin API scripts — rejected: slower and re-introduces secret-generation/hand-copy fragility.

**Boundary**: `ci-realm.json` (023, throwaway) is kept **separate** from `prod-realm.json` (022, sanitized prod) — FR-009/022 alignment.

## R6 — Deploy trigger, branch & fail-closed

**Decision**: `guardrails.yml` + `app-ci.yml` trigger on `push` (all branches) and `pull_request`. `cd-deploy.yml` triggers on `push` to `main` only, and its job `needs:` a green CI signal (gated so publish/deploy never run unless CI passed). No manual approval gate. If the runner is down, nothing runs and nothing merges/deploys (fail-closed is the default Forgejo behavior — absent check ≠ passing check once branch protection requires it).

**Rationale**: Matches the clarify (auto on green CI on `main`, no approval). Fail-closed is FR-025.

**Alternatives**: Dedicated `release` branch / manual approval — deferred by the clarify.

## R7 — GitHub Actions retirement & mirror

**Decision**: US4 deletes `.github/workflows/*` (all five). The forge→GitHub **push-mirror already exists** (clarify), so no mirror setup; US4 only (a) removes the workflows, (b) verifies a push mirrors to GitHub without starting any GitHub Actions run, (c) repoints Forgejo **branch-protection required status checks** to the new `guardrails`/`app-ci` jobs, and (d) documents the rollback (temporarily restore a workflow from git history if the runner is unavailable). Removing the workflow files inherently disables GitHub Actions on the mirror (no workflow → no run).

**Rationale**: Smallest safe cutover; the mirror already being configured removes a whole work item (clarify). FR-021/022/023/024.

**Alternatives**: Disabling Actions via GitHub repo settings while keeping the files — rejected: leaves dead YAML in the tree (fails the "no cloud CI workflow remains" check, SC-008).

## R8 — Documentation reconciliation scope (FR-028)

**Decision**: Reconcile, in one pass, so the tree tells one story ("pipeline first, deploy 022 through it; GitHub retired"):
- **PRD-CI.md** — flip status from "future Phase 15" to "implemented as feature 023"; mark server/runner/registry/Komodo/cache as DONE; change §2.6 "two-step promotion (recommended)" → single-step + digest rollback; keep the §2.5 stage table as the normative reference (note stages 9–12 are 023's `cd-deploy.yml`).
- **Phase-11-Work-Order.md** — remove "§1 HARD DEPENDENCY — Phase 15 not done"; reorder so CI/CD precedes prod deploy; B2 APK → built by Forgejo (not GitHub).
- **Server-Setup-Runbook.md** — strip the two-step-promotion recommendation; confirm registry/runner/Komodo facts; note the cache client is wired in `nx.json`.
- **keycloak-prod.compose.yaml** — keep as the draft 022 promotes to `keycloak/compose.prod.yaml`; ensure host/network facts agree (one fact, four files — the 022 T027 rule).
- **Feature-022 artifacts** — rewrite the "Scope boundary — does NOT build CI/CD / Phase 15 hard dependency" section to "deploys through 023"; resolve T017 → Forgejo builds the prod APK; shrink the coded-vs-manual table (Komodo deploy is now pipeline-driven; only Cloudflare routes + real-secret seeding + the device test remain manual).

**Rationale**: FR-028/SC-011 require a contradiction-free tree. Doing it as one reconciliation pass (a tasks-phase workstream) avoids leaving half-updated docs.

**Alternatives**: Deferring doc edits to a later cleanup — rejected: the user's request explicitly includes the doc updates, and a tree that still calls the pipeline a "future dependency" would mislead the next session.

## R9 — TDD adaptation for config-as-code

**Decision**: Adopt the feature-022 adaptation: each checkpoint defines an explicit RED→GREEN gate. Examples: add a prod compose with a missing `${VAR:?}` ⇒ `docker compose config` fails (RED) → provide the var ⇒ passes (GREEN); plant an inline secret ⇒ `secret-scan.mjs` fails (RED) → remove ⇒ passes (GREEN); a workflow that should deploy on `main` ⇒ pushing a working branch does NOT deploy (RED expectation) → merging to `main` deploys (GREEN). tasks.md carries the literal expected output per checkpoint.

**Rationale**: Satisfies the constitution's test-first intent where no app-style unit test is meaningful (Complexity Tracking). Mirrors the approach already accepted for 022.

**Alternatives**: Skipping TDD framing — rejected: TDD is constitutionally mandatory; the gate-as-test framing is the compliant adaptation.
