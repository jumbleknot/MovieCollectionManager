# Implementation Plan: Self-Hosted Forgejo Actions CI/CD (GitHub Actions Retirement)

**Branch**: `023-forgejo-cicd` | **Date**: 2026-06-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/023-forgejo-cicd/spec.md`

## Summary

Author the homelab CI/CD as config-as-code and retire GitHub Actions. Port the five existing GitHub workflows to **Forgejo Actions** under `.forgejo/workflows/`, add the missing CD half (build → Trivy scan → push to the Forgejo OCI registry by tag **and** digest → Komodo redeploys all prod stacks → post-deploy health probe → digest rollback), wire the **self-hosted Nx remote cache** client, commit a throwaway **`ci-realm.json`** so CI provisions its own environment, and cut GitHub down to a push-mirror that runs no Actions. The homelab foundation (runner, registry, Komodo + prod daemon, Nx cache server, KVM) already exists — this feature only authors the workflows, the Komodo deploy wiring, the CI realm/secret provisioning, the `nx.json` cache client config, and the documentation reconciliation. Feature 022's production config artifacts are deployed *through* this pipeline; 023 + 022 co-deliver the first real prod deploy.

The clarified shape (Session 2026-06-23): **single-step deploy** straight to prod (probe + digest rollback is the safety net, no staging), the pipeline **orchestrates all prod stacks** (CI-built app images by run-digest + upstream-image auth/data stacks by pinned digest), the **forge→GitHub push-mirror already exists**, and CD **fires automatically on green CI on `main`** with no approval gate.

## Technical Context

**Language/Version**: YAML (Forgejo Actions, GitHub-Actions-compatible schema) + Node ≥ 24.14.1 scripts (existing gate scripts, `gen-dev-secrets.mjs`, `build-apk.mjs`); the workflows orchestrate the existing polyglot build (Rust 1.x / Node / Python 3.13 via uv), all invoked through `pnpm nx`.

**Primary Dependencies**: Forgejo Actions `act_runner` v12 (Docker backend); Forgejo built-in OCI registry; Komodo v2 (Core + Periphery on the prod rootless daemon, FerretDB-backed); self-hosted Nx remote cache server (Nx ≥ 20.8 OpenAPI, MinIO-backed); Trivy (image scan); `reactivecircus/android-emulator-runner` (KVM emulator); Maestro; Playwright. No new application dependency.

**Storage**: N/A (no application data). Config artifacts only: committed workflows, `ci-realm.json` (throwaway CI realm), `*.env.prod.example` templates (placeholders), and the prod compose files consumed from feature 022.

**Testing**: The pipeline *is* the test surface. Adapted-TDD per the constitution (see Constitution Check): the RED/GREEN gates are (a) the secret/naming/agent gate scripts run on the homelab runner, (b) `docker compose ... config` fail-fast on missing `${VAR:?}`, (c) Trivy non-zero on criticals, (d) the existing web Playwright + Maestro agent suites green on the runner, (e) the post-deploy health probe. Regression bar: the web E2E dev-container suite and the four mobile agent flows must pass on the runner exactly as they do on GitHub Actions today.

**Target Platform**: Headless Ubuntu homelab server — two rootless Docker daemons (`ci` build/test, `prod` hosting), reached over Tailscale; public ingress via Cloudflare Tunnel exposing only `mcm.${BASE_DOMAIN}` / `auth.${BASE_DOMAIN}`.

**Project Type**: CI/CD + infrastructure-as-code. No new app source tree; deliverables are `.forgejo/workflows/*`, a committed CI realm export, Komodo/registry wiring config + docs, `nx.json` cache-client keys, and reconciled proposal/022 documentation.

**Performance Goals**: Warm runs start against a resident backend/agent stack; `nx affected` + remote cache skip unaffected projects. No latency SLO beyond "CI completes and the deploy converges"; the android-e2e job budget is the existing 75-min ceiling.

**Constraints**:
- **No clear-text secrets in git — ever** (constitution §Secrets Management). CI secrets live in **Forgejo Actions secrets/vars**; prod secrets live in **Komodo/Vault**; `ci-realm.json` carries only throwaway CI values. The two secret gates + the naming gate must stay green for every file this feature adds.
- **No committed infra-topology literals.** The tailnet host, registry host/namespace, and Komodo webhook are referenced through Forgejo Actions `vars`/`secrets`, never hardcoded in a committed workflow — consistent with the `${BASE_DOMAIN}` parameterization rule (the real domain/hostnames are injected, never committed).
- **Promote by digest** — prod runs the exact image built/tested in the same run; never rebuilt for prod.
- **ci/prod daemon isolation** — build/test and production stay on separate rootless daemons, networks, and volumes.
- **Fail closed** — absent/errored CI ⇒ no merge gate passes, no deploy.
- TLS terminates at the Cloudflare edge; cloudflared → container is plain HTTP on `edge-network` (the one documented constitution deviation, inherited from feature 022 — not re-introduced here).

**Scale/Scope**: 5 ported guardrail/CI workflows + 1 new CD workflow; 6 buildable service images (`mc-service`, `mcm-bff`, `agent-gateway`, `movie-mcp`, `web-api-mcp`, `spreadsheet-mcp`); ~4 prod Komodo Stacks (auth, mcm app, + the upstream data stores); single prod environment; one deploy branch (`main`).

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| **Secrets Management (NON-NEGOTIABLE)** | ✅ PASS | All credentials via Forgejo Actions secrets (CI) / Komodo-Vault (prod); `ci-realm.json` = throwaway only; fail-fast `${VAR:?}` preserved; both secret gates + naming gate kept green and now run on the homelab runner. No infra-topology literals committed. |
| **Nx as primary test/build invocation** | ✅ PASS | Every build/test/lint step invokes `pnpm nx …` (ports preserve this; CD builds via the `nx build`/`docker-build` targets, not raw `docker build`). |
| **Test-First / TDD (mandatory)** | ⚠️ ADAPTED | CI/CD config has no unit-test harness in the app sense. Same adaptation feature 022 used and the constitution's spirit allows for config-as-code: the **gates are the RED/GREEN checks** — a workflow/compose change is proven by the gate scripts, `compose config`, Trivy, the ported E2E suites, and the health probe failing before and passing after. Tracked in Complexity Tracking. |
| **No Vibe Coding / spec-plan separation** | ✅ PASS | spec.md stays WHAT; this plan holds HOW (Forgejo/Komodo/Trivy/Nx-cache). |
| **Behavior-Descriptive Identifiers** | ✅ PASS | Workflow files named by behavior (`guardrails`, `app-ci`, `cd-deploy`), not by FR/US ids; requirement ids go in YAML comments for traceability. |
| **Centralized Access Control / Auth principles** | ➖ N/A | No application handlers added; auth posture is unchanged (022 owns prod auth config). |
| **Observability (app logging)** | ➖ N/A (CI) | Pipeline diagnostics (artifact upload, container-log dump) carried over; not the app observability principle. |
| **TLS edge-termination deviation** | ✅ INHERITED | Documented in 022's Complexity Tracking; 023 deploys those stacks but introduces no new deviation. |

**Gate result**: PASS with one tracked, justified adaptation (TDD-for-config). No unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/023-forgejo-cicd/
├── plan.md              # This file
├── research.md          # Phase 0 — resolves the unknowns below
├── data-model.md        # Phase 1 — config-artifact & promotion model
├── quickstart.md        # Phase 1 — validation runbook (push→gates, merge→deploy, force rollback)
├── contracts/           # Phase 1 — CI↔CD, secrets, trigger-matrix, Komodo-webhook contracts
│   ├── workflow-trigger-matrix.md
│   ├── image-and-digest-promotion.md
│   ├── secrets-and-variables.md
│   └── komodo-deploy-and-rollback.md
├── checklists/
│   └── requirements.md  # created by /speckit-specify
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
.forgejo/
└── workflows/
    ├── guardrails.yml        # US1 — ports naming-gate + secret-scan + agent-gates (fast, keyless)
    ├── app-ci.yml            # US2 — ports android-e2e (web Playwright + Maestro agent flows + APK) and folds in nx-affected lint/build/unit
    └── cd-deploy.yml         # US3 — main-only: build 6 images → Trivy → push (tag+digest) → Komodo redeploy → health probe → rollback

infrastructure-as-code/docker/
├── keycloak/
│   ├── ci-realm.json         # NEW (023) — throwaway CI realm export (realm+clients+test user+throwaway secrets) for reproducible CI env
│   ├── compose.prod.yaml     # FROM 022 (consumed by cd-deploy) — prod-auth Komodo Stack
│   └── prod-realm.json       # FROM 022 (consumed) — sanitized prod realm
├── bff/compose.prod.yaml     # FROM 022 (consumed) — prod-mcm-bff Komodo Stack
└── stacks/*.env.example      # existing dev templates (unchanged); CI runs gen-dev-secrets.mjs to mint *.env

nx.json                       # EDIT — wire self-hosted remote-cache client (env-driven token/server)

.github/workflows/            # DELETED (US4) — agent-gates, android-apk, android-e2e, naming-gate, secret-scan

docs/proposals/homelab-setup/ # RECONCILED (FR-028) — PRD-CI.md, Phase-11-Work-Order.md, Server-Setup-Runbook.md, keycloak-prod.compose.yaml
specs/022-prod-public-hostname-auth/  # RECONCILED (FR-028) — scope-boundary, T017 resolution, coded-vs-manual table
```

**Structure Decision**: No application source changes. The feature adds `.forgejo/workflows/` (the new CI/CD surface), one committed CI realm export, and an `nx.json` edit; it consumes feature 022's prod compose/realm artifacts at deploy time; and it removes `.github/workflows/`. Documentation reconciliation spans the four homelab-setup files and the feature-022 artifacts. Workflow files are named by behavior per the constitution.

### 022 ↔ 023 delivery boundary (load-bearing)

- **023 owns**: the three Forgejo workflows, `ci-realm.json`, the Komodo deploy wiring/contracts, the `nx.json` cache client, the GitHub retirement, and the doc reconciliation.
- **022 owns**: the prod compose files (`keycloak/compose.prod.yaml`, `bff/compose.prod.yaml`), `prod-realm.json`, the BFF public-origin env, redirect URIs, the prod-APK baked URL, and the `edge-network` naming-gate edit.
- **Co-delivery**: 023's US3 end-to-end (deploy the *app* to the public hosts) requires 022's prod compose to exist. To keep US3 independently demonstrable before that, US3 is first validated by deploying the **upstream Keycloak prod stack** (no app build needed) to prove the Komodo digest-deploy + health-probe + rollback path, then the full app stacks deploy once 022's compose lands. This is the concrete meaning of "build the pipeline first, then deploy 022 through it."

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| **TDD adapted to "gates as RED/GREEN" for config-as-code** | Workflows, compose files, and a realm export have no app-style unit-test harness; correctness is proven by the gate scripts, `compose config`, Trivy, the ported E2E suites, and the health probe. | A literal "write a failing unit test first" is not meaningful for a YAML workflow or a Komodo Stack; the gate/probe checks are the executable, falsifiable equivalent and are run RED-then-GREEN per checkpoint (same approach approved for feature 022). |
| **CD deploys upstream-image stacks too (not only built images)** | The clarified CD scope orchestrates *all* prod stacks so 022's Keycloak deploys through the pipeline; upstream images promote by their pinned digest, not a run-built digest. | Deploying only CI-built images would leave the auth/data stacks hand-managed, re-creating the "production partly hand-deployed" problem this feature exists to remove. |

## Addendum (2026-06-29) — Komodo config-as-code + host-free digest + full-app prod

Supersedes the T013 "define Stacks in the Komodo UI" approach. Source of truth:
[docs/proposals/homelab-setup/Phase-15-Work-Order.md](../../docs/proposals/homelab-setup/Phase-15-Work-Order.md).
Validated against the repo this session — the deltas below are folded into tasks.md as **Phase 8**.

**Stack renames (user, 2026-06-29b):** `prod-app → prod-mcm-bff`, `prod-data → prod-mc-service`, `prod-agents → prod-movie-assistant` (`prod-auth` unchanged — names map each stack to its primary service). This doc and tasks.md use the new names. `prod-mcm-bff` is a rename of the **already-live** `prod-app` stack: the compose `name:` flips in T030, but the live cutover (down old project / up new) happens at T036 because the running containers hold explicit `container_name`s and a re-sync under the new project name would collide. The legacy 023 artifacts (contracts/, data-model.md, research.md) still reference the old names and are reconciled when the composes are authored.

**What changed vs. the original plan**

1. **Komodo Stacks become config-as-code (work order R9, §6).** Instead of hand-creating each Stack
   in the Komodo SPA, the four prod stacks (`prod-auth`, `prod-mc-service`, `prod-mcm-bff`, `prod-movie-assistant`) are
   declared as TOML in `infrastructure-as-code/komodo/stacks.toml` and applied by a Komodo
   **ResourceSync** (`deploy = true` + `after =` ordering → diff-apply *and* deploy in dependency
   order). Click-ops collapses to a one-time bootstrap (register git provider + `mcm-repo` Repo +
   seed masked Variables + create the ResourceSync). After that, every deploy is a `git push` →
   signed webhook → reconcile. **T013 is reworked from "define Stacks" → "bootstrap the ResourceSync".**

2. **`.env.deploy` goes host-free (work order R10).** The currently-committed
   `infrastructure-as-code/docker/bff/.env.deploy` carries the full registry host
   (`<tailnet-host>:3000/jumbleknot/<svc>@sha256:…`) in every `*_IMAGE` line — an **infra-topology
   literal in git**, against this feature's own scrub rule (HANDOFF "domain is parameterized"). Fix:
   `cd-deploy.yml` writes **bare** `*_DIGEST=sha256:…`; each prod compose assembles
   `image: ${REGISTRY_HOST}/jumbleknot/<svc>@${<SVC>_DIGEST}` with `REGISTRY_HOST` injected from the
   gitignored `.env.prod` (Komodo Variable). Host out of git, digests in git, CI rewrites the digests.
   The `secret-scan`/naming gate is extended to scan `komodo/*.toml` so a host/domain/IP can't slip in.

3. **Full deployable surface (work order R1/R2).** Prod is only `prod-auth` + `prod-mcm-bff` (BFF) today —
   it can authenticate but cannot list/add a movie (no `mc-service`/`mc-db`, no agents). Two new prod
   composes complete the app: **`mc-service/compose.prod.yaml`** (`prod-mc-service` = mongo replica-set +
   rs-init + mc-service) and **`agents/compose.prod.yaml`** (`prod-movie-assistant` = gateway + agent-db
   postgres + movie-mcp + web-api-mcp + spreadsheet-mcp). Both consume host-free digests; both use
   pre-created `external: true` nets/vols on the prod daemon.

**Corrections to the work order (verified in-repo this session)**

- The six `.env.deploy` digests are **all container images** (`mc-service`, `mcm-bff`,
  `agent-gateway`, `movie-mcp`, `web-api-mcp`, `spreadsheet-mcp`) — the work order's guess that the
  6th is "the prod APK/web build" is wrong; the prod APK is a separate CI **artifact**, never in
  `.env.deploy`. This resolves the work order's "map each `*_DIGEST` to its stack" open item.
- `prod-mc-service` carries **no Redis** — Redis (`mcm-bff-cache-redis`) already lives in `prod-mcm-bff`. The
  work order's "(+ `mcm-redis`)" on `prod-mc-service` is dropped.
- `prod-mcm-bff` BFF compose already exists and already wires `MC_SERVICE_URL`/`AGENT_GATEWAY_URL` over
  the internal nets — R3 is a small edit (host-free image ref + `REGISTRY_HOST`), not a rewrite.

**Sequencing (decided 2026-06-29) — two milestones, lowest-risk leg first**

- **Milestone A — prod-mcm-bff finish line:** adopt R10 (host-free digest) + R9 for the two *live* stacks
  (`prod-auth`/`prod-mcm-bff`), bootstrap the ResourceSync (adopts the existing stacks), validate the
  unexercised `deploy=true` leg (signed webhook → Komodo redeploy → health probe → induced rollback),
  then **merge 022 → main** (auto-fires the deploy path) + US4 closeout (T021/T022) + quickstart
  (T027). This is the 022 + 023-spec finish line.
- **Milestone B — full app:** author `prod-mc-service` + `prod-movie-assistant` composes, extend `stacks.toml` with
  their `[[stack]]` blocks (`after` ordering auth→data→app/agents), wire prod-realm RFC 8693 token
  exchange, deploy, and verify the real user path (create-a-movie off-network on the prod APK + one
  agent flow) + a rollback drill.

**Scope note:** Milestone B's `prod-mc-service`/`prod-movie-assistant` stacks extend 023 under its own clarify #2
("CD orchestrates ALL prod stacks") — they are not a new feature. New FR coverage is tracked by the
Phase 8 tasks; the spec's SC-011 full-app clause completes at Milestone B's verify.
