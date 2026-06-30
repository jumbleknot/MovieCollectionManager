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
- **Platform Parity Table: N/A.** This is a CI/CD config feature that authors **no new per-platform application behavior or test scenarios** — it runs the *existing* web (Playwright) and mobile (Maestro) suites as the regression bar on a new runner. The constitution's platform-parity requirement (v1.2.0) applies to features that add app behavior/test tasks; there is no new web-vs-mobile coverage matrix to track here.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prove the runner executes workflows and the secret/variable plumbing exists.

- [X] T001 Create `.forgejo/workflows/` and a temporary `smoke.yml` (push trigger: `actions/checkout` + `echo`) to confirm the registered `act_runner` executes a job. **RED→GREEN**: before — no workflow runs on push to the forge; after — the `smoke` job reports green on the commit. (Removed in T026.)
- [ ] T002 [P] (operator) Seed the Forgejo Actions **secrets** and **variables** stores to match [contracts/secrets-and-variables.md](./contracts/secrets-and-variables.md) exactly (names must equal what the workflows reference: `REGISTRY_TOKEN` (not `FORGEJO_*` — reserved prefix), `ANTHROPIC_API_KEY`, `E2E_TEST_*`, `KOMODO_WEBHOOK_*`, `NX_…_ACCESS_TOKEN`, BFF/KC client secrets; vars `REGISTRY`, `NS`, `REGISTRY_USER`, `NX_…_CACHE_SERVER`, `KOMODO_WEBHOOK_URL`, `MODEL_PROVIDER`).
- [ ] T003 [P] (operator) Confirm the runner advertises the labels the workflows target — `ubuntu-latest` for standard jobs and `kvm:host` for the Android-emulator job (Server-Setup-Runbook §2.4 / §Phase 7).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared wiring used by US2 and US3. **Note**: US1 (guardrails) depends on **Setup only**, not this phase — it is the true MVP and can ship first. US2/US3 require this phase.

- [X] T004 Wire the self-hosted Nx remote-cache **client** in `nx.json` driven by env (`NX_SELF_HOSTED_REMOTE_CACHE_SERVER` var + `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` secret) — no token literal in the file; local runs (no token) fall back to local cache. **RED→GREEN**: `secret-scan` stays clean on `nx.json`; a no-op re-run of an `nx` target reports a remote cache hit in CI (research R2).

**Checkpoint**: Cache client ready — US2/US3 can begin. US1 may already proceed.

---

## Phase 3: User Story 1 — Guardrail checks run on the homelab forge (Priority: P1) 🎯 MVP

**Goal**: The cheap guardrails (resource-naming, inline-secret, whole-tree secret-scan, agent gates) run on the homelab runner on push and gate the commit, identical to GitHub today.

**Independent Test**: Push a compliant change → all guardrail jobs green on the forge; push a guardrail violation → the matching job fails naming the file, same as GitHub Actions produced.

- [X] T005 [US1] Author `.forgejo/workflows/guardrails.yml` porting `.github/workflows/naming-gate.yml` + `secret-scan.yml` + `agent-gates.yml` as jobs in one workflow: preserve each job's `paths:` scoping (secret-scan whole-tree, naming on compose/scripts, agent on `agents/**`+`mcp-servers/**`); keep node `24.14.1` + pnpm `10.33.0` + uv setup; run each check via its exact command (`node scripts/check-resource-naming.mjs --section=all`, `check-no-inline-secrets.mjs --selftest` then plain, `secret-scan.mjs --selftest` then plain, `pnpm nx lint/test/test:golden movie-assistant` with `LLM_CASSETTE_MODE=replay`). (FR-001, FR-002, FR-003)
- [X] T006 [US1] Confirm `guardrails.yml` references no credential literal (the agent golden gate runs keyless in replay; no `${{ secrets }}` needed) — and the file passes the secret + inline-secret gates it itself runs. (FR-004, SC-009)
- [X] T007 [US1] **RED→GREEN verification** (quickstart Scenario 1): push a compliant change → every guardrail job green; then push (a) an inline credential-shaped string in a tracked compose file and (b) an unapproved Docker network name → `secret-scan`/inline-secret and resource-naming jobs **fail** naming the offending file; revert → green. (US1 acceptance 1–4, SC-001)

**Checkpoint**: US1 deliverable — guardrails enforced on the forge. MVP shippable.

---

## Phase 4: User Story 2 — Full application test suite runs on the homelab forge (Priority: P2)

**Goal**: A push runs the full CI (nx-affected lint/build/unit + web Playwright E2E + release APK + Maestro agent flows) against a self-provisioned, containerized stack — no Metro, no host-network hacks.

**Independent Test**: Clean-checkout push provisions its own env (realm imports, secrets generated, stack healthy), web E2E green, 4 agent flows green on the KVM emulator; a forced failure uploads diagnostic artifacts.

- [ ] T008 [US2] Export + sanitize a **throwaway** CI realm to `infrastructure-as-code/docker/keycloak/ci-realm.json` (realm `grumpyrobot`, client `movie-collection-manager`, `mc-admin`/`mc-user` roles, the `E2E_TEST_USER` with `mc-user`, throwaway client secrets only). Closes the `android-e2e.yml` "BLOCKED (ci-provisioning)" TODO. **RED→GREEN**: `secret-scan.mjs` passes on it (throwaway shapes allowlisted if flagged); Keycloak boots locally with `--import-realm`. (FR-006, FR-011; kept separate from 022's `prod-realm.json`, FR-009) — **tooling authored** (`scripts/export-ci-realm.mjs`); the runtime-managed `grumpyrobot` realm lives only in the dev box's Postgres volume (no committed source), so generating + boot-verifying `ci-realm.json` is an **operator** step on that box.
- [X] T009 [US2] Author the **env-provisioning** steps used by `app-ci`: run `node scripts/gen-dev-secrets.mjs` (mint `stacks/*.env`), write `keycloak/.env.local` + `secrets/keycloak_db_password.txt` + `frontend/mcm-app/.env.docker` from the CI secrets, and mount `ci-realm.json` via Keycloak `--import-realm`. (FR-006)
- [X] T010 [US2] Author `.forgejo/workflows/app-ci.yml` porting `.github/workflows/android-e2e.yml`: free-disk, enable KVM, install latest Compose plugin, pnpm/node(20)/java(17)/android setup, create networks+volumes, bring up auth→mcm stacks (`--wait`), `pnpm nx docker-build mcm-app` + dev BFF container (`bff-nonsecure`), `pnpm nx up-agents-prod` (MODEL_PROVIDER var), Playwright browser install + fixture seed via web `global-setup`, build release APK (`APK_VARIANT=release APK_ABI=x86_64` via `nx run mcm-app:build-apk`), run the Maestro agent flows **per-file** (gating→enable→4 agent flows→test-connection→disable), upload Maestro artifacts + dump container logs on failure. (FR-007, FR-008, FR-009, FR-010)
- [X] T011 [US2] Prepend an **nx-affected** lint/build/unit stage to `app-ci.yml` (`pnpm nx affected --target=lint,build,test`) consuming the T004 remote cache; ensure unaffected projects are skipped. (FR-005, SC of cache check)
- [ ] T012 [US2] **RED→GREEN verification** (quickstart Scenario 2): clean-checkout push → env provisions with zero manual steps, stacks healthy, web E2E green against the dev-container BFF (no Metro/host-net), release APK built, all 4 agent flows green; force a failure → Maestro screenshots + view hierarchy + container logs upload. (US2 acceptance 1–5, SC-002, SC-003)

**Checkpoint**: US1 + US2 — full CI runs on the forge.

---

## Phase 5: User Story 3 — Green builds deploy themselves to production (Priority: P3)

**Goal**: On green CI on `main`, build→scan→publish (by tag+digest)→Komodo redeploy all prod stacks by digest→health probe→rollback on failure. Promote by digest, never rebuild.

**Independent Test**: Merge a green change to `main` → 6 images built/scanned/published by digest, Komodo redeploys, health probe passes; force a probe failure → rollback to prior digest.

- [ ] T013 [US3] (operator) **SUPERSEDED by Phase 8 (T031/T036).** Original: hand-define the Komodo Stacks in the UI. Revised: the Stacks are declared as config-as-code TOML (T031) and applied by a Komodo **ResourceSync** bootstrapped once (T036). Keep the deliverable — record the **ResourceSync** webhook URL/auth into the Forgejo `KOMODO_WEBHOOK_URL` var + `KOMODO_WEBHOOK_AUTH` secret — but it is fulfilled via Phase 8, not a per-Stack UI build. (FR-015a; contracts/komodo-deploy-and-rollback.md; plan Addendum)
- [X] T014 [US3] Author the **build+scan+publish** job in `.forgejo/workflows/cd-deploy.yml`: build all 6 images via their Nx targets, retag `${{ vars.REGISTRY }}/${{ vars.NS }}/<svc>:${{ github.sha }}`, `trivy image --severity CRITICAL --exit-code 1` each (block on critical), `docker login` with `FORGEJO_REGISTRY_TOKEN`, push, and capture each `@sha256:` digest into a run manifest. (FR-012, FR-013, FR-014; contracts/image-and-digest-promotion.md)
- [X] T015 [US3] Author the **deploy** job: hand the digest manifest to Komodo and POST the Stack redeploy webhook(s) so the prod daemon pulls **by digest** — CI-built stacks by run-digest, upstream stacks (prod-auth/data stores) at their pinned digests; CI never runs compose on the prod daemon (isolation). (FR-015, FR-015a, FR-015b, FR-017)
- [X] T016 [US3] Author the **post-deploy health probe + rollback** step: probe `https://auth.${BASE_DOMAIN}/realms/grumpyrobot/.well-known/openid-configuration` (issuer == public auth origin), `https://mcm.${BASE_DOMAIN}` health 200, container health; on failure trigger Komodo rollback to the prior digest. **Confirm the concrete `mcm-bff` health path during implementation** — if no dedicated `/health` route exists, probe a known-200 route plus container health (the android-e2e port relied on `--wait` container health, not an HTTP health path). (FR-016, SC-002, SC-007)
- [X] T017 [US3] Gate `cd-deploy.yml` to `push` on `main` only, with the deploy job `needs:` a green CI signal; verify a working-branch push runs CI but **not** `cd-deploy` (fail-closed, no approval gate). (FR-020, FR-025)
- [ ] T018 [US3] **022 co-delivery validation**: validate the full CD path end-to-end by deploying the **upstream Keycloak prod stack** alone (no app build needed) — digest deploy + probe pass + forced rollback — proving Komodo wiring before 022's prod-mcm-bff compose lands; document that full-app deploy unblocks when 022 delivers `keycloak/compose.prod.yaml` + `bff/compose.prod.yaml` + `prod-realm.json`. **SC-011 note**: the docs-consistency clause is satisfied here (T024/T025); the "022's prod *app* deployment performed by the pipeline" clause is **gated on 022 co-delivery** and completes when 022's prod compose exists — not 023-complete on its own. (plan 022↔023 boundary)
- [X] T018a [US3] Author the **prod-APK build** job (ports `.github/workflows/android-apk.yml`) — on push to `main`, `pnpm nx run mcm-app:build-apk` with `APK_VARIANT=release` and `EXPO_PUBLIC_BFF_NATIVE_URL=https://mcm.${BASE_DOMAIN}` sourced from a Forgejo **variable** (not hard-coded, not an IP/`:8082`), published as a release artifact. This is the Forgejo replacement for the deleted GitHub APK build and resolves the open feature-022 **T017** question (Forgejo builds the prod APK, not GitHub Actions). **RED→GREEN**: the produced APK's baked BFF URL equals the public `https://mcm.${BASE_DOMAIN}` (not the CI emulator `10.0.2.2:8082` from T010). (FR-026, FR-009)
- [ ] T019 [US3] **RED→GREEN verification** (quickstart Scenario 3): merge green → images published by digest, Komodo redeploys, probe passes, **and the prod APK (T018a) is produced with the public host baked**; then (a) a critical-vuln image → not published, no deploy; (b) forced probe failure → rollback to prior digest; (c) unset a prod `${VAR:?}` → deploy aborts naming the variable. (US3 acceptance 1–5, SC-004, SC-005, SC-006, SC-010, FR-026)

**Checkpoint**: US1–US3 — push to `main` deploys itself to prod.

---

## Phase 6: User Story 4 — GitHub Actions is fully retired (Priority: P4)

**Goal**: Remove the cloud workflows, keep GitHub as a no-Actions push-mirror, repoint merge gating to the forge pipeline, document the rollback.

**Independent Test**: No cloud workflow remains; a push mirrors to GitHub with no Actions run; `main` protection requires the forge checks; the rollback procedure is documented.

- [X] T020 [US4] Delete `.github/workflows/*` (all five: `agent-gates.yml`, `android-apk.yml`, `android-e2e.yml`, `naming-gate.yml`, `secret-scan.yml`). Removing the files inherently disables GitHub Actions on the mirror. **Note**: `android-apk.yml`'s build capability is intentionally *ported* (release/prod APK → T010 for CI, T018a for prod) — the debug-APK-on-push trigger is deliberately not carried over, as the release/prod APK supersedes it. (FR-021) **DONE 2026-06-27**: executed once `guardrails` + `app-ci` (incl. the mobile `app-e2e` job) went green ×3 on the forge — US1/US2 validated, so no no-CI window. Rollback path remains documented (T023, `CI-Cutover-and-Rollback.md`): restore from git history.
- [ ] T021 [US4] (operator) Repoint `main` branch-protection **required status checks** in Forgejo to the `guardrails` + `app-ci` job names (not the retired GitHub checks). (FR-023)
- [ ] T022 [US4] **Verify** (quickstart Scenario 4): push to the forge → mirrors to GitHub (already-configured mirror) and starts **no** GitHub Actions run; `.github/workflows` is empty. (FR-022, SC-008)
- [X] T023 [US4] Document the cutover + rollback (restore a workflow from git history to temporarily re-enable cloud CI if the homelab runner is unavailable) in `docs/proposals/homelab-setup/` (PRD-CI or runbook). (FR-024)

**Checkpoint**: All user stories complete — homelab pipeline is the sole CI/CD.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation reconciliation (FR-028) and final validation.

- [X] T024 [P] FR-028 — reconcile `docs/proposals/homelab-setup/`: **PRD-CI.md** status → "implemented as feature 023", mark server/runner/registry/Komodo/cache DONE, change §2.6 "two-step promotion (recommended)" → single-step + digest rollback, note stages 9–12 = `cd-deploy.yml`; **Phase-11-Work-Order.md** remove "§1 HARD DEPENDENCY — Phase 15 not done", reorder CI/CD before prod deploy, B2 APK → Forgejo; **Server-Setup-Runbook.md** strip the two-step-promotion recommendation; **keycloak-prod.compose.yaml** keep host/network facts consistent (one fact, four files). (FR-028, SC-011)
- [X] T025 [P] FR-028 — reconcile feature-022 artifacts: rewrite the "Scope boundary — does NOT build CI/CD / Phase 15 hard dependency" section (spec/HANDOFF) to "deploys through 023"; resolve **T017** → Forgejo Actions builds the prod APK; shrink the coded-vs-manual table (Komodo deploy now pipeline-driven; only Cloudflare routes + real-secret seeding + the device test remain manual). (FR-027, FR-028, SC-011)
- [X] T026 Remove the temporary `smoke.yml` (T001) now that `guardrails` + `app-ci` prove the runner. (cleanup) **DONE 2026-06-27**: runner proven by repeated green `guardrails`/`app-ci` runs; no `.forgejo` references to `smoke` remain.
- [ ] T027 Run the full [quickstart.md](./quickstart.md) Scenarios 1–5 and confirm SC-001…SC-011; capture the run as the feature's acceptance evidence. **OPERATOR/RUNTIME** — not a doc edit: Scenarios 4–5 exercise the live mirror + `cd-deploy` (production), so this is run after the operator wires Komodo (T013), branch-protection (T021), and CD validation (T018/T019). The `quickstart.md` doc itself is written.
- [X] T028 [P] Update `CLAUDE.md` (Testing/CI section) to note the CI/CD now lives in `.forgejo/workflows/` on the homelab runner and GitHub Actions is retired — so the next session doesn't reach for `.github/workflows`.

---

## Phase 8: Komodo config-as-code + host-free digest + full-app prod (work order Phase 15)

**Purpose**: Finish 022 + 023 per [docs/proposals/homelab-setup/Phase-15-Work-Order.md](../../docs/proposals/homelab-setup/Phase-15-Work-Order.md) and the **plan Addendum (2026-06-29)**. Two milestones, lowest-risk leg first. Milestone A finishes the 022 + 023-spec finish line (prod-mcm-bff `deploy=true` validated → merge → GitHub retirement). Milestone B deploys the full app (data + agents) so prod can actually list/add a movie and run an agent flow. The `prod-mc-service`/`prod-movie-assistant` stacks extend 023 under clarify #2 ("CD orchestrates ALL prod stacks"), not a new feature.

### Milestone A — prod-mcm-bff finish line

- [X] T029 [US3] **R10 — host-free `.env.deploy`.** Rework `cd-deploy.yml`'s promotion step to write **bare** `*_DIGEST=sha256:…` (not `*_IMAGE=<host>/<ns>/<repo>@sha256:…`) into the tracked `infrastructure-as-code/docker/bff/.env.deploy`; var name = `<REPO_UPPER>_DIGEST` (mcm-bff → `MCM_BFF_DIGEST`). Update the generated header comments. **RED→GREEN**: after the change the committed `.env.deploy` contains **no** registry host / tailnet string (grep clean); `secret-scan` + naming gate pass. (FR-013, FR-014; plan Addendum R10; resolves the registry-host-in-git leak)
- [X] T030 [US3] **R10 (compose side) + stack rename.** Edit `bff/compose.prod.yaml`: (a) `image:` → `"${REGISTRY_HOST:?set in bff/.env.prod}/jumbleknot/mcm-bff@${MCM_BFF_DIGEST:?set in .env.deploy}"`; add `REGISTRY_HOST` to `bff/.env.prod.example`; (b) **`name: prod-app` → `name: prod-mcm-bff`** (stack rename, user 2026-06-29b). Komodo loads `--env-file .env.prod --env-file .env.deploy` (additional env file last wins). **RED→GREEN**: `docker compose -f bff/compose.prod.yaml --env-file <both> config` resolves the full image ref + project name `prod-mcm-bff`; with either var unset it aborts naming it. ⚠️ The compose `name:` does NOT itself rename the live stack — **Komodo overrides the compose project name with the Komodo Stack name** (confirmed live 2026-06-30). The actual rename is renaming the Komodo Stack (or the T036 ResourceSync creating `prod-mcm-bff`), via a down-old/up-new cutover (`docker rm -f` the three containers; external vols/nets survive). (FR-015; plan Addendum R10)
- [X] T031 [US3] **R9 — `infrastructure-as-code/komodo/stacks.toml`.** Author the `[[stack]]` blocks for the two **live** stacks first — `prod-auth`, `prod-mcm-bff` — sanitized per work order §6.2: `linked_repo = "mcm-repo"` (host lives in the Repo resource, not TOML) + `branch`, `run_directory`, `file_paths`, `env_file_path = ".env.prod"`, **additional env file `.env.deploy`**, `environment` using `[[VARIABLE]]` tokens (`BASE_DOMAIN`, `REGISTRY_HOST`, per-stack secrets), `deploy = true`, `after = []` / `after = ["prod-mc-service"]` placeholder (data lands in T033). No host/domain/IP/secret literal. **RED→GREEN**: `secret-scan`/naming gate (T032) passes on the file; a planted host string fails it. (FR-015a; plan Addendum R9)
- [X] T032 [US1] **Topology gate for `komodo/*.toml`.** Implemented as a dedicated `scripts/check-komodo-sync.mjs` (secret-scan.mjs already scans the whole tree for credential *shapes*; guardrails.yml has no `paths:` filter — every job runs every push). The new gate scans `infrastructure-as-code/komodo/**/*.toml` for a tailnet host (`*.ts.net`), a Tailscale CGNAT IP (`100.64.0.0/10`), or a hardcoded URL host (authority without a `[[var]]`), so a real host/`BASE_DOMAIN`/IP/webhook can't slip past the `[[var]]` discipline. Wired into the `naming` job (`--selftest` then scan). **RED→GREEN** (verified locally): the selftest's planted host/IP/URL are flagged; `stacks.toml`'s `[[var]]` form passes. (FR-002, FR-003; work order §8)
- [ ] T036 [US3] (operator) **B1/B2/M3 — bootstrap the ResourceSync (replaces the per-Stack UI build of T013).** (1) Register the Forgejo git provider + create the `mcm-repo` **Repo** resource (holds the tailnet host). (2) Seed masked Komodo **Variables**: `BASE_DOMAIN`, `TAILNET_HOST`, `TS_ADMIN_IP`, `REGISTRY_HOST` (= `[[TAILNET_HOST]]:3000`), and each per-stack secret (`KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD`, `mcm_keycloak_client_secret`, `mcm_keycloak_service_client_secret`, `mcm_cookie_secret`, `mcm_agent_config_enc_key`, `mcm_agent_subject_token_client_secret`, `agent_db_password`, `agent_gateway_client_secret`, `anthropic_api_key` — **`mc_db_password` is NOT needed** (prod-mc-service Mongo runs unauthenticated, internal-only). (3) Create the **`ResourceSync`** → `resource_path = infrastructure-as-code/komodo`, enable its git webhook. **`prod-auth` adopts in place** (same name). **`prod-app` is RENAMED to `prod-mcm-bff`** — ⚠️ **Komodo sets the compose PROJECT name to the Komodo *Stack* name, overriding the compose `name:` field** (confirmed live 2026-06-30: deploying the `name: prod-mcm-bff` compose under the `prod-app` Stack redeployed in place as project `prod-app`, no rename, no collision). So the rename is driven by the **Komodo Stack name**, not the compose file. The sync creates a Stack named `prod-mcm-bff`; it will NOT find an existing one to adopt, so do a clean cutover: `docker rm -f mcm-bff-service mcm-bff-cache-redis mcm-bff-store-mongo` (down the old `prod-app` project — external volumes/networks survive) **then** let the sync bring up `prod-mcm-bff`, else the new project collides with the old `container_name`-pinned containers. Brief BFF downtime is expected during the flip. (4) Record the ResourceSync webhook URL/auth into Forgejo `KOMODO_WEBHOOK_URL` var + `KOMODO_WEBHOOK_AUTH` secret. **Verify** `[[VARIABLE]]` interpolation resolves in the field you use it (certain for stack `environment`; the `linked_repo` route avoids needing it in `git_provider`). (work order §6.4; supersedes T013)
- [ ] T018 → see Milestone A validation: **deploy=true** — dispatch `cd-deploy` (API, `write:repository` token) with `deploy=true` and confirm signed webhook → Komodo redeploys prod-mcm-bff by the committed digest → health probe (issuer + `mcm.` 200) passes → induced failure git-reverts + re-fires (rollback). The **only unexercised CD leg.** (FR-016; existing T018/T019 fulfilled here)
- [ ] T021 (operator) Repoint `main` branch-protection required checks → `guardrails` + `app-ci`. *(unchanged; gates the merge)*
- [ ] T037 **Merge 022 → main** (co-fires `cd-deploy` deploy path) once T018-validation is green; confirm T022 (mirror runs **no** GitHub Actions) and run T027 quickstart Scenarios 4–5 against the live deploy. (FR-022, SC-008, SC-011 docs clause)

### Milestone B — full app (prod-mc-service + prod-movie-assistant)

- [X] T033 [US3] **R1 — `mc-service/compose.prod.yaml` (`prod-mc-service`).** `name: prod-mc-service`; `mc-service-store-mongo` (rs0, no published port), `mc-service-store-mongo-rs-init` (one-shot), `mc-service` (host-free `"${REGISTRY_HOST}/jumbleknot/mc-service@${MC_SERVICE_DIGEST}"`, internal `KEYCLOAK_URL`, no host port, `/health` busybox-wget healthcheck). External `backend-network` + `mc-service-store-mongo-data`. **DONE + validated**: `compose config` renders `…/mc-service@sha256:fe0a…` and fail-fasts on a missing `${VAR:?}`. Mongo runs **unauthenticated, internal-only** (matches the live prod-mcm-bff Mongo — work order's `MC_DB_PASSWORD` dropped). mc-service relies on prod Keycloak `BACKCHANNEL_DYNAMIC` for the public issuer (no public-URL override). Per-stack `mc-service/.env.deploy` added; cd-deploy now writes the digest block to all 3 stack dirs. (FR-015, FR-017; plan Addendum R1)
- [X] T034 [US3] **R2 — `agents/compose.prod.yaml` (`prod-movie-assistant`).** `name: prod-movie-assistant`; gateway + `movie-assistant-store-postgres` + 3 MCP servers, each host-free `"${REGISTRY_HOST}/jumbleknot/<repo>@${<REPO>_DIGEST}"`. **DONE + validated**: all 4 CI images assemble; `compose config` confirms **web-api-mcp on `movie-assistant-mcp-network` ONLY** (not backend — scoped capability), spreadsheet-mcp on `backend-network`+`mcm-bff-network` (014 Redis), gateway bridging both. `MODEL_PROVIDER=anthropic`; **no shared `ANTHROPIC_API_KEY`** (018 per-user BYO — optional env_file, typically empty); Claude model ids are **code defaults** (haiku/sonnet/opus — not set); `AGENT_GATEWAY_CLIENT_SECRET` is **fail-fast** (`${VAR:?}`, fail-closed token exchange); both MCP URLs set (else graph goes tool-free). `agents/.env.prod.example` + `agents/.env.deploy` authored. (FR-015, FR-017; plan Addendum R2)
- [X] T035 [US3] Extend `komodo/stacks.toml`. **DONE**: 4-stack `after` chain **prod-auth → prod-mc-service → prod-mcm-bff → prod-movie-assistant** (agents last — spreadsheet-mcp needs prod-mcm-bff's `mcm-bff-network`/Redis; richer than the work order's flat ordering). Added `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` to the prod-mcm-bff env (the BFF mints the run-scoped subject token the gateway re-exchanges — was empty until agents deploy). prod-realm.json **already carries** the `agent-gateway` + `agent-subject-token` token-exchange clients + audience mappers (aud=movie-collection-manager/mc-service, 60s/180s TTLs) → **work order §8 token-exchange open item RESOLVED**. OPA/Unleash/Vault/OTel are env-gated and OFF by default (not set in prod). (work order §6.3, §2 ordering)
- [ ] T038 (operator) **M1 — pre-create external nets/vols on the prod daemon** for the new stacks. **Networks**: create `movie-assistant-mcp-network`; confirm `backend-network`, `mcm-bff-network`, `edge-network`, `keycloak-network` already exist. **Volumes**: confirm `mc-service-store-mongo-data` + `movie-assistant-store-postgres-data` exist (runbook Phase 5 pre-provisioned them). `agent_db_password` must match what `movie-assistant-store-postgres-data` was first initialised with. **Also**: set `AGENT_SUBJECT_TOKEN_CLIENT_SECRET` in the prod-mcm-bff Stack Environment (was empty until agents deploy — the BFF mints the subject token) and `agent_gateway_client_secret` for prod-movie-assistant (from Keycloak admin → agent-gateway client Credentials). (work order §6.5)
- [ ] T039 **V — full-app verify + rollback drill.** After the ResourceSync deploys auth→data→app/agents in `after` order: `mc-service` `/health` green; off-network on the prod APK **create a movie and list it back** (proves `mcm-app → BFF → mc-service → mc-db`); run **one agent flow** (proves token-exchange → `movie-mcp` → `mc-service`); force one failed deploy and confirm digest rollback recovers. Completes the spec's SC-011 full-app clause. (work order §7; SC-007, SC-011)

**Checkpoint**: Milestone A = 022 + 023-spec done (prod-mcm-bff self-deploys, GitHub retired). Milestone B = the full app runs in prod and updates itself by `git push`.

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
- US3: T013 (Komodo stacks, operator) → T014 (build/scan/publish) → T015 (deploy) → T016 (probe/rollback) → T017 (gating) → T018 (co-delivery) → T018a (prod-APK build, parallel to T014–T017) → T019 (RED/GREEN).
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
