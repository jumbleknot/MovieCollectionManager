# Implementation Plan: Major dependency upgrades

**Branch**: `081-major-dependency-upgrades` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/081-major-dependency-upgrades/spec.md`; measured facts in
[research.md](research.md) (every version below is from there).

## Summary

Nine user stories, one PR each (US1, US7 and US8 split further), landed strictly in order. Six end in an
upgrade; parts of US5, US8 and US9 are expected — on today's measurements — to end in a **recorded hold**
(blocked upstream), which item #254's acceptance criterion counts as done when it carries its own backlog
item and re-check rule. The three lockfile-wholesale stories (pnpm 12, nx 23, Expo SDK 57) each start
against a quiet lock and never overlap.

| Story | PR(s) | What moves (current → target) | Expected end state |
|---|---|---|---|
| US1 | 1a, 1b | 1a: `actions/checkout` v4→v7, `actions/setup-node` v4→v7, `actions/upload-artifact` v3→v7. 1b: `actions/setup-java` v4→v6, `android-actions/setup-android` v3→v4, `astral-sh/setup-uv` v5→v10, `dorny/paths-filter` v3→v4, `pnpm/action-setup` v4→v6 | upgrade, except `upload-artifact` → likely **hold at v3** (unsupported on this forge, measured ×3; re-probed in M1). `java-jdk` 17 held → US4. |
| US2 | 2 | `pnpm` 11.25.0 → 12.x (`packageManager`, Dockerfile corepack pins) | upgrade |
| US3 | 3a, 3b | 3a: `@nxlv/python` 21→23, `@monodon/rust` 2→3 (on nx 22). 3b: `nx`/`@nx/expo`/`@nx/playwright` 22.7.10 → 23.x via `nx migrate` | upgrade |
| US4 | 4 | `expo` 56 → 57.0.x, `react-native` 0.85.3 → 0.86.3, every companion per `bundledNativeModules.json`; JDK decided; constitution 2.5.0→2.6.0 | upgrade |
| US5 | 5a, 5b, 5c | 5a: reject five override widenings + guard + Renovate rules for blocked majors. 5b: `eslint` 8→10 (flat config). 5c: `@testing-library/react-native` 13→14 | upgrade (eslint, RNTL); **hold**: jest 30 + babel-jest 30 (until SDK 58), `@babel/core`/`@babel/runtime` 8 (blocked through SDK 58), `typescript` 7 (typescript-eslint peer `<6.1.0`), async-storage 3 (bundled 2.2.0 through SDK 58) |
| US6 | 6 | `express` 4→5 + `@types/express` 4→5, `ioredis` 5→6 | upgrade |
| US7 | 7a, 7b | 7a: `@copilotkit/react-native` + `@copilotkit/runtime` 1.70.1 → latest (1.78.0 today) with `@ag-ui/client` 0.0.59 → the exact version they pin (1.0.2). 7b: `openai` 6→7; `@ai-sdk/openai` 3→4 **or removed** | upgrade / removal |
| US8 | 8a, 8b, 8c | 8a: `mongodb/mongodb-community-server` 8.0.8 → 9.0.x (bff + mc-service, local + prod), data preserved. 8b: observability `postgres` 16 → 18 for **both** langfuse-postgres and unleash-postgres. 8c: `hashicorp/vault` 1.18 scan-gated | upgrade (8a, 8b); 8c upgrade **only** if scan clean, else re-recorded hold |
| US9 | 9a, 9b | 9a: `bson` 2→3 via mongodb's `bson-3` feature. 9b: `base64` 0.22→0.23, `reqwest` 0.12→0.13 re-check | 9a upgrade; 9b **hold** while `bson`/`mongodb` need base64 0.22 and `axum-keycloak-auth` needs reqwest 0.12 |

## Technical Context

**Language/Version**: TypeScript 6.0 (stays), Node 24.19 in CI, Rust 1.98 (mc-service), Python 3.14
(agent gateway — untouched except through nx/@nxlv/python)

**Primary Dependencies**: listed per story above

**Storage**: MongoDB (movie store: replica set + keyfile auth; BFF store), PostgreSQL 16 (observability:
Langfuse + Unleash), Vault (dormant)

**Testing**: Jest (unit, mcm-app + design-system), cargo test (mc-service unit + integration), pytest
(agent), Playwright web E2E (`@gate` blocking / `@model-decision` non-blocking via `E2E_TIER`), Maestro
mobile flows, `node --test scripts/__tests__/*.test.mjs` guards

**Target Platform**: web + Android (Expo), Linux containers (local Compose + production Komodo)

**Project Type**: polyglot Nx monorepo

**Constraints**: one CI runner (`kvm`), ~35-minute `app-e2e`; Renovate window `* 2-4 * * 5`
America/New_York; Android verification needs `/dev/kvm` → Docker Desktop/DinD dev container
(`openwiki/runbooks/android-emulator.md`), not the sandbox microVM; worktree per PR, a real
`pnpm install` in it before any `pnpm nx` target (CLAUDE.md worktree gate)

**Scale/Scope**: ~30 pending majors across 9 stories, ~18 PRs

## Constitution Check

*GATE: before Phase 0; re-checked after design (bottom).*

| Principle | Status | How |
|---|---|---|
| **AI Assistant Constraints — Clarification / No Vibe Coding** | PASS | Every target version comes from research.md's measurements; stage-start measurements (M0–M9) re-check before acting. |
| **Technology Agnosticism in Specification** | PASS | spec.md names no package; every package is here and in research.md. |
| **Frontend Technology Stack (Expo SDK 56, RN 0.85, React 19.2)** | **AMENDMENT REQUIRED** | US4 changes the stated stack. A constitution MINOR amendment (2.5.0 → 2.6.0, stack guidance only, same shape as v1.4.0's 55→56) lands in the US4 PR, with explicit human approval. |
| **Backend Technology Stack (mongodb image line)** | **AMENDMENT REQUIRED** | US8a changes the document-database image the constitution names (and which is already stale: it names `8.2.6-ubuntu2204-slim`, the stacks run `8.0.8-ubi9`). Amended in US8a with human approval. |
| **Package Manager (pnpm only)** | PASS | US2 stays on pnpm; `packageManager` updated in lockstep with the Dockerfile pins. |
| **Monorepo Build Tool (Nx)** | PASS | Every test/lint/build invocation below goes through `pnpm nx`; guards are `node --test` scripts, as today. |
| **TDD (NON-NEGOTIABLE)** | PASS | New guards (override-cap, Renovate holds, shared-pin premise) are RED→GREEN. Upgrade work uses **upgrade RED**: apply the bump, record the failing count from the touched suite, migrate to GREEN. Config-only tasks use "Done when". |
| **Test Type Integrity** | PASS | Integration tiers run against real Mongo/Redis/Keycloak; no mocks introduced. |
| **Security — no secrets in git; supply-chain controls** | PASS | No override floor lowered (FR-007, SC-007); allowlist entries deleted only when discharged (FR-018); held images move only on a clean scan (FR-013). |
| **Logging & audit** | PASS | No change to what is logged; US6 verifies session-eviction audit events still fire. |

## Project Structure

### Documentation (this feature)

```text
specs/081-major-dependency-upgrades/
├── spec.md
├── plan.md              # this file
├── research.md          # the 2026-10-10 re-baseline and all measurements
├── tasks.md
└── checklists/
    └── requirements.md
```

### Source paths touched (by story)

```text
.forgejo/workflows/*.yml                       # US1
renovate.json                                  # US1 (holds), US5a (holds), US8b, US8c
scripts/check-override-consistency.mjs         # US5a (cap rule)
scripts/__tests__/renovate-workflow.guard.test.mjs, check-override-consistency.test.mjs,
  langfuse-postgres-shared-pin.guard.test.mjs  # US1, US5a, US8b
package.json, nx.json, pnpm-lock.yaml, pnpm-workspace.yaml   # US2, US3, US4, US5
frontend/mcm-app/Dockerfile                    # US2 (corepack pins)
frontend/mcm-app/package.json, app.json, metro/babel config  # US4, US5, US6, US7
packages/design-system/package.json            # US4, US5
frontend/mcm-app/.eslintrc.json → eslint.config.js, packages/design-system/ same   # US5b
frontend/mcm-app/project.json (lint command)   # US5b
frontend/mcm-app/src/bff-server/**             # US6 (express, ioredis), US7
infrastructure-as-code/docker/{bff,mc-service,observability,vault}/compose*.yaml   # US8
security/infra-images/allowlist.yaml, security/sast/allowlist.yaml   # US4, US8 (only if discharged)
backend/mc-service/Cargo.toml, Cargo.lock, src/**                  # US9
.specify/memory/constitution.md                # US4, US8a (amendments)
```

## Per-story design: tiers, rollback, exit criterion

Tiers are **derived from what each diff touches** (testing-tiers invariant), plus — for every story — the
full web E2E regression (`pnpm nx e2e mcm-app` / CI `app-e2e`), because the feature-validation checklist
requires it for every feature. Skip-escalation (`MCM_REQUIRE_LIVE_STACK=1`, `E2E_REQUIRE_AGENT_STACK=1`) is
on wherever the suite supports it, and **skip counts are read**, not just exit codes.

### Quiet-lock protocol (US2, US3, US4) — FR-003/FR-004

Before the first commit of a lockfile-wholesale story:

1. `curl -s -H "Authorization: token $MCM_FORGE_TOKEN" "$FORGE/api/v1/repos/jumbleknot/mcm/pulls?state=open"`
   → no PR whose head starts `renovate/` (record the output in the PR body).
2. Local time (America/New_York) is not Friday 02:00–04:59, and the branch will not be open across it.
3. No other 081 lockfile-wholesale PR is open.
4. The lock on `main` is the merged result of the last lock-maintenance PR (`check-lockfile-refresh`).

If a Renovate PR opens mid-stage, stop, let it merge/close, rebase, re-run.

### US1 — CI building blocks (PR 1a, 1b)

- **Prerequisite**: feature 080 merged; M1 probe run.
- **Design**: bump by SHA-pinned tag (existing convention: `uses: owner/action@<sha> # vN`). Any action the
  probe shows unsupported is held with an `allowedVersions` packageRule whose description quotes the
  measured error, asserted by `renovate-workflow.guard.test.mjs`. `java-version: '17'` is left untouched
  and a packageRule holds `java-jdk` until US4.
- **Tiers**: guardrails (all), app-ci (all jobs — the workflows ARE the change), `cd-deploy` via
  `workflow_dispatch` with `build_apk=true` and no deploy (exercises setup-java/setup-android/upload),
  `infra-image-scan`, `renovate-health`. For 1b, a commit that touches a path-filtered area so the filtered
  jobs are shown to RUN (paths-filter v4).
- **Rollback**: revert the PR (workflow files only; no state).
- **Exit**: every required context green with the new majors visible in job logs; holds recorded.

### US2 — pnpm 12

- **Design**: `packageManager: pnpm@12.x`, Dockerfile corepack pins and the `pnpm pin` Renovate group move
  together (`check-toolchain-consistency.mjs`); `pnpm install` regenerates the lock once. Every
  `pnpm-workspace.yaml` key must be recognised (`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`); every override
  re-verified (M2).
- **Tiers**: `pnpm install --frozen-lockfile` cold (CI), `pnpm nx affected -t lint test typecheck`, every
  `docker-build` (BFF image has a cold frozen install), `sast` (pnpm audit reads the new lock),
  `check-override-consistency`, app-e2e.
- **Rollback**: revert (package.json + Dockerfile + lock).
- **Exit**: green board; per-override resolution table in the PR body shows no floor change.

### US3 — nx 23 (+ plugins)

- **Design**: 3a moves `@nxlv/python` → 23 and `@monodon/rust` → 3 on nx 22 (both are devkit-22-compatible;
  today they drag devkit 20 and 21 into the lock). 3b runs `pnpm nx migrate 23.x`, applies `migrations.json`,
  keeps `nx.json` `installation.version` in lockstep.
- **Tiers**: `pnpm nx run-many -t lint test` across all projects, `pnpm nx show projects` diff before/after,
  `mc-service:test` + `test:integration` (through @monodon/rust), `movie-assistant:test` + `lint` (through
  @nxlv/python), `pnpm nx e2e mcm-app` (through @nx/playwright), `preflight`, CI `affected`.
- **Rollback**: revert; the migration is code-only.
- **Exit**: green board; project graph identical in membership and targets.

### US4 — Expo SDK 57

- **Design**: follow the `expo-upgrade` skill: `pnpm expo install expo@^57` then `pnpm expo install --fix`
  in `frontend/mcm-app`; mirror `react-native`, `react` (unchanged 19.2.3) and companions into
  `packages/design-system`; update the `@expo/dom-webview` override; `expo install --check` clean. JDK chosen
  from SDK 57's template (lift or keep the US1 hold). Constitution amendment. Renovate's Expo/RN disables stay
  (SDK moves are by `expo install`, by design — PR #252).
- **Tiers**: `mcm-app:typecheck` (count press-event errors: expected 0 — PR #217's narrowing is RN 0.87),
  `mcm-app:test`, `design-system:test`, `mcm-app:lint`, `mcm-app:bundle-budget` (web bundle), `export-server`
  + BFF prod image, `pnpm nx e2e mcm-app` (web), `mcm-app:e2e:mobile` + `e2e:agents` on the DinD dev
  container emulator, `build-apk`, `sast` (node-forge/braces entries re-checked).
- **Rollback**: revert; no data. Android installs from the previous APK.
- **Exit**: green board, mobile flows green on emulator, `expo install --check` clean, allowlist entries
  still match exactly (or deleted if discharged).

### US5 — toolchain

- **5a (no lockfile churn)**: override-cap rule in `check-override-consistency.mjs` (RED/GREEN); Renovate
  packageRules: `matchFileNames: ["pnpm-workspace.yaml"]` + `matchUpdateTypes: ["major"]` → `enabled:
  false`; `dependencyDashboardApproval: true` for `jest`, `babel-jest`, `@babel/core`, `@babel/runtime`,
  `typescript`, `@react-native-async-storage/async-storage` majors, each description carrying its re-check
  rule (FR-016); guard tests assert the resolved behaviour. Backlog items filed for each hold.
- **5b**: eslint 10 + flat config (`eslint-config-expo/flat`), drop `--ext` from the lint command. Tiers:
  `mcm-app:lint`, `design-system:lint` with zero warnings; a seeded violation proves lint still fails.
- **5c**: `@testing-library/react-native` 14 (+ `test-renderer` peer). Tiers: `mcm-app:test`,
  `design-system:test`, coverage ≥70% unchanged.
- **Rollback**: revert per PR.
- **Exit**: SC-004 — the next dashboard read shows none of the held majors in "major" branches.

### US6 — express 5 + ioredis 6

- **Design**: M6 call-site inventory first. express 5: path-to-regexp v8 route syntax, `req.query` getter,
  rejected-promise handling, removed `res.send(status)` forms. ioredis 6: client options and command return
  types used by `session-manager.ts` and `cache-service.ts`.
- **Tiers**: `mcm-app:test`, `mcm-app:test:integration` (Keycloak + Redis live; skip-escalated),
  `mcm-app:typecheck`, web E2E incl. session-timeout and concurrent-session specs, `e2e:mobile:session-timeout`,
  `dast` (BFF surface changed).
- **Rollback**: revert; Redis data is session-only (worst case: users re-login).
- **Exit**: green board; eviction/timeout specs green with zero skips.

### US7 — assistant transport

- **7a**: copilotkit (both packages) + `@ag-ui/client` in one PR, through the dashboard approval tick.
  Tiers: `mcm-app:typecheck`, `mcm-app:test`, `e2e:agents` (`@gate`), the non-blocking `@model-decision`
  tier via `workflow_dispatch` compared to `main`'s latest, golden replay (`movie-assistant:test:golden`,
  keyless), mobile agent flows (Maestro, CI).
- **7b**: M7 — if `@ai-sdk/openai` is no longer needed, remove it; else bump. `openai` 7. Tiers: the BFF
  prod-image route-load smoke, `prune-bff-runtime-modules.test.mjs`, `e2e:agents` `@gate`, model tier on
  dispatch.
- **Rollback**: revert.
- **Exit**: `@gate` green; model tier failures ⊆ `main`'s; prod image loads the agent route.

### US8 — datastore images

Each sub-PR follows ADR-0002's discipline: premise first (CI infra-image scan), explicit data decision,
rollback by tested restore.

- **8a MongoDB 9**: M8 (upgrade path / FCV, both drivers' server-9 support, scan). Procedure per store:
  backup → per-collection `countDocuments` snapshot → set FCV per upstream path → image move → counts
  re-read → FCV raise only after soak. Constitution line 253 amended. Tiers: `mc-service:test:integration`
  (replica set, cascade-delete transaction), `mcm-app:test:integration` (BFF store), backup/restore specs,
  web E2E, `infra-scan`.
- **8b observability postgres 16→18 (both)**: `pg_dumpall` both instances → move one shared pin → restore
  Unleash (and Langfuse per OQ-3) → verify. Update `langfuse-postgres-shared-pin.guard.test.mjs` premise
  ("the two move together on one pin") — RED/GREEN; lift the `<17` rule in the same change. Tiers: the guard,
  `up-observability` smoke (Langfuse UI + Unleash API health), `infra-scan`.
- **8c vault**: scan current 1.x and 2.x tags; move only on FR-013; else re-date the hold's evidence.
- **Rollback**: 8a/8b — restore from the pre-move backup onto the previous digest (rehearsed locally before
  prod). 8c — revert.
- **Exit**: SC-005 counts equal; scan green; holds updated.

### US9 — cargo

- **9a bson 3**: `mongodb` with `default-features = false, features = ["compat-3-3-0", "bson-3",
  "rustls-tls", "dns-resolver"]`, `bson = { version = "3", features = [...] }`. Upgrade RED = compile/test
  failure count after the bump. Tiers: `mc-service:test:unit`, `test:integration` (round-trip of every
  stored shape incl. keyset cursor and collation indexes), `lint` (clippy), Docker musl build, web E2E.
- **9b**: M9 re-check; if blocked, backlog items + keep dashboard approval. If unblocked: reqwest 0.13 with
  `form` feature explicitly, `cargo tree -e features --target x86_64-unknown-linux-musl` normal-graph diff
  shows no TLS change, `rust:alpine` build, integration targets **built** (they are what `mc-service-checks`
  does not build — PR #216).
- **Rollback**: revert (no data format change on disk: BSON wire format is version-independent; verified by
  round-trip tests).
- **Exit**: green board; `cargo tree -d` shows no new duplicate of reqwest/base64.

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| One spec for nine stories (ADR-0002 §5 rejected one spec for two stateful majors) | Operator decision 2026-10-10 | ADR-0002's concern is a shared CI signal; it is met by **one PR per datastore** (8a/8b/8c), each with its own premise gate and data decision. |

## Constitution re-check after design

Unchanged: the two amendments (US4, US8a) are the only constitution touches, both require human approval
in their PRs, neither redefines a principle.
