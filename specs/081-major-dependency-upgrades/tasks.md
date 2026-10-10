# Tasks: Major dependency upgrades (feature 081)

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)

**Total**: 70 tasks (T001–T070) across 9 user stories, ~18 PRs.

**Format**: `- [ ] T### [P?] [US#] Description`. Test tasks follow
`docs/templates/feature-test-tasks-template.md`: **Verify RED** before implementing, **Verify GREEN**
after. Two RED kinds are used here:

- **Guard RED** — a new/changed assertion in a `scripts/__tests__/*.test.mjs` guard or a `--selftest`, run
  before the config it guards exists.
- **Upgrade RED** — the version bump is applied FIRST, and the touched suite's failing count is recorded
  as the RED; the migration then takes it to GREEN. An upgrade whose touched suite shows **0 failures**
  on the bump records that fact explicitly ("bump was clean") — it is not silently treated as a RED.

Config/procedure tasks use **Done when**.

**Instrument rules that apply to every task** (CLAUDE.md): `node --test <file>` — put node flags BEFORE the
path, never `--test-name-pattern` after it; read SKIP counts, not exit codes; a fresh worktree needs
`CI=true pnpm install --frozen-lockfile` before any `pnpm nx` target; re-run with `--skip-nx-cache` before
diagnosing an nx failure from a path that no longer exists.

---

## Phase 1: Setup (per PR)

- [ ] T001 Per-PR worktree: `git -C /workspaces/mcm fetch origin && git -C /workspaces/mcm worktree add -b
  081-<story>-<slug> /home/coder/worktrees/081-<slug> origin/main`, then `CI=true pnpm install
  --frozen-lockfile` inside it. Push the branch (`git push origin HEAD:<branch>`, never AGit) before anything
  risky. **Done when**: `pnpm nx show projects` runs in the worktree.
- [ ] T002 Quiet-lock check (used by US2/US3/US4 — plan.md "Quiet-lock protocol"). **Done when**: the PR
  body records the `pulls?state=open` output with zero `renovate/*` heads, the local America/New_York time,
  and that no other 081 lockfile-wholesale PR is open.

## Phase 2: Foundational

- [ ] T003 Re-read the dashboard (`node scripts/backlog.mjs show 29`, read-only) at the START of each story
  and diff it against research.md R1; append any drift to research.md under "Re-baseline deltas" in that
  story's PR. **Done when**: the story's PR names every pending major it owns as of that day.

**Checkpoint**: proceed story by story, strictly in order (FR-001).

---

## Phase 3: US1 — CI building blocks (P1) — PRs 1a, 1b

**Prerequisite**: feature 080 merged (FR-002).

- [ ] T004 [US1] M1 runner probe: on a throwaway branch add `.forgejo/workflows/probe-081.yml` with one job
  on `ubuntu-latest` and one on `kvm`, each running `actions/checkout@v7`, `actions/setup-node@v7`,
  `actions/upload-artifact@v7` (SHA-pinned). Delete the branch afterwards; never merge it. **Done when**:
  research.md records, per label, whether each action ran — quoted from the job LOG (e.g.
  `GHESNotSupportedError`), not from the tick.
- [ ] T005 [US1] Guard RED — in `scripts/__tests__/renovate-workflow.guard.test.mjs`, assert (a) `java-jdk`
  resolves to a held rule (no major) until US4, and (b) for every action T004 found unsupported, that
  action's resolved `allowedVersions` excludes the unsupported major.
  **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
  **Expected RED**: the new assertions fail — no such rule exists in `renovate.json`.
- [ ] T006 [US1] Implement the holds in `renovate.json` (packageRules ordered after the `ci actions` group so
  the hold wins), each description quoting T004's measured error and the release condition.
  **Verify GREEN**: same command as T005 | **Expected GREEN**: 0 failures, prior tests still pass.
- [ ] T007 [US1] PR 1a: bump `actions/checkout` v4→v7, `actions/setup-node` v4→v7, and `actions/upload-artifact`
  (to v7 only if T004 showed support) at every site in `.forgejo/workflows/*.yml` (22 / 12 / 7 sites), SHA +
  `# vN` comment convention. **Done when**: `pnpm nx preflight infrastructure-as-code` passes.
- [ ] T008 [US1] Verify PR 1a: all required contexts green; `cd-deploy` `workflow_dispatch` with
  `build_apk=true` and no deploy green; `infra-image-scan`, `renovate-health` green; job logs show the new
  majors executed. **Done when**: PR 1a merged with that evidence in its body.
- [ ] T009 [US1] PR 1b: bump `actions/setup-java` v4→v6 (keep `java-version: '17'`), `android-actions/setup-android`
  v3→v4, `astral-sh/setup-uv` v5→v10, `dorny/paths-filter` v3→v4, `pnpm/action-setup` v4→v6. **Done when**:
  preflight passes.
- [ ] T010 [US1] Verify PR 1b, including a commit that touches a path-filtered area so each filtered job is
  shown to RUN, not skip (paths-filter v4 output semantics); `cd-deploy` `build_apk` dispatch green.
  **Done when**: PR 1b merged; rollback = revert recorded in the body.

---

## Phase 4: US2 — pnpm 12 (P1) — PR 2 — lockfile-wholesale

- [ ] T011 [US2] T002 quiet-lock check. Record the BEFORE table: for each of the 14 `overrides` keys in
  `pnpm-workspace.yaml`, the resolved version(s) in `pnpm-lock.yaml`. **Done when**: table in PR body.
- [ ] T012 [US2] Guard check — `node --test scripts/__tests__/check-toolchain-consistency.test.mjs` passes
  before the change (control), then bump `packageManager` to `pnpm@12.x` in `package.json` and the corepack
  pins in `frontend/mcm-app/Dockerfile` together.
  **Verify RED (upgrade)**: `pnpm install` under 12 — record any `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`
  or ignored-key warning verbatim.
- [ ] T013 [US2] Migrate any unrecognised `pnpm-workspace.yaml` key (never delete an override or a build
  decision); regenerate the lock once.
  **Verify GREEN**: `pnpm install --frozen-lockfile` cold succeeds with no warnings about ignored keys;
  `node scripts/check-override-consistency.mjs` exits 0; `node scripts/check-toolchain-consistency.mjs`
  exits 0.
- [ ] T014 [US2] AFTER table: every overridden package resolves within its patched range (no floor moved
  down). `pnpm nx run-many -t docker-build` (every image does a cold frozen install), `pnpm nx sast
  infrastructure-as-code`. **Done when**: PR 2 merged with before/after tables and green board.

---

## Phase 5: US3 — nx 23 + plugins (P1) — PRs 3a, 3b — lockfile-wholesale

- [ ] T015 [US3] PR 3a: T002 check; bump `@nxlv/python` ^21 → ^23 and `@monodon/rust` ^2 → ^3 in root
  `package.json` (nx stays 22).
  **Verify RED (upgrade)**: `pnpm nx run-many -t test lint -p mc-service movie-assistant --skip-nx-cache`
  — record failures (or "bump was clean").
- [ ] T016 [US3] Fix executor/option changes until GREEN.
  **Verify GREEN**: same command | **Expected GREEN**: 0 failures; `pnpm why @nx/devkit` shows the 20.x and
  21.x copies gone. **Done when**: PR 3a merged.
- [ ] T017 [US3] PR 3b: T002 check; record `pnpm nx show projects --json` and each project's target list
  (BEFORE). Run `pnpm nx migrate 23.x` (latest 23 at that day), `pnpm install`, `pnpm nx migrate
  --run-migrations`; keep `nx.json` `installation.version` == `package.json` `nx`.
  **Verify RED (upgrade)**: `pnpm nx run-many -t lint test typecheck --skip-nx-cache` — record failures.
- [ ] T018 [US3] Resolve until GREEN; M3: confirm `@monodon/rust` 3 (devkit ^22) executors load under nx 23
  (`pnpm nx run mc-service:test`). If they do not, stop and record (spec US3 AC3).
  **Verify GREEN**: same command, 0 failures; `node scripts/check-toolchain-consistency.mjs` exits 0;
  AFTER project/target list identical to BEFORE.
- [ ] T019 [US3] Verify PR 3b: `pnpm nx e2e mcm-app` (via @nx/playwright), `pnpm nx preflight
  infrastructure-as-code`, CI `affected` selects the expected projects. **Done when**: PR 3b merged.

---

## Phase 6: US4 — Expo SDK 56 → 57, RN 0.85.3 → 0.86.3 (P1) — PR 4 — lockfile-wholesale

Run in the **Docker Desktop/DinD** dev container (needs `/dev/kvm` for the emulator).

- [ ] T020 [US4] M4: re-read `expo` dist-tags and the jest-expo / babel-preset-expo / eslint-config-expo
  companion metadata (item #254 correction recipe); re-extract `bundledNativeModules.json` from the
  `expo-57.0.x` tarball. If SDK 58 is stable, STOP and ask the operator (OQ-1). **Done when**: research.md
  R4 updated with the day's numbers.
- [ ] T021 [US4] T002 quiet-lock check.
- [ ] T022 [US4] Draft the constitution amendment in `.specify/memory/constitution.md` (2.5.0 → 2.6.0, the
  Expo SDK line at §Frontend App Technology Stack and the version history). **Done when**: drafted and flagged
  in the PR for explicit human approval; not merged without it (FR-015).
- [ ] T023 [US4] Upgrade in `frontend/mcm-app`: `pnpm expo install expo@^57.0.0` then `pnpm expo install
  --fix`; mirror `react-native` (0.86.3) and companions into `packages/design-system/package.json`; move the
  `@expo/dom-webview` override in `pnpm-workspace.yaml` to `^57`; run `pnpm expo install --check`.
  **Done when**: `--check` reports no mismatches and `@react-native-async-storage/async-storage` stays 2.2.0.
- [ ] T024 [US4] Typecheck — **Verify RED (upgrade)**: `pnpm nx typecheck mcm-app --skip-nx-cache` — record
  the error count and how many are the PR #217 press-event narrowing (`GestureResponderEvent` vs Tamagui
  `PressableProps['onPress']`; expected 0 on RN 0.86).
- [ ] T025 [US4] Fix typecheck errors. **Verify GREEN**: same command, 0 errors.
- [ ] T026 [US4] Unit tiers — **Verify RED (upgrade)**: `pnpm nx run-many -t test -p mcm-app design-system
  --skip-nx-cache` — record failures; fix (jest-expo 57 preset, RN 0.86 mocks).
  **Verify GREEN**: same command, 0 failures, coverage ≥70% on mcm-app.
- [ ] T027 [US4] JDK decision: read SDK 57's Android template (Gradle/AGP JDK requirement). Guard RED: update
  the T005 `java-jdk` assertion to the decided state (held at 17 with the SDK-57 reason, OR moved).
  **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` fails on the changed
  assertion. Implement in `renovate.json` (+ `java-version` in workflows if moving). **Verify GREEN**: same.
- [ ] T028 [US4] Android: `pnpm nx build-apk mcm-app`, then `pnpm nx e2e:mobile mcm-app` and
  `pnpm nx e2e:agents mcm-app` on the local KVM emulator. **Done when**: all flows pass; any flake re-run
  shown to be pre-existing against `main` (baseline per pull-request-batching).
- [ ] T029 [US4] Web: `pnpm nx export-server mcm-app`, BFF prod image build, `pnpm nx bundle-budget mcm-app`,
  `pnpm nx e2e mcm-app`. **Done when**: green with zero skipped suites.
- [ ] T030 [US4] SAST re-check: `pnpm nx sast infrastructure-as-code`. **Done when**: the node-forge
  (`^node-forge@1\.4\.0$`) and braces (`^braces@3\.0\.3$`) allowlist entries still match exactly, or — if
  discharged — are deleted in this PR (FR-018). Expected per R4: neither discharged.
- [ ] T031 [US4] PR 4 with rollback (revert; previous APK) and exit criterion (plan.md US4). **Done when**:
  merged with human approval of T022.

---

## Phase 7: US5 — toolchain (P2) — PRs 5a, 5b, 5c

- [ ] T032 [US5] SC-003: re-derive US5 scope from the companion metadata of the SDK US4 landed, plus M5
  (`@typescript-eslint/parser` latest's `typescript` peer). **Done when**: research.md R4/R5 updated; any
  majors that became free move into 5b/5c.

**PR 5a — overrides + holds (no lockfile churn)**

- [ ] T033 [P] [US5] Guard RED — in `scripts/__tests__/check-override-consistency.test.mjs` add cases: a keyed
  override whose value cap admits a major above the key's (`undici@<6.27.0: '>=6.27.0 <9'`) FAILS; the
  current `'>=6.27.0 <7'` passes; a plain pin (`react-dom`) is out of scope; extend `--selftest` likewise.
  **Verify RED**: `node --test scripts/__tests__/check-override-consistency.test.mjs`
  **Expected RED**: the widening case is not rejected (the gate checks only floor/key agreement today).
- [ ] T034 [US5] Implement the cap rule in `scripts/check-override-consistency.mjs` (value's exclusive upper
  bound ≤ key-major + 1; unparseable → exit 2, never skip).
  **Verify GREEN**: same command, 0 failures; `node scripts/check-override-consistency.mjs` exits 0 on
  `main`'s file; `--selftest` exits 0.
- [ ] T035 [P] [US5] Guard RED — in `renovate-workflow.guard.test.mjs` assert: `major` updates of entries in
  `pnpm-workspace.yaml` resolve to disabled; `jest`, `babel-jest`, `@babel/core`, `@babel/runtime`,
  `typescript`, `@react-native-async-storage/async-storage` majors require dashboard approval; their
  patch/minor do NOT (the security stream stays open).
  **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` | **Expected RED**: new
  assertions fail.
- [ ] T036 [US5] Implement the packageRules in `renovate.json`, ordered after `js majors`, each description
  carrying its re-check rule (FR-016): jest/babel-jest → "jest-expo of the current SDK depends on jest 30"
  (expected at SDK 58); babel → "babel-preset-expo peers @babel/runtime ^8"; typescript → "typescript-eslint
  parser peer admits 7"; async-storage → "expo bundledNativeModules lists 3.x".
  **Verify GREEN**: same command as T035, 0 failures.
- [ ] T037 [US5] File one backlog item per hold (`node scripts/backlog.mjs`, per the `forgejo-issues`
  skill) carrying the measured reason and re-check rule; reference "item #254" in each. **Done when**: item
  numbers recorded in research.md and PR 5a; PR 5a merged.

**PR 5b — eslint 8 → 10**

- [ ] T038 [US5] **Verify RED (upgrade)**: bump `eslint` to ^10 in `frontend/mcm-app` and
  `packages/design-system`; `pnpm nx run-many -t lint -p mcm-app design-system --skip-nx-cache` — record the
  failure (expected: eslintrc unsupported / `--ext` rejected).
- [ ] T039 [US5] Migrate both `.eslintrc.json` to `eslint.config.js` using `eslint-config-expo/flat`; drop
  `--ext` from `frontend/mcm-app/project.json` and `package.json` lint commands.
  **Verify GREEN**: same command, 0 errors, 0 warnings.
- [ ] T040 [US5] Mutation check: add a deliberate violation (e.g. unused import) to one file, confirm lint
  FAILS, revert. **Done when**: recorded in PR 5b; PR merged.

**PR 5c — @testing-library/react-native 13 → 14**

- [ ] T041 [US5] **Verify RED (upgrade)**: bump to ^14 (+ `test-renderer` ^1 peer) in both packages;
  `pnpm nx run-many -t test -p mcm-app design-system --skip-nx-cache` — record failures.
- [ ] T042 [US5] Migrate API changes until GREEN. **Verify GREEN**: same command, 0 failures, coverage ≥70%.
  **Done when**: PR 5c merged; next dashboard read (T003) shows SC-004.

---

## Phase 8: US6 — express 5 + @types/express 5 + ioredis 6 (P2) — PR 6

- [ ] T043 [US6] M6 inventory: every `express` import/route/middleware and every `ioredis` call site under
  `frontend/mcm-app/src/` (`session-manager.ts`, `cache-service.ts`, …), mapped to the two majors' breaking
  changes. **Done when**: inventory in research.md.
- [ ] T044 [US6] Coverage gap check: for each inventoried behaviour with no test (route path matching,
  malformed-input rejection, eviction order), write the test against CURRENT code and prove it is
  sensitive by **mutation RED** (named source edit → fails → revert).
  **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern='<new test file>'` with the mutation applied
  **Expected RED**: the named assertion fails.
- [ ] T045 [US6] **Verify RED (upgrade)**: bump `express` ^5, `@types/express` ^5, `ioredis` ^6;
  `pnpm nx typecheck mcm-app && pnpm nx test mcm-app` — record failures.
- [ ] T046 [US6] Migrate until GREEN. **Verify GREEN**: same commands, 0 failures; then
  `MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app` — 0 failures, 0 skipped.
- [ ] T047 [US6] Web E2E incl. session-timeout and concurrent-session specs; `pnpm nx
  e2e:mobile:session-timeout mcm-app`; `pnpm nx dast infrastructure-as-code`. **Done when**: PR 6 merged
  (rollback: revert; Redis holds sessions only).

---

## Phase 9: US7 — assistant transport (P2) — PRs 7a, 7b

**PR 7a — copilotkit + @ag-ui/client**

- [ ] T048 [US7] **Verify RED (upgrade)**: set `@copilotkit/react-native` and `@copilotkit/runtime` to the
  latest 1.x (1.78.0 on 2026-10-10) and `@ag-ui/client` to the exact version they pin (1.0.2); `pnpm nx
  typecheck mcm-app && pnpm nx test mcm-app` — record failures (expect breaking-minor fallout, cf. PR #263).
- [ ] T049 [US7] Migrate until GREEN. **Verify GREEN**: same commands, 0 failures; `pnpm why @ag-ui/client`
  shows ONE version.
- [ ] T050 [US7] Stronger verification (FR-010): `E2E_REQUIRE_AGENT_STACK=1 pnpm nx e2e:agents mcm-app`
  (`@gate`); `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`; dispatch app-ci on the branch
  so the `E2E_TIER=model` selection runs, and compare its failures to `main`'s latest model-tier run
  (`node scripts/ci-status.mjs`). **Done when**: model-tier failures ⊆ `main`'s; mobile agent flows green in
  CI; PR 7a merged.

**PR 7b — openai 7 / @ai-sdk/openai**

- [ ] T051 [US7] M7: remove `@ai-sdk/openai` from `frontend/mcm-app/package.json`, build the BFF prod image,
  load the agent route (smoke). **Done when**: decision recorded — removed (route loads) or retained and
  bumped to ^4 (route fails without it).
- [ ] T052 [US7] **Verify RED (upgrade)**: bump `openai` ^7 (and `@ai-sdk/openai` ^4 if retained);
  `node --test scripts/__tests__/prune-bff-runtime-modules.test.mjs` and the prod-image route-load smoke —
  record failures; `pnpm why undici` checked against the `undici@<6.27.0` override.
- [ ] T053 [US7] Fix until GREEN. **Verify GREEN**: same, 0 failures; `@gate` agents suite green; model tier
  on dispatch ⊆ `main`. **Done when**: PR 7b merged.

---

## Phase 10: US8 — datastore images (P3) — PRs 8a, 8b, 8c

Starts after the parallel Langfuse minor PR has merged (same compose files).

**PR 8a — MongoDB 8.0 → 9.0, data preserved**

- [ ] T054 [US8] M8: record in research.md the supported upgrade path 8.0 → 9.0 and FCV steps; server-9
  support of the Rust driver (`mongodb` 3.9.x) and Node driver (`mongodb` 7.7.x); 9.0-ubi9 digest.
  **Done when**: each has a cited source; any "unsupported" stops the story.
- [ ] T055 [US8] Premise: CI infra-image scan of the 9.0 digest with the gate's criteria (ADR-0002 §3).
  **Done when**: findings ≤ 8.0.8's; else stop and record.
- [ ] T056 [US8] Local rehearsal on a copy of real-shaped data: backup → per-collection `countDocuments`
  (movie store + BFF store) → FCV per T054 → image move → counts → restore onto 8.0.8 (rollback rehearsal) →
  counts. **Done when**: all counts identical at every step (SC-005).
- [ ] T057 [US8] Bump all five refs (`bff/compose.yaml`, `bff/compose.prod.yaml`, `mc-service/compose.yaml` ×2,
  `mc-service/compose.prod.yaml`) with digest; amend constitution's document-database line (human approval).
- [ ] T058 [US8] Tiers: `MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mc-service` (replica set,
  cascade-delete transaction, collation indexes), `pnpm nx test:integration mcm-app` (BFF store, backup
  specs), `pnpm nx e2e mcm-app`, `pnpm nx infra-scan infrastructure-as-code`. **Done when**: green, 0 skipped.
- [ ] T059 [US8] Production cutover (operator-run, per `docs/runbooks/prod-data-tier-auth.md` +
  T056's procedure): counts before/after recorded in the PR. **Done when**: equal counts; PR 8a merged.

**PR 8b — observability postgres 16 → 18 (Langfuse + Unleash together)**

- [ ] T060 [US8] Guard RED — change `scripts/__tests__/langfuse-postgres-shared-pin.guard.test.mjs` to assert
  the new premise: both consumers share ONE pin AND it is the 18 line (update at the cause, never delete).
  **Verify RED**: `node --test scripts/__tests__/langfuse-postgres-shared-pin.guard.test.mjs`
  **Expected RED**: fails — the pin is still 16.
- [ ] T061 [US8] Move all four observability `postgres` refs to `18-alpine@<digest>`; remove the `<17`
  `allowedVersions` rule in `renovate.json` and update `renovate-workflow.guard.test.mjs` accordingly (the
  approval-on-major rule stays).
  **Verify GREEN**: both guards, 0 failures.
- [ ] T062 [US8] Data: `pg_dumpall` both instances → restore Unleash (and Langfuse per OQ-3) on 18 → verify
  Unleash flags/API and Langfuse UI (`pnpm nx up-observability infrastructure-as-code`); rehearsed locally,
  then prod. **Done when**: PR 8b merged with the restore evidence.

**PR 8c — vault (scan-gated)**

- [ ] T063 [US8] Scan the newest 1.x and 2.x `hashicorp/vault` tags with `trivy --severity CRITICAL
  --ignore-unfixed` (gate criteria). **Done when**: either (a) a tag clears libcrypto3 + grpc without adding
  pgx → move it, lift `<1.19`, re-key/delete the seed allowlist entries, guard updated; or (b) the hold's
  description is re-dated with the new digests and findings and its backlog item updated (OQ-4).

---

## Phase 11: US9 — cargo (P3) — PRs 9a, 9b

**PR 9a — bson 2 → 3**

- [ ] T064 [US9] **Verify RED (upgrade)**: in `backend/mc-service/Cargo.toml` set `mongodb = { version = "3",
  default-features = false, features = ["compat-3-3-0", "bson-3", "rustls-tls", "dns-resolver"] }` and
  `bson = { version = "3", features = [<bson-3 equivalents of chrono/uuid>] }`;
  `pnpm nx test:unit mc-service --skip-nx-cache` — record compile/test failures.
- [ ] T065 [US9] Migrate until GREEN. **Verify GREEN**: same command, 0 failures; then
  `MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mc-service` (every stored shape round-trips, keyset
  cursor decode, collation uniqueness), `pnpm nx lint mc-service`, the `rust:alpine` musl Docker build,
  `pnpm nx e2e mcm-app`. **Done when**: PR 9a merged; `cargo tree -d` shows no bson duplicate.

**PR 9b — base64 0.23 + reqwest 0.13 (approval-gated)**

- [ ] T066 [US9] M9: re-read crates.io — does `bson`/`mongodb` still require `base64 ^0.22`? does
  `axum-keycloak-auth` still require `reqwest ^0.12`? **Done when**: recorded in research.md R9.
- [ ] T067 [US9] If still blocked: file one backlog item each (reason + re-check rule), keep the dashboard
  approval gate. **Done when**: items filed; no PR needed (OQ-2).
- [ ] T068 [US9] If unblocked: **Verify RED (upgrade)**: bump; `cargo build --tests` for EVERY integration
  target (the targets `mc-service-checks` does not build — PR #216) — record failures; add the `form` feature
  explicitly; **Verify GREEN**: all targets build and `test:integration` passes; `cargo tree -e features
  --target x86_64-unknown-linux-musl` on the normal graph is unchanged in TLS features
  (`openwiki/gotchas/mc-service-musl-openssl.md`); musl Docker build green; `cargo tree -d` shows no new
  reqwest/base64 duplicate.

---

## Phase 12: Close-out

- [ ] T069 Write the learnings into their canonical sources (not openwiki pages, not CLAUDE.md):
  `docs/runbooks/renovate.md` (the override-widening trap and the new holds), and the CI-diagnostics runbook
  if T004 changed the upload-artifact fact. **Done when**: `pnpm nx okf-governance infrastructure-as-code`
  passes.
- [ ] T070 SC-001 audit: a table of every research R1 pending major → outcome (merged PR, or backlog item
  with re-check rule); post it as a comment on item #254 and close the item only if no row is empty.
  **Done when**: zero rows without an outcome.

---

## Dependencies & order

```
080 merged → US1(1a→1b) → US2 → US3(3a→3b) → US4 → US5(5a→5b→5c) → US6 → US7(7a→7b)
           → [Langfuse minor PR merged] → US8(8a→8b→8c) → US9(9a→9b) → close-out
```

- US2, US3, US4 are lockfile-wholesale: each gated by T002, never overlapping, never across a Friday
  02:00–04:59 America/New_York window.
- [P] marks only tasks inside one PR that touch different files (T033/T035).
- US9a depends on US8a (the server it integration-tests against).
