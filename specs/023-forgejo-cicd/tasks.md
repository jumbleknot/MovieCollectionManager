---
description: "Task list for feature 023 — Self-Hosted Forgejo Actions CI/CD"
---

# Tasks: Self-Hosted Forgejo Actions CI/CD (GitHub Actions Retirement)

**Input**: Design documents from `specs/023-forgejo-cicd/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: This is a config-as-code (CI/CD) feature. Per the constitution's TDD principle, the plan adopts an **adapted TDD** where the **gates are the RED/GREEN checks** (gate scripts, `docker compose config` fail-fast, Trivy, the ported E2E suites, the post-deploy probe). Each user-story phase below carries an explicit RED→GREEN verification task instead of app-style unit tests (plan Complexity Tracking, research R9).

**Organization**: Tasks grouped by user story (US1→US4) for independent delivery.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependency)
- **[Story]**: US1 / US2 / US3 / US4
- All paths are repo-root-relative.

## Conventions for this feature

- Workflows live in `.forgejo/workflows/`. Names are behavior-based (`guardrails`, `app-ci`, `cd-deploy`) per the constitution — requirement ids go in YAML comments for traceability.
- **No committed secrets or infra-topology literals.** Every credential is `${{ secrets.X }}`; every host/namespace/webhook is `${{ vars.X }}` (contracts/secrets-and-variables.md). The `guardrails` gates enforce this on every push.
- **Operator tasks** (Forgejo/Komodo UI, branch protection) are marked `(operator)` — they are config the pipeline depends on, captured here so nothing is silently assumed.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prove the runner executes workflows and the secret/variable plumbing exists.

- [ ] T001 Create `.forgejo/workflows/` and a temporary `smoke.yml` (push trigger: `actions/checkout` + `echo`) to confirm the registered `act_runner` executes a job. **RED→GREEN**: before — no workflow runs on push to the forge; after — the `smoke` job reports green on the commit. (Removed in T026.)
- [ ] T002 [P] (operator) Seed the Forgejo Actions **secrets** and **variables** stores to match [contracts/secrets-and-variables.md](./contracts/secrets-and-variables.md) exactly (names must equal what the workflows reference: `FORGEJO_REGISTRY_TOKEN`, `ANTHROPIC_API_KEY`, `E2E_TEST_*`, `KOMODO_WEBHOOK_*`, `NX_…_ACCESS_TOKEN`, BFF/KC client secrets; vars `REGISTRY`, `NS`, `REGISTRY_USER`, `NX_…_CACHE_SERVER`, `KOMODO_WEBHOOK_URL`, `MODEL_PROVIDER`).
- [ ] T003 [P] (operator) Confirm the runner advertises the labels the workflows target — `ubuntu-latest` for standard jobs and `kvm:host` for the Android-emulator job (Server-Setup-Runbook §2.4 / §Phase 7).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared wiring used by US2 and US3. **Note**: US1 (guardrails) depends on **Setup only**, not this phase — it is the true MVP and can ship first. US2/US3 require this phase.

- [ ] T004 Wire the self-hosted Nx remote-cache **client** in `nx.json` driven by env (`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` var + `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` secret) — no token literal in the file; local runs (no token) fall back to local cache. **RED→GREEN**: `secret-scan` stays clean on `nx.json`; a no-op re-run of an `nx` target reports a remote cache hit in CI (research R2).

**Checkpoint**: Cache client ready — US2/US3 can begin. US1 may already proceed.

---

## Phase 3: User Story 1 — Guardrail checks run on the homelab forge (Priority: P1) 🎯 MVP

**Goal**: The cheap guardrails (resource-naming, inline-secret, whole-tree secret-scan, agent gates) run on the homelab runner on push and gate the commit, identical to GitHub today.

**Independent Test**: Push a compliant change → all guardrail jobs green on the forge; push a guardrail violation → the matching job fails naming the file, same as GitHub Actions produced.

- [ ] T005 [US1] Author `.forgejo/workflows/guardrails.yml` porting `.github/workflows/naming-gate.yml` + `secret-scan.yml` + `agent-gates.yml` as jobs in one workflow: preserve each job's `paths:` scoping (secret-scan whole-tree, naming on compose/scripts, agent on `agents/**`+`mcp-servers/**`); keep node `24.14.1` + pnpm `10.33.0` + uv setup; run each check via its exact command (`node scripts/check-resource-naming.mjs --section=all`, `check-no-inline-secrets.mjs --selftest` then plain, `secret-scan.mjs --selftest` then plain, `pnpm nx lint/test/test:golden movie-assistant` with `LLM_CASSETTE_MODE=replay`). (FR-001, FR-002, FR-003)
- [ ] T006 [US1] Confirm `guardrails.yml` references no credential literal (the agent golden gate runs keyless in replay; no `${{ secrets }}` needed) — and the file passes the secret + inline-secret gates it itself runs. (FR-004, SC-009)
- [ ] T007 [US1] **RED→GREEN verification** (quickstart Scenario 1): push a compliant change → every guardrail job green; then push (a) an inline credential-shaped string in a tracked compose file and (b) an unapproved Docker network name → `secret-scan`/inline-secret and resource-naming jobs **fail** naming the offending file; revert → green. (US1 acceptance 1–4, SC-001)

**Checkpoint**: US1 deliverable — guardrails enforced on the forge. MVP shippable.

---

## Phase 4: User Story 2 — Full application test suite runs on the homelab forge (Priority: P2)

**Goal**: A push runs the full CI (nx-affected lint/build/unit + web Playwright E2E + release APK + Maestro agent flows) against a self-provisioned, containerized stack — no Metro, no host-network hacks.

**Independent Test**: Clean-checkout push provisions its own env (realm imports, secrets generated, stack healthy), web E2E green, 4 agent flows green on the KVM emulator; a forced failure uploads diagnostic artifacts.

- [ ] T008 [US2] Export + sanitize a **throwaway** CI realm to `infrastructure-as-code/docker/keycloak/ci-realm.json` (realm `grumpyrobot`, client `movie-collection-manager`, `mc-admin`/`mc-user` roles, the `E2E_TEST_USER` with `mc-user`, throwaway client secrets only). Closes the `android-e2e.yml` "BLOCKED (ci-provisioning)" TODO. **RED→GREEN**: `secret-scan.mjs` passes on it (throwaway shapes allowlisted if flagged); Keycloak boots locally with `--import-realm`. (FR-006, FR-011; kept separate from 022's `prod-realm.json`, FR-009)
- [ ] T009 [US2] Author the **env-provisioning** steps used by `app-ci`: run `node scripts/gen-dev-secrets.mjs` (mint `stacks/*.env`), write `keycloak/.env.local` + `secrets/keycloak_db_password.txt` + `frontend/mcm-app/.env.docker` from the CI secrets, and mount `ci-realm.json` via Keycloak `--import-realm`. (FR-006)
- [ ] T010 [US2] Author `.forgejo/workflows/app-ci.yml` porting `.github/workflows/android-e2e.yml`: free-disk, enable KVM, install latest Compose plugin, pnpm/node(20)/java(17)/android setup, create networks+volumes, bring up auth→mcm stacks (`--wait`), `pnpm nx docker-build mcm-app` + dev BFF container (`bff-nonsecure`), `pnpm nx up-agents-prod` (MODEL_PROVIDER var), Playwright browser install + fixture seed via web `global-setup`, build release APK (`APK_VARIANT=release APK_ABI=x86_64` via `nx run mcm-app:build-apk`), run the Maestro agent flows **per-file** (gating→enable→4 agent flows→test-connection→disable), upload Maestro artifacts + dump container logs on failure. (FR-007, FR-008, FR-009, FR-010)
- [ ] T011 [US2] Prepend an **nx-affected** lint/build/unit stage to `app-ci.yml` (`pnpm nx affected --target=lint,build,test`) consuming the T004 remote cache; ensure unaffected projects are skipped. (FR-005, SC of cache check)
- [ ] T012 [US2] **RED→GREEN verification** (quickstart Scenario 2): clean-checkout push → env provisions with zero manual steps, stacks healthy, web E2E green against the dev-container BFF (no Metro/host-net), release APK built, all 4 agent flows green; force a failure → Maestro screenshots + view hierarchy + container logs upload. (US2 acceptance 1–5, SC-002, SC-003)

**Checkpoint**: US1 + US2 — full CI runs on the forge.

---

## Phase 5: User Story 3 — Green builds deploy themselves to production (Priority: P3)

**Goal**: On green CI on `main`, build→scan→publish (by tag+digest)→Komodo redeploy all prod stacks by digest→health probe→rollback on failure. Promote by digest, never rebuild.

**Independent Test**: Merge a green change to `main` → 6 images built/scanned/published by digest, Komodo redeploys, health probe passes; force a probe failure → rollback to prior digest.

- [ ] T013 [US3] (operator) Define the **Komodo Stacks** for the prod compose files (prod-auth + prod-app + the upstream data-store stacks), each with registry login, the prod compose file reference, digest-pull strategy, and a redeploy webhook; record the webhook URL/auth into the Forgejo `KOMODO_WEBHOOK_URL` var + `KOMODO_WEBHOOK_AUTH` secret. (FR-015a; contracts/komodo-deploy-and-rollback.md)
- [ ] T014 [US3] Author the **build+scan+publish** job in `.forgejo/workflows/cd-deploy.yml`: build all 6 images via their Nx targets, retag `${{ vars.REGISTRY }}/${{ vars.NS }}/<svc>:${{ github.sha }}`, `trivy image --severity CRITICAL --exit-code 1` each (block on critical), `docker login` with `FORGEJO_REGISTRY_TOKEN`, push, and capture each `@sha256:` digest into a run manifest. (FR-012, FR-013, FR-014; contracts/image-and-digest-promotion.md)
- [ ] T015 [US3] Author the **deploy** job: hand the digest manifest to Komodo and POST the Stack redeploy webhook(s) so the prod daemon pulls **by digest** — CI-built stacks by run-digest, upstream stacks (prod-auth/data stores) at their pinned digests; CI never runs compose on the prod daemon (isolation). (FR-015, FR-015a, FR-015b, FR-017)
- [ ] T016 [US3] Author the **post-deploy health probe + rollback** step: probe `https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` (issuer == public auth origin), `https://mcm.${BASE_DOMAIN}` health 200, container health; on failure trigger Komodo rollback to the prior digest. (FR-016, SC-002, SC-007)
- [ ] T017 [US3] Gate `cd-deploy.yml` to `push` on `main` only, with the deploy job `needs:` a green CI signal; verify a working-branch push runs CI but **not** `cd-deploy` (fail-closed, no approval gate). (FR-020, FR-025)
- [ ] T018 [US3] **022 co-delivery validation**: validate the full CD path end-to-end by deploying the **upstream Keycloak prod stack** alone (no app build needed) — digest deploy + probe pass + forced rollback — proving Komodo wiring before 022's prod-app compose lands; document that full-app deploy unblocks when 022 delivers `keycloak/compose.prod.yaml` + `bff/compose.prod.yaml` + `prod-realm.json`. (plan 022↔023 boundary)
- [ ] T019 [US3] **RED→GREEN verification** (quickstart Scenario 3): merge green → images published by digest, Komodo redeploys, probe passes; then (a) a critical-vuln image → not published, no deploy; (b) forced probe failure → rollback to prior digest; (c) unset a prod `${VAR:?}` → deploy aborts naming the variable. (US3 acceptance 1–5, SC-004, SC-005, SC-006, SC-010)

**Checkpoint**: US1–US3 — push to `main` deploys itself to prod.

---

## Phase 6: User Story 4 — GitHub Actions is fully retired (Priority: P4)

**Goal**: Remove the cloud workflows, keep GitHub as a no-Actions push-mirror, repoint merge gating to the forge pipeline, document the rollback.

**Independent Test**: No cloud workflow remains; a push mirrors to GitHub with no Actions run; `main` protection requires the forge checks; the rollback procedure is documented.

- [ ] T020 [US4] Delete `.github/workflows/*` (all five: `agent-gates.yml`, `android-apk.yml`, `android-e2e.yml`, `naming-gate.yml`, `secret-scan.yml`). Removing the files inherently disables GitHub Actions on the mirror. (FR-021)
- [ ] T021 [US4] (operator) Repoint `main` branch-protection **required status checks** in Forgejo to the `guardrails` + `app-ci` job names (not the retired GitHub checks). (FR-023)
- [ ] T022 [US4] **Verify** (quickstart Scenario 4): push to the forge → mirrors to GitHub (already-configured mirror) and starts **no** GitHub Actions run; `.github/workflows` is empty. (FR-022, SC-008)
- [ ] T023 [US4] Document the cutover + rollback (restore a workflow from git history to temporarily re-enable cloud CI if the homelab runner is unavailable) in `docs/proposals/homelab-setup/` (PRD-CI or runbook). (FR-024)

**Checkpoint**: All user stories complete — homelab pipeline is the sole CI/CD.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation reconciliation (FR-028) and final validation.

- [ ] T024 [P] FR-028 — reconcile `docs/proposals/homelab-setup/`: **PRD-CI.md** status → "implemented as feature 023", mark server/runner/registry/Komodo/cache DONE, change §2.6 "two-step promotion (recommended)" → single-step + digest rollback, note stages 9–12 = `cd-deploy.yml`; **Phase-11-Work-Order.md** remove "§1 HARD DEPENDENCY — Phase 15 not done", reorder CI/CD before prod deploy, B2 APK → Forgejo; **Server-Setup-Runbook.md** strip the two-step-promotion recommendation; **keycloak-prod.compose.yaml** keep host/network facts consistent (one fact, four files). (FR-028, SC-011)
- [ ] T025 [P] FR-028 — reconcile feature-022 artifacts: rewrite the "Scope boundary — does NOT build CI/CD / Phase 15 hard dependency" section (spec/HANDOFF) to "deploys through 023"; resolve **T017** → Forgejo Actions builds the prod APK; shrink the coded-vs-manual table (Komodo deploy now pipeline-driven; only Cloudflare routes + real-secret seeding + the device test remain manual). (FR-027, FR-028, SC-011)
- [ ] T026 Remove the temporary `smoke.yml` (T001) now that `guardrails` + `app-ci` prove the runner. (cleanup)
- [ ] T027 Run the full [quickstart.md](./quickstart.md) Scenarios 1–5 and confirm SC-001…SC-011; capture the run as the feature's acceptance evidence.
- [ ] T028 [P] Update `CLAUDE.md` (Testing/CI section) to note the CI/CD now lives in `.forgejo/workflows/` on the homelab runner and GitHub Actions is retired — so the next session doesn't reach for `.github/workflows`.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no dependencies — start immediately.
- **Foundational (P2 / T004)**: depends on Setup; blocks **US2 + US3** (not US1).
- **US1 (P1)**: depends on **Setup only** → the MVP, shippable before Foundational.
- **US2 (P2)**: depends on Foundational (T004) + Setup.
- **US3 (P3)**: depends on Foundational + US2 being green (CD gates on a green CI signal). T018 (upstream-only) can validate the path before 022's prod compose exists; full-app deploy needs 022's artifacts.
- **US4 (P4)**: depends on US1 + US2 green (safe to retire GitHub only once the forge pipeline is trusted).
- **Polish (P7)**: doc reconciliation (T024/T025) can run in parallel anytime after the decisions are fixed (now); T026/T027/T028 after the stories they validate.

### Within a story

- US1: T005 (author) → T006 (no-literal check) → T007 (RED/GREEN).
- US2: T008 (ci-realm) + T009 (provision steps) → T010 (workflow) → T011 (affected stage) → T012 (RED/GREEN).
- US3: T013 (Komodo stacks, operator) → T014 (build/scan/publish) → T015 (deploy) → T016 (probe/rollback) → T017 (gating) → T018 (co-delivery) → T019 (RED/GREEN).
- US4: T020 (delete) → T021 (gating, operator) → T022 (verify) → T023 (doc).

### Parallel opportunities

- T002, T003 (operator setup) in parallel with T001.
- T024, T025, T028 (doc reconciliation) are `[P]` — independent files.
- Within US2, T008 and T009 touch different files and can proceed together.

---

## Parallel Example: Polish doc reconciliation

```bash
# Independent files — run together:
Task: "T024 reconcile docs/proposals/homelab-setup/* to pipeline-first + single-step"
Task: "T025 reconcile specs/022-prod-public-hostname-auth/* scope-boundary + T017"
Task: "T028 update CLAUDE.md CI section to .forgejo/workflows"
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 Setup (T001–T003).
2. Phase 3 US1 (T005–T007) — **STOP & VALIDATE**: guardrails green on the forge, violations caught. Shippable MVP.

### Incremental delivery

1. Setup → US1 (guardrails on forge) — MVP.
2. + Foundational (nx cache) + US2 (full CI green on forge).
3. + US3 (auto-deploy to prod; validate via upstream Keycloak stack first, then 022's app compose).
4. + US4 (retire GitHub Actions) once US1/US2 trusted.
5. Polish: reconcile all docs (FR-028) and run the quickstart.

### Notes

- `[P]` = different files, no incomplete dependency.
- Operator tasks (`(operator)`) are Forgejo/Komodo UI config the pipeline depends on — listed so nothing is silently assumed.
- TDD is satisfied by the per-story RED→GREEN gate tasks (T007, T012, T019, T022) per the plan's adapted-TDD (Complexity Tracking).
- Commit after each task or logical group; keep the secret + naming gates green throughout.
- The regression bar is the **existing** web E2E + 4 mobile agent flows running green on the new runner — no new app tests are authored; the suites are reused (CLAUDE.md feature-007/013 paths).
