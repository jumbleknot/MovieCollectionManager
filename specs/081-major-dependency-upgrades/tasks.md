# Tasks: Major dependency upgrades (feature 081)

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)

**Total**: 84 tasks (T001–T084) across 10 user stories, ~19 PRs. US10 (Tamagui 2 → 3, T071–T084) was added
2026-10-18 and runs **after US4, before US5** (FR-001); its phase is placed in execution order, not number
order.

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
- [ ] T002 Quiet-lock check (used by US2/US3/US4/US10 — plan.md "Quiet-lock protocol"). **Done when**: the PR
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

- [x] T004 [US1] M1 runner probe: on a throwaway branch add `.forgejo/workflows/probe-081.yml` with one job
  on `ubuntu-latest` and one on `kvm`, each running `actions/checkout@v7`, `actions/setup-node@v7`,
  `actions/upload-artifact@v7` (SHA-pinned). Delete the branch afterwards; never merge it. **Done when**:
  research.md records, per label, whether each action ran — quoted from the job LOG (e.g.
  `GHESNotSupportedError`), not from the tick.
- [x] T005 [US1] Guard RED — in `scripts/__tests__/renovate-workflow.guard.test.mjs`, assert (a) `java-jdk`
  resolves to a held rule (no major) until US4, and (b) for every action T004 found unsupported, that
  action's resolved `allowedVersions` excludes the unsupported major.
  **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
  **Expected RED**: the new assertions fail — no such rule exists in `renovate.json`.
- [x] T006 [US1] Implement the holds in `renovate.json` (packageRules ordered after the `ci actions` group so
  the hold wins), each description quoting T004's measured error and the release condition.
  **Verify GREEN**: same command as T005 | **Expected GREEN**: 0 failures, prior tests still pass.
- [x] T007 [US1] PR 1a: bump `actions/checkout` v4→v7, `actions/setup-node` v4→v7, and `actions/upload-artifact`
  (to v7 only if T004 showed support) at every site in `.forgejo/workflows/*.yml` (22 / 12 / 7 sites), SHA +
  `# vN` comment convention. **Done when**: `pnpm nx preflight infrastructure-as-code` passes.
- [ ] T008 [US1] Verify PR 1a: all required contexts green; `cd-deploy` `workflow_dispatch` with
  `build_apk=true` and no deploy green; `infra-image-scan`, `renovate-health` green; job logs show the new
  majors executed. **Done when**: PR 1a merged with that evidence in its body.
- [x] T009 [US1] PR 1b: bump `actions/setup-java` v4→v6 (keep `java-version: '17'`), `android-actions/setup-android`
  v3→v4, `astral-sh/setup-uv` v5→v10, `dorny/paths-filter` v3→v4, `pnpm/action-setup` v4→v6. **Done when**:
  preflight passes.
- [x] T010 [US1] Verify PR 1b, including a commit that touches a path-filtered area so each filtered job is
  shown to RUN, not skip (paths-filter v4 output semantics); `cd-deploy` `build_apk` dispatch green.
  **Done when**: PR 1b merged; rollback = revert recorded in the body.

---

## Phase 4: US2 — pnpm 12 (P1) — PR 2 — lockfile-wholesale

- [x] T011 [US2] T002 quiet-lock check. Record the BEFORE table: for each of the 14 `overrides` keys in
  `pnpm-workspace.yaml`, the resolved version(s) in `pnpm-lock.yaml`. **Done when**: table in PR body.
- [x] T012 [US2] Guard check — `node --test scripts/__tests__/check-toolchain-consistency.test.mjs` passes
  before the change (control), then bump `packageManager` to `pnpm@12.x` in `package.json` and the corepack
  pins in `frontend/mcm-app/Dockerfile` together.
  **Verify RED (upgrade)**: `pnpm install` under 12 — record any `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`
  or ignored-key warning verbatim.
- [x] T013 [US2] Migrate any unrecognised `pnpm-workspace.yaml` key (never delete an override or a build
  decision); regenerate the lock once.
  **Verify GREEN**: `pnpm install --frozen-lockfile` cold succeeds with no warnings about ignored keys;
  `node scripts/check-override-consistency.mjs` exits 0; `node scripts/check-toolchain-consistency.mjs`
  exits 0.
- [ ] T014 [US2] AFTER table: every overridden package resolves within its patched range (no floor moved
  down). `pnpm nx run-many -t docker-build` (every image does a cold frozen install), `pnpm nx sast
  infrastructure-as-code`. **Done when**: PR 2 merged with before/after tables and green board.

---

## Phase 5: US3 — nx 23 + plugins (P1) — PRs 3a, 3b — lockfile-wholesale

- [x] T015 [US3] PR 3a: T002 check; bump `@nxlv/python` ^21 → ^23 and `@monodon/rust` ^2 → ^3 in root
  `package.json` (nx stays 22).
  **Verify RED (upgrade)**: `pnpm nx run-many -t test lint -p mc-service movie-assistant --skip-nx-cache`
  — record failures (or "bump was clean").
- [ ] T016 [US3] Fix executor/option changes until GREEN.
  **Verify GREEN**: same command | **Expected GREEN**: 0 failures; `pnpm why @nx/devkit` shows the 20.x and
  21.x copies gone. **Done when**: PR 3a merged.
- [x] T017 [US3] PR 3b: T002 check; record `pnpm nx show projects --json` and each project's target list
  (BEFORE). Run `pnpm nx migrate 23.x` (latest 23 at that day), `pnpm install`, `pnpm nx migrate
  --run-migrations`; keep `nx.json` `installation.version` == `package.json` `nx`.
  **Verify RED (upgrade)**: `pnpm nx run-many -t lint test typecheck --skip-nx-cache` — record failures.
- [x] T018 [US3] Resolve until GREEN; M3: confirm `@monodon/rust` 3 (devkit ^22) executors load under nx 23
  (`pnpm nx run mc-service:test`). If they do not, stop and record (spec US3 AC3).
  **Verify GREEN**: same command, 0 failures; `node scripts/check-toolchain-consistency.mjs` exits 0;
  AFTER project/target list identical to BEFORE.
- [ ] T019 [US3] Verify PR 3b: `pnpm nx e2e mcm-app` (via @nx/playwright), `pnpm nx preflight
  infrastructure-as-code`, CI `affected` selects the expected projects. **Done when**: PR 3b merged.

---

## Phase 6: US4 — Expo SDK 56 → 57, RN 0.85.3 → 0.86.3 (P1) — PR 4 — lockfile-wholesale

Run in the **Docker Desktop/DinD** dev container (needs `/dev/kvm` for the emulator).

- [x] T020 [US4] M4: re-read `expo` dist-tags and the jest-expo / babel-preset-expo / eslint-config-expo
  companion metadata (item #254 correction recipe); re-extract `bundledNativeModules.json` from the
  `expo-57.0.x` tarball. If SDK 58 is stable, STOP and ask the operator (OQ-1). **Done when**: research.md
  R4 updated with the day's numbers.
- [x] T021 [US4] T002 quiet-lock check.
- [x] T022 [US4] Draft the constitution amendment in `.specify/memory/constitution.md` (2.5.0 → 2.6.0, the
  Expo SDK line at §Frontend App Technology Stack and the version history). **Done when**: drafted and flagged
  in the PR for explicit human approval; not merged without it (FR-015).
- [x] T023 [US4] Upgrade in `frontend/mcm-app`: `pnpm expo install expo@^57.0.0` then `pnpm expo install
  --fix`; mirror `react-native` (0.86.3) and companions into `packages/design-system/package.json`; move the
  `@expo/dom-webview` override in `pnpm-workspace.yaml` to `^57`; run `pnpm expo install --check`.
  **Done when**: `--check` reports no mismatches and `@react-native-async-storage/async-storage` stays 2.2.0.
- [x] T024 [US4] Typecheck — **Verify RED (upgrade)**: `pnpm nx typecheck mcm-app --skip-nx-cache` — record
  the error count and how many are the PR #217 press-event narrowing (`GestureResponderEvent` vs Tamagui
  `PressableProps['onPress']`; expected 0 on RN 0.86).
- [x] T025 [US4] Fix typecheck errors. **Verify GREEN**: same command, 0 errors.
- [ ] T026 [US4] Unit tiers — **Verify RED (upgrade)**: `pnpm nx run-many -t test -p mcm-app design-system
  --skip-nx-cache` — record failures; fix (jest-expo 57 preset, RN 0.86 mocks).
  **Verify GREEN**: same command, 0 failures, coverage ≥70% on mcm-app.
  *US4 (2026-10-17): bump was clean — design-system 12/107, mcm-app 154/1578, 0 failures both before and after any fix
  (none needed). Coverage is NOT ≥70%: 61.32% lines (3278/5345) on this branch AND on `origin/main` `97106c8e`,
  file-for-file identical — a pre-existing gap the CI jobs do not gate (no job runs `--coverage`). Left unticked.*
- [x] T027 [US4] JDK decision: read SDK 57's Android template (Gradle/AGP JDK requirement). Guard RED: update
  the T005 `java-jdk` assertion to the decided state (held at 17 with the SDK-57 reason, OR moved).
  **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` fails on the changed
  assertion. Implement in `renovate.json` (+ `java-version` in workflows if moving). **Verify GREEN**: same.
- [ ] T028 [US4] Android: `pnpm nx build-apk mcm-app`, then `pnpm nx e2e:mobile mcm-app` and
  `pnpm nx e2e:agents mcm-app` on the local KVM emulator. **Done when**: all flows pass; any flake re-run
  shown to be pre-existing against `main` (baseline per pull-request-batching).
- [ ] T029 [US4] Web: `pnpm nx export-server mcm-app`, BFF prod image build, `pnpm nx bundle-budget mcm-app`,
  `pnpm nx e2e mcm-app`. **Done when**: green with zero skipped suites.
- [x] T030 [US4] SAST re-check: `pnpm nx sast infrastructure-as-code`. **Done when**: the node-forge
  (`^node-forge@1\.4\.0$`) and braces (`^braces@3\.0\.3$`) allowlist entries still match exactly, or — if
  discharged — are deleted in this PR (FR-018). Expected per R4: neither discharged.
- [ ] T031 [US4] PR 4 with rollback (revert; previous APK) and exit criterion (plan.md US4). **Done when**:
  merged with human approval of T022.

---

## Phase 6b: US10 — Tamagui 2.7.7 → 3.0.x (P2) — PR 10 — lockfile-wholesale

Runs after US4 (merged `64e7715d`) and before US5. Every fact is in research R12, and the approach, tiers and
memory rules are in plan.md "US10". **Sandbox memory rule for every task below**: run one heavy step at a
time, use `--parallel=1` and Jest `--maxWorkers=2`, and commit and push WIP before each heavy step.

- [x] T071 [US10] M10 + T003 + T002. Re-read the packuments and every release body after 3.0.18, and pick the
  newest 3.0.x whose whole set is past the 3-day cooldown at that moment (expected 3.0.18 or newer, not before
  2026-10-19T10:15Z). Re-check the peers and `@tamagui/metro-plugin`'s `metro` range against the lock. Then
  read the dashboard and run the quiet-lock check. The PR must not be open across **Fri 2026-10-23
  02:00–04:59 America/New_York**: it merges before that or opens after it. **Done when**: research.md
  "Re-baseline deltas → US10" records the version and publish times, any new breaking note, and the
  dashboard delta. The PR body records zero open `renovate/*` heads, the ET time, and the planned merge-by
  time. If a blocker turns up, stop: R12 "Hold?" applies.
- [x] T072 [US10] Guard RED. Create `scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`. It asserts:
  (a) every `tamagui` / `@tamagui/*` specifier in `frontend/mcm-app/package.json` and
  `packages/design-system/package.json` is one exact version (no range), and both manifests agree;
  (b) `pnpm-lock.yaml` has exactly one version of each of `@tamagui/core`, `@tamagui/web` and `tamagui`
  (if `tamagui` was removed in T073, it has none);
  (c) neither manifest nor `frontend/mcm-app/babel.config.js` names `@tamagui/babel-plugin`;
  (d) resolved through the same Renovate model `renovate-workflow.guard.test.mjs` uses, every
  `tamagui` / `@tamagui/*` update (major, minor and patch) lands in one `tamagui` group.
  **Verify RED**: `node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`
  **Expected RED**: (a) fails on the `^2.3.0` ranges and the `>=2.0.0` font-inter range; (b) fails on core
  2.7.7 + 3.0.13; (c) fails on both files; (d) fails because the packages land in `js majors` /
  `js patch/minor`.
- [x] T073 [US10] **[operator: OQ-7]** Decision, measured: `rg "from '(tamagui|@tamagui/config|@tamagui/font-inter)'"` over
  both projects, including tests, plus every non-import reference (the Babel `components` list, jest
  `transformIgnorePatterns`). **Done when**: each of `tamagui`, `@tamagui/config` and `@tamagui/font-inter`
  is recorded in research as **remove** (zero imports) or **pin** (with the importing file), and the
  operator's OQ-7 answer is applied.
- [x] T074 [US10] Behaviour-preservation tests against the CURRENT code, before anything moves (the
  T044-style **mutation RED**):
  (i) a bare design-system / `@tamagui/core` `Text` inside the provider renders with the body font family
  and `onBackground` colour (B4, today supplied by `createTamagui({ defaultProps })`);
  (ii) the interactive `Card`, `Button` and `Chip` keep their hover/press/focus-visible styles (B3). This is
  asserted through whatever the current test renderer exposes for them. If it exposes nothing, it is asserted
  statically, by a source scan in the style of `focus-ring.test.ts`, that each still declares all three
  states. That scan is rewritten for the v3 spelling in T078.
  **Verify RED**: `pnpm nx test design-system -- --maxWorkers=2 --testPathPattern='<new test files>'` with
  each named mutation applied: remove `defaultProps.Text`, then delete one `pressStyle`.
  **Expected RED**: the named assertion fails. Revert the mutation, and it passes on 2.7.7.
- [x] T075 [US10] Guard update at its cause (CLAUDE.md, never delete): change
  `packages/design-system/components/focus-ring.test.ts` to assert the v3 spelling. Interactive primitives and
  surfaces carry a `focus-visible` clause or key; none carries a bare `focus` state clause, nor a leftover
  `focusStyle` / `focusVisibleStyle` object.
  **Verify RED**: `pnpm nx test design-system -- --maxWorkers=2 --testPathPattern=focus-ring`
  **Expected RED**: fails on the six files still using `focusVisibleStyle`. It turns GREEN in T078, not
  before.
- [x] T076 [US10] Visual baseline BEFORE, from `main` (or the branch before T077). Capture the plan.md screen
  list (login, collections, collection detail, movie detail, the sort/filter row, a dialog, settings, the
  assistant dock), in light and dark. On web, use a scratch Playwright `page.screenshot` script against
  `pnpm nx e2e`'s stack. On Android, use the latest full-suite run's Maestro artefacts on `main`. **Done
  when**: the captures are saved outside the repo, the list is recorded in the PR body, and nothing is
  committed.
- [x] T077 [US10] **Verify RED (upgrade)**. Bump only the packages: exact-pin the five grouped packages to the
  T071 version in both manifests; remove `@tamagui/babel-plugin` (and its `babel.config.js` entry); add
  `@tamagui/metro-plugin` at the same version as a devDependency of `frontend/mcm-app`; apply T073; set the
  design-system peer to `tamagui >=3.0.0 <4` (or drop it with the dependency). Then run **one**
  `pnpm install`, alone. Record:
  - `pnpm nx typecheck mcm-app --skip-nx-cache`: the error count, and **how many are press-event errors**
    (`GestureResponderEvent` vs `PressableProps['onPress']`; R12 says Tamagui 3's types are generated from RN
    0.87.1, so the PR #217 narrowing may appear here on RN 0.86);
  - `pnpm exec tsc --noEmit -p packages/design-system`: the error count;
  - `pnpm nx run-many -t test -p design-system mcm-app --parallel=1 --skip-nx-cache -- --maxWorkers=2`: the
    failure count;
  - `node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`: (a)–(c) now pass, (d) still
    fails.

  A clean bump is recorded as "bump was clean", never as a RED.
- [x] T078 [US10] Source migration until GREEN:
  1. `pnpm dlx @tamagui/codemod-flat-values@<T071 version> --source-semantics v2-pixels --report
     <scratch>/flat-values-report.md packages/design-system frontend/mcm-app/src` (report mode). Read every
     flagged row, then re-run with `--write`.
  2. Fix by hand: B4 (`defaultProps` → design-system-owned `Text` defaults), B3 conditional pseudo-states,
     B5 `lineHeight`, and leftover B2 sigils. No Config v6: tokens and themes stay byte-identical.
  3. Run the guide's quick-reference greps (research R12) to zero:
     - `="\$` and `'\$<token>`;
     - `hoverStyle|pressStyle|focusStyle|focusVisibleStyle|enterStyle|exitStyle`;
     - `\b(size|fontSize)="\$`;
     - `defaultProps` in `tamagui.config.ts`;
     - the removed-API pattern list.

  **Verify GREEN**: the T077 commands, all with 0 errors and 0 failures; T074 and T075 pass; the press-event
  count is 0. If the PR #217 narrowing appeared in T077, it is fixed at the two `onPress` type declarations
  (`primitives/Button.tsx:45`, `primitives/PillButton.tsx:24`), with no `any` and no suppression.
- [x] T079 [US10] **[operator: OQ-5 if falling back]** Compiler. In `frontend/mcm-app/metro.config.js`, wrap the existing config with
  `withTamagui(…, { components: ['@mcm/design-system'], config: './tamagui.config.ts' })`, keeping the
  segment shim and the dotenv blocklist. Make sure the `export-server` nx target's inputs cover
  `tamagui.config.ts` and the design-system sources (upstream: the Metro plugin does not invalidate the
  transform cache on config changes). **Done when** each of these succeeds, in turn and alone, after
  `rm -rf frontend/mcm-app/node_modules/.cache/tamagui`:
  - `pnpm nx export-server mcm-app --skip-nx-cache`;
  - `pnpm --filter mcm-app exec expo start --web --clear`, which serves `/` without OOM;
  - `pnpm nx build-apk mcm-app` (CI may substitute for a local APK build).

  If the plugin cannot be made to work, the runtime-only fallback is chosen only with T081's budget and the
  dev-server check both green, and is recorded with the measurement.
- [x] T080 [US10] Renovate. Add the `tamagui` packageRule (`matchPackageNames: ["tamagui", "/^@tamagui\\//"]`,
  `groupName: "tamagui"`, `rangeStrategy: "pin"`), ordered after `js patch/minor` and `js majors`. The
  description carries the R12 reason (one version, several patches a day).
  **Verify GREEN**: `node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs
  scripts/__tests__/renovate-workflow.guard.test.mjs` with 0 failures and every prior test still passing.
  `node scripts/check-toolchain-consistency.mjs` and `node scripts/check-override-consistency.mjs` both exit 0.
- [x] T081 [US10] **[operator: OQ-6 if over budget]** Web bundle: `pnpm nx bundle-budget mcm-app --skip-nx-cache` (it depends on
  `export-server`) and the BFF prod image build. **Done when**: the entry chunk is ≤ 2,000,000 B, with the
  before (`main`) and after byte counts recorded. If it is over budget, **stop** and ask the operator (OQ-6):
  the budget is not raised in this PR.
- [x] T082 [US10] SAST: `pnpm nx sast infrastructure-as-code`. **Done when**: the braces entry
  (`^braces@3\.0\.3$`, item #648) and the node-forge entry still match exactly, or are deleted if discharged
  (FR-018; R12 expects braces still reached through `@tamagui/static` → `fast-glob`). No new finding is
  allowlisted without the operator.
- [x] T083 [US10] Parity. Add the `mobile-e2e-full` label to the PR **before** the push that should run it
  (a label event alone starts nothing), or dispatch app-ci with `mobile_suite: full`. **Done when** all of
  these hold:
  - the required contexts are green;
  - `maestro-full-flows` passes its 22 blocking flows and `maestro-agent-flows` passes, with skip counts read;
  - `movie-sort` (item #781) and `login-invalid` (item #782) have their statuses recorded, and any change is
    explained;
  - `pnpm nx e2e mcm-app` (the full web regression) has zero skipped;
  - the AFTER captures of the T076 list are attached beside the BEFORE ones, with every visible difference
    explained or fixed (FR-019).
- [x] T084 [US10] Docs and close. Correct the canonical sources: in `frontend/mcm-app/README.md` the
  "Runtime-only Tamagui" and "Pin Tamagui to v1" bullets, and in `packages/DESIGN-SYSTEM.md` the `$token`
  examples and the Babel-plugin setup. Do not hand-edit `openwiki/` pages. Run `pnpm nx okf-governance
  infrastructure-as-code`. **Done when**: PR 10 is merged before the Fri 2026-10-23 window (or opened after
  it), with rollback (revert; the previous APK) and the exit criterion (plan.md US10) in its body, and the
  next T003 read shows no Tamagui major pending.

---

## Phase 7: US5 — toolchain (P2) — PRs 5a, 5b, 5c

- [x] T032 [US5] SC-003: re-derive US5 scope from the companion metadata of the SDK US4 landed, plus M5
  (`@typescript-eslint/parser` latest's `typescript` peer). **Done when**: research.md R4/R5 updated; any
  majors that became free move into 5b/5c.

**PR 5a — overrides + holds (no lockfile churn)**

- [x] T033 [P] [US5] Guard RED — in `scripts/__tests__/check-override-consistency.test.mjs` add cases: a keyed
  override whose value cap admits a major above the key's (`undici@<6.27.0: '>=6.27.0 <9'`) FAILS; the
  current `'>=6.27.0 <7'` passes; a plain pin (`react-dom`) is out of scope; extend `--selftest` likewise.
  **Verify RED**: `node --test scripts/__tests__/check-override-consistency.test.mjs`
  **Expected RED**: the widening case is not rejected (the gate checks only floor/key agreement today).
- [x] T034 [US5] Implement the cap rule in `scripts/check-override-consistency.mjs` (value's exclusive upper
  bound ≤ key-major + 1; unparseable → exit 2, never skip).
  **Verify GREEN**: same command, 0 failures; `node scripts/check-override-consistency.mjs` exits 0 on
  `main`'s file; `--selftest` exits 0.
- [x] T035 [P] [US5] Guard RED — in `renovate-workflow.guard.test.mjs` assert: `major` updates of entries in
  `pnpm-workspace.yaml` resolve to disabled; `jest`, `babel-jest`, `@babel/core`, `@babel/runtime`,
  `typescript`, `@react-native-async-storage/async-storage` majors require dashboard approval; their
  patch/minor do NOT (the security stream stays open).
  **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs` | **Expected RED**: new
  assertions fail.
- [x] T036 [US5] Implement the packageRules in `renovate.json`, ordered after `js majors`, each description
  carrying its re-check rule (FR-016): jest/babel-jest → "jest-expo of the current SDK depends on jest 30"
  (expected at SDK 58); babel → "babel-preset-expo peers @babel/runtime ^8"; typescript → "typescript-eslint
  parser peer admits 7"; async-storage → "expo bundledNativeModules lists 3.x".
  **Verify GREEN**: same command as T035, 0 failures.
- [x] T037 [US5] File one backlog item per hold (`node scripts/backlog.mjs`, per the `forgejo-issues`
  skill) carrying the measured reason and re-check rule; reference "item #254" in each. **Done when**: item
  numbers recorded in research.md and PR 5a; PR 5a merged. **Done**: items #792 (jest 30), #793 (babel 8),
  #794 (typescript 7), #795 (async-storage 3).

**PR 5b — eslint 8 → 10**

- [x] T038 [US5] **Verify RED (upgrade)**: bump `eslint` to ^10 in `frontend/mcm-app` and
  `packages/design-system`; `pnpm nx run-many -t lint -p mcm-app design-system --skip-nx-cache` — record the
  failure (expected: eslintrc unsupported / `--ext` rejected).
- [x] T039 [US5] Migrate both `.eslintrc.json` to `eslint.config.js` using `eslint-config-expo/flat`; drop
  `--ext` from `frontend/mcm-app/project.json` and `package.json` lint commands.
  **Verify GREEN**: same command, 0 errors, 0 warnings.
- [x] T040 [US5] Mutation check: add a deliberate violation (e.g. unused import) to one file, confirm lint
  FAILS, revert. **Done when**: recorded in PR 5b; PR merged.

**PR 5c — @testing-library/react-native 13 → 14**

- [x] T041 [US5] **Verify RED (upgrade)**: bump to ^14 (+ `test-renderer` ^1 peer) in both packages;
  `pnpm nx run-many -t test -p mcm-app design-system --skip-nx-cache` — record failures.
- [x] T042 [US5] Migrate API changes until GREEN. **Verify GREEN**: same command, 0 failures, coverage ≥70%.
  **Done when**: PR 5c merged; next dashboard read (T003) shows SC-004. **Done**: PR #798 merged 2026-10-19
  (`469d205c`), with the accepted 5-statement/5-branch coverage drop (double-submit guards unreachable under
  RNTL 14's `disabled` handling); test-renderer held below 1.3 by PR #800. The SC-004 dashboard read is still
  owed after the Fri 2026-10-23 Renovate window.

---

## Phase 8: US6 — express 5 + @types/express 5 + ioredis 6 (P2) — PR 6

- [x] T043 [US6] M6 inventory: every `express` import/route/middleware and every `ioredis` call site under
  `frontend/mcm-app/src/` (`session-manager.ts`, `cache-service.ts`, …), mapped to the two majors' breaking
  changes. **Done when**: inventory in research.md.
- [x] T044 [US6] Coverage gap check: for each inventoried behaviour with no test (route path matching,
  malformed-input rejection, eviction order), write the test against CURRENT code and prove it is
  sensitive by **mutation RED** (named source edit → fails → revert).
  **Verify RED**: `pnpm nx test mcm-app -- --testPathPattern='<new test file>'` with the mutation applied
  **Expected RED**: the named assertion fails.
- [x] T045 [US6] **Verify RED (upgrade)**: bump `express` ^5, `@types/express` ^5, `ioredis` ^6;
  `pnpm nx typecheck mcm-app && pnpm nx test mcm-app` — record failures.
- [x] T046 [US6] Migrate until GREEN. **Verify GREEN**: same commands, 0 failures; then
  `MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app` — 0 failures, 0 skipped.
- [x] T047 [US6] Web E2E incl. session-timeout and concurrent-session specs; `pnpm nx
  e2e:mobile:session-timeout mcm-app`; `pnpm nx dast infrastructure-as-code`. **Done when**: PR 6 merged
  (rollback: revert; Redis holds sessions only). **Done**: PR #802 merged 2026-10-19 (`2b5ba71c`).
  - Web E2E: PR app-e2e green, and locally 153 non-agent specs passed.
  - Concurrent sessions: covered by the real-Redis `concurrent-session-cap` integration case.
  - DAST: the full scan passed in CI.
  - The mobile session-timeout flow was NOT run. It is manual and needs KVM, and express/ioredis run only in the BFF. Treated as not applicable unless the operator asks for a KVM-host run.
  - main's push run 5618 then failed `app-e2e` on the known item #702 flake ("No caller identity"), so the
  deploy rides the next main push.

---

## Phase 9: US7 — assistant transport (P2) — PRs 7a, 7b

**PR 7a — copilotkit + @ag-ui/client**

- [x] T048 [US7] **Verify RED (upgrade)**: set `@copilotkit/react-native` and `@copilotkit/runtime` to the
  latest 1.x (1.78.0 on 2026-10-10) and `@ag-ui/client` to the exact version they pin (1.0.2); `pnpm nx
  typecheck mcm-app && pnpm nx test mcm-app` — record failures (expect breaking-minor fallout, cf. PR #263).
- [x] T049 [US7] Migrate until GREEN. **Verify GREEN**: same commands, 0 failures; `pnpm why @ag-ui/client`
  shows ONE version.
- [x] T050 [US7] Stronger verification (FR-010): `E2E_REQUIRE_AGENT_STACK=1 pnpm nx e2e:agents mcm-app`
  (`@gate`); `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`; dispatch app-ci on the branch
  so the `E2E_TIER=model` selection runs, and compare its failures to `main`'s latest model-tier run
  (`node scripts/ci-status.mjs`). **Done when**: model-tier failures ⊆ `main`'s; mobile agent flows green in
  CI; PR 7a merged.
  *Done 2026-10-19: PR #803 merged as `43e92656`; `main`'s push run on it was green, `app-e2e` included.*

**PR 7b — openai 7 / @ai-sdk/openai**

- [x] T051 [US7] M7: remove `@ai-sdk/openai` from `frontend/mcm-app/package.json`, build the BFF prod image,
  load the agent route (smoke). **Done when**: decision recorded — removed (route loads) or retained and
  bumped to ^4 (route fails without it).
  *Done 2026-10-19: **removed**. The app's copy was never the one loaded: `main`'s own image already fails
  `resolve('@ai-sdk/openai')` (pruned), and its bundle inlines copilotkit's copy. The image without it gives
  agent route 401 (module evaluated); bundle check 14/0. Evidence in research.md "US7 (PR 7b)".*
- [x] T052 [US7] **Verify RED (upgrade)**: bump `openai` ^7 (and `@ai-sdk/openai` ^4 if retained);
  `node --test scripts/__tests__/prune-bff-runtime-modules.test.mjs` and the prod-image route-load smoke —
  record failures; `pnpm why undici` checked against the `undici@<6.27.0` override.
  *Done 2026-10-19: `openai` ^7.34.0. Nothing went RED. The prune test passed 17/17 because its fixture is
  version-blind, so that gap was closed first: the new peer-link case fails on the 6.x fixture and passes on
  the 7.x one. The override REWRITES openai's undici peer to `>=6.27.0 <7`. See research.md.*
- [x] T053 [US7] Fix until GREEN. **Verify GREEN**: same, 0 failures; `@gate` agents suite green; model tier
  on dispatch ⊆ `main`. **Done when**: PR 7b merged.
  *Done 2026-10-19: PR #807 merged (`abed3e2d`); main's run passed every required context and cd-deploy promoted
  it (`f233565f`, promoting tip `185fb849`). GREEN before merge: PR #807 at `3cd2bd49` was mergeable. Its `@gate` tier gave failed=0 flaky=1
  (run 5649). The dispatched model tier gave failed=0 flaky=2 (run 5652); `main` gave failed=0 flaky=3 (run
  5645). See research.md.*

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

- [X] T063 [US8] Scan the newest 1.x and 2.x `hashicorp/vault` tags with `trivy --severity CRITICAL
  --ignore-unfixed` (gate criteria). **Done when**: either (a) a tag clears libcrypto3 + grpc without adding
  pgx → move it, lift `<1.19`, re-key/delete the seed allowlist entries, guard updated; or (b) the hold's
  description is re-dated with the new digests and findings and its backlog item updated (OQ-4).
  **Outcome (a), 2026-10-20**: 1.21.4 still 4 Criticals (unchanged); **2.2.0 has 0** (libcrypto3 3.5.8,
  grpc 1.83.2, pgx 5.10.0). Refs → `2.2@sha256:e0acd3c6…`, `<1.19` replaced by a major-approval rule, the
  three seed entries deleted, guard updated at the cause and mutation-RED'd; local prod-posture start
  (sealed/healthy) + init/unseal/persist verified. Evidence: research.md R8.

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
080 merged → US1(1a→1b) → US2 → US3(3a→3b) → US4 → US10 → US5(5a→5b→5c) → US6 → US7(7a→7b)
           → [Langfuse minor PR merged] → US8(8a→8b→8c) → US9(9a→9b) → close-out
```

- US2, US3, US4, US10 are lockfile-wholesale: each gated by T002, never overlapping, never across a Friday
  02:00–04:59 America/New_York window (US10's next one: Fri 2026-10-23).
- US10 depends on US4 (merged); US5c depends on US10 (same design-system components under test).
- Operator-approval gates in US10: OQ-5..OQ-8 (spec.md) are answered before T071, and T081 stops on an
  over-budget bundle (OQ-6). No constitution amendment is expected (FR-015; no Tamagui version is named).
- [P] marks only tasks inside one PR that touch different files (T033/T035). Inside US10, T072–T076 touch
  different files but are deliberately NOT [P]: the memory rule runs one heavy step at a time.
- US9a depends on US8a (the server it integration-tests against).
