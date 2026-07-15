# Implementation Plan: Dev-Container Stack Reproducibility

**Branch**: `039-devcontainer-stack-reproducibility` | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/039-devcontainer-stack-reproducibility/spec.md`

## Summary

Close the three from-scratch reproducibility gaps found in feature 038's final in-container sign-off, each as an independent, low-risk workstream:

- **Workstream A (US1 / Gap 1)** — Seed the **dev** Keycloak `grumpyrobot` realm on a fresh `keycloak-store-postgres-data` volume by importing a committed, placeholder-only `dev-realm.json` via `--import-realm`, wired into the dev `up-auth` path (mirroring the proven CI overlay), with the realm's client secrets + a dev `E2E_TEST_PASSWORD` minted by `gen-dev-secrets.mjs` into `stacks/auth.env`.
- **Workstream B (US3 / Gap 2)** — Push each `profiles:` key down into the per-service compose files that `stacks/mcm.compose.yaml` `include:`s, deleting the top-level re-declaration block so the stack parses without include-override merge on any conformant Compose (v2.40.x apt plugin ↔ v5.x).
- **Workstream C (US2 / Gap 3)** — Refactor `.forgejo/workflows/infra-image-scan.yml` to the same always-post shape `app-ci.yml` already uses: trigger on every PR (drop the `pull_request` `paths:` filter), add an always-running `changes` (dorny/paths-filter) job, and make the Trivy work conditional on the filter — so the branch-protection-required `infra-image-scan / infra-image-scan` context is posted (success) on every PR and is the real gate when infra image refs changed.

All three are additive/mechanical and independently shippable. Recommended implementation order (cheapest-unblocker first): **C → A → B** (spec Assumptions; PRD §8 priority table). Value-priority (P1 = US1) is separate from implementation order.

## Technical Context

**Language/Version**: No application code. Artifacts are Docker Compose YAML (Compose Spec), a Keycloak realm JSON export, a Forgejo Actions workflow YAML, and Node ESM scripts (Node 24, matching the existing `scripts/*.mjs`).

**Primary Dependencies**: Docker Compose (must parse under both the v2.40.x apt plugin and v5.x); Keycloak 26.7.0 `--import-realm` (default `IGNORE_EXISTING` strategy; `${ENV}` placeholder replacement default-on since KC 26.0.0); Trivy (unchanged, keyless); `dorny/paths-filter@v3` (already used by `app-ci.yml`).

**Storage**: Existing `keycloak-store-postgres-data` external volume (the realm store); gitignored `stacks/auth.env` (per-machine secret values). No new named volume or network (resource-naming + no-new-ports gates stay green).

**Testing**: Compose `config` parse/selection checks under two Compose versions; a fresh-volume login verification script under `verify/` (mirrors feature 038's `verify/` scripts); the existing containerized web E2E as the end-to-end proof (auth→mcm→dev BFF→Playwright); the `check-*.mjs` gate self-tests; a new realm consistency check.

**Target Platform**: Local dev container + host Docker Desktop + the homelab Forgejo CI runner. Dev/CI scope only — **production realm path and prod compose stacks are out of scope and untouched**.

**Project Type**: Infrastructure / CI configuration change to an existing polyglot monorepo. No feature source directory; changes land under `infrastructure-as-code/`, `.forgejo/workflows/`, `scripts/`, `verify/`, and `docs/runbooks/`.

**Performance Goals**: N/A (no runtime hot path). Non-goal: no material slowdown to `up-auth`/`up-mcm` or to CI PR turnaround (the `changes` gate keeps non-infra PRs off Trivy).

**Constraints**: No clear-text secret may enter git (constitution §Secrets Management) — the committed `dev-realm.json` carries only `${ENV_VAR}` placeholders, exactly like `ci-realm.json`. No regression to the established-machine (persistent-volume) workflow, CI `app-e2e`/`dast`, or the prod realm path. `--profile` selection must be byte-for-byte identical before/after Workstream B. The required-context **name must map to the always-run CI job** (a conditional-only job posts nothing and re-creates Gap 3).

**Scale/Scope**: ~7 per-service compose files (Workstream B), 1 workflow file (C), 1 new realm JSON + 1 compose overlay + `gen-dev-secrets.mjs` extension + 2 verify/consistency scripts (A), plus 2 runbook updates.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **§Secrets Management (NON-NEGOTIABLE)** — PASS. `dev-realm.json` commits **only** `${ENV_VAR}` placeholders; real values are minted per-machine into gitignored `stacks/auth.env` by `gen-dev-secrets.mjs`. `secret-scan.mjs` + `check-no-inline-secrets.mjs` must stay green (FR-004, AC4) — enforced as an explicit task with a Verify step.
- **§Technology Agnosticism in Specification** — PASS. `spec.md` states capabilities only; this `plan.md` holds the mechanism (import-realm, dorny paths-filter, profile relocation).
- **§Behavior-Descriptive Identifiers** — PASS. New artifacts are named by behavior (`dev-realm.json`, `verify/verify-fresh-realm-seed.*`, `check-realm-consistency.mjs`, the compose `changes` job). Any requirement-ID reference lives in a provenance comment, not a name.
- **§Test-Driven Development (NON-NEGOTIABLE)** — ADAPTED. This feature ships no application units; its "tests" are executable verification gates (Compose parse under two versions, fresh-volume login, realm-consistency check, CI required-context behavior on one PR of each kind). `tasks.md` expresses each as a Verify-RED-then-GREEN checkpoint where ordering allows (e.g. run the fresh-volume verify script and watch it fail on `main` before the seed lands). No app E2E is added; the existing web E2E regression is the end-to-end proof per the Final Validation Checklist.
- **§Docker-Native Operations / Compose provided** — PASS/REINFORCED. Workstream B strengthens Compose portability; no service topology changes.
- **§Git Management (single root .gitignore)** — PASS. `dev-realm.json` is a committed artifact (like `ci-realm.json`); only `stacks/*.env` stay gitignored. Confirm `dev-realm.json` is not caught by an `*.env`/secret ignore pattern (research item).
- **Backend Clean Architecture / Frontend layering / Agent principles** — N/A (no app code touched).

**Result**: PASS. No violations requiring Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/039-devcontainer-stack-reproducibility/
├── plan.md              # This file
├── research.md          # Phase 0 — mechanism decisions + open validations resolved
├── data-model.md        # Phase 1 — the config "entities" (realm def, secret set, profile map, required-context)
├── quickstart.md        # Phase 1 — runnable validation scenarios (fresh-volume seed, dual-Compose parse, CI required-context)
├── contracts/           # Phase 1 — verifiable contracts
│   ├── profile-selection-invariance.md
│   ├── realm-consistency.md
│   └── ci-required-context.md
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
infrastructure-as-code/docker/
├── keycloak/
│   ├── compose.yaml            # (unchanged) dev auth base — start-dev, no import
│   ├── compose.ci.yaml         # (unchanged) CI overlay — imports ci-realm.json
│   ├── compose.dev.yaml        # NEW (Workstream A) — dev overlay: --import-realm + dev-realm.json mount + dev ${ENV} passthrough
│   ├── ci-realm.json           # (unchanged) source of truth for the client/user set
│   └── dev-realm.json          # NEW (Workstream A) — grumpyrobot realm, ${ENV_VAR} placeholders only
├── mc-service/compose.yaml     # EDIT (Workstream B) — add `profiles: [app]` to mc-service
├── bff/compose.yaml            # EDIT (Workstream B) — add bff-nonsecure/bff-secure/tls-proxy profiles
├── agent-gateway/compose.yaml  # EDIT (Workstream B) — add agents / agents-metro profiles
├── movie-mcp/compose.yaml      # EDIT (Workstream B) — add [agents]
├── web-api-mcp/compose.yaml    # EDIT (Workstream B) — add [agents]
├── spreadsheet-mcp/compose.yaml# EDIT (Workstream B) — add [agents]
├── agent-db/compose.yaml       # EDIT (Workstream B) — add [agents] (movie-assistant-store-postgres)
└── stacks/
    ├── mcm.compose.yaml        # EDIT (Workstream B) — DELETE the top-level `services:` re-declaration block
    ├── auth.env.example        # EDIT (Workstream A) — add realm client-secret + E2E_TEST_PASSWORD placeholders
    └── auth.compose.yaml       # (unchanged; dev import wired via the up-auth Nx target's second -f)

.forgejo/workflows/infra-image-scan.yml   # EDIT (Workstream C) — every-PR trigger + `changes` gate

infrastructure-as-code/project.json        # EDIT (Workstream A) — up-auth (+ composite up) add `-f keycloak/compose.dev.yaml`
scripts/
├── gen-dev-secrets.mjs         # EDIT (Workstream A) — mint realm client secrets + dev E2E_TEST_PASSWORD into auth.env
└── check-realm-consistency.mjs # NEW (Workstream A, FR-013) — assert dev-realm.json client/user set == ci-realm.json
verify/
└── verify-fresh-realm-seed.mjs # NEW (Workstream A, FR-015) — wipe volume → up-auth → assert login works (regression guard)
docs/runbooks/
├── local-dev.md                # EDIT (AC5) — one-command fresh-volume bring-up + auto-reseed stale-password note
└── devcontainer.md             # EDIT (AC5) — fresh-container bring-up path
```

**Structure Decision**: No new project. Changes are localized to `infrastructure-as-code/`, `.forgejo/workflows/`, `scripts/`, a new `verify/` script (following feature 038's `verify/` convention), and two runbooks. Feature-038's interim Compose-v5 bake in the dev-container image is retained as defense-in-depth (spec Assumption; PRD Non-Goal).

## Workstream Detail (the HOW)

### Workstream A — Dev realm seed (US1; FR-001..006, FR-013, FR-015)

**Import wiring (chosen: dedicated dev overlay — keeps the shared base + CI untouched).** `up-auth` today is `docker compose -p auth -f auth.compose.yaml --env-file auth.env up -d` (no overlay). Add a `keycloak/compose.dev.yaml` overlay (the dev twin of `compose.ci.yaml`) that appends `--import-realm` to the `keycloak-service` command and mounts `dev-realm.json` read-only to `/opt/keycloak/data/import/grumpyrobot-realm.json`, plus the dev `${ENV}` passthrough for the realm's placeholder secrets. Wire it as a **second `-f`** on the dev bring-up Nx targets (`up-auth`, the composite `up`). The shared `keycloak/compose.yaml` and the CI `compose.ci.yaml` are **not** touched → CI path provably unchanged (FR-012).

**Idempotency / non-destructive (FR-002).** Keycloak `--import-realm` uses `IGNORE_EXISTING` by default: on an established `keycloak-store-postgres-data` volume the `grumpyrobot` realm already exists → import is skipped, no disruption. On a fresh/empty volume → realm imported (FR-001). Wiping the volume (stale-password recovery) → next `up-auth` re-imports (FR-003).

**Secrets (FR-004/FR-005, constitution).** `dev-realm.json` carries only `${ENV_VAR}` placeholders (canonical names, same as `compose.ci.yaml`: `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `AGENT_SUBJECT_TOKEN_CLIENT_SECRET`, `AGENT_GATEWAY_CLIENT_SECRET`, `MC_SERVICE_CLIENT_SECRET`, `E2E_ROPC_CLIENT_SECRET`, `E2E_TEST_PASSWORD`). Extend `gen-dev-secrets.mjs` so `auth.env.example` gains these placeholders and they mint into gitignored `auth.env`; the dev overlay reads them via `env_file`/`--env-file`, Keycloak resolves them at import. Fail-fast `${VAR:?}` so a missing value aborts loudly rather than importing a broken realm (spec Edge Case). **Dev BFF secret consistency (research R-A2):** the dev BFF/mc-service must be configured with the SAME values the realm imported — decide + document the single source so realm-secret == client-secret by construction, as CI achieves via shared Forgejo secrets.

**Consistency guard (FR-013).** `ci-realm.json` is realm `grumpyrobot` with clients {movie-collection-manager, mcm-bff-service, mc-service, mcm-bff-test, agent-gateway, agent-subject-token} + default KC clients and user `e2e-test-user`. `dev-realm.json` is derived from it (same client/user set; dev redirect URIs/issuer already `localhost:8099`). `check-realm-consistency.mjs` asserts the client-id set + `e2e-test-user` presence match, failing on drift (research R-A3 decides CI placement — guardrails).

**Regression guard (FR-015).** `verify/verify-fresh-realm-seed.mjs`: remove + recreate `keycloak-store-postgres-data` → `gen-dev-secrets` → `up-auth --wait` → assert a headless PKCE login succeeds (reuse the DAST/BFF headless-login helper). Mirrors feature 038's `verify/` scripts.

### Workstream B — Portable compose profiles (US3; FR-010, FR-011)

Move each `profiles:` assignment from the `stacks/mcm.compose.yaml` top-level `services:` block **into the service's own included compose file** (mc-service→`[app]`; bff nonsecure/secure + tls-proxy→their profiles; the 5 agent services→`[agents]`/`[agents-metro]`), then **delete the top-level `services:` block** so no include-override merge remains. Profile-less default-infra services (mongo/rs-init/redis/bff-store-mongo) are untouched. **Audit (FR-011 guard):** grep confirms only `stacks/*.compose.yaml` reference the per-service files (via `include:`); `nx deploy`/`build` targets are cargo/docker-build, not `compose up` of a per-service file. Validate with the profile-selection-invariance contract (AC3): `docker compose … --profile <p> config` selects an identical service set before/after, under both Compose versions.

### Workstream C — Always-post infra-image-scan required context (US2; FR-007..009)

Mirror `app-ci.yml`'s proven shape:
1. **Drop the `pull_request:` `paths:` filter** → the workflow triggers on every PR (keep `schedule` weekly + `push`).
2. **Add an always-running `changes` job** (`dorny/paths-filter@v3`) exposing `infra` = touched-infra-image-refs boolean (the current `paths:` list).
3. **Keep a single job whose name is the required context** (`infra-image-scan`) that **always runs** (no job-level `if`); gate the Trivy install/scan/gate **steps** on `needs.changes.outputs.infra == 'true'`. Infra unchanged → job runs, Trivy steps skip, job succeeds → posts `infra-image-scan / infra-image-scan = success`. Infra changed → Trivy runs, gate can fail the job (blocks on fixable-Critical, FR-009).

**Rationale for step-level gating over a job-level `if` (research R-C1):** the PRD's explicit subtlety — a conditional-only (skipped) job "posts nothing and re-creates Gap 3" in this Forgejo config — so the required-named job must be **always-run**, gating the *steps* not the *job*; more robust than relying on skipped→success. Branch protection keeps requiring `infra-image-scan / infra-image-scan*` unchanged. AC6 verifies on one docs-only PR (success, merges no-override) and one infra-touching PR (full scan, blocks on fixable-Critical).

## Phase 0 & 1 Outputs

- **research.md** — resolves the open validations (R-A1 compose overlay merge + relative-path resolution for the dev import; R-A2 dev BFF secret source-of-truth; R-A3 realm-consistency CI placement; R-B1 profile-relocation consumer audit; R-C1 always-run-job vs skipped-job status semantics; R-G1 gitignore check for `dev-realm.json`).
- **data-model.md** — the config entities and their invariants.
- **contracts/** — three verifiable contracts (profile-selection invariance, realm client-set consistency, CI required-context behavior).
- **quickstart.md** — the three runnable validation scenarios mapping to AC1/AC2/AC3/AC5/AC6/SC-007.

## Complexity Tracking

No constitution violations; no entries required.
