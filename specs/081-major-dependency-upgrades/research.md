# Research: Major dependency upgrades (feature 081)

**Date**: 2026-10-10 | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

Everything in this file was **measured on 2026-10-10** from one of four instruments, named per row:

- **DASH** — the Renovate Dependency Dashboard, item #29, as returned by `node scripts/backlog.mjs show 29`
  (body updated `2026-10-10T03:01:57Z`). Read only; never edited.
- **REPO** — the checked-in files at `origin/main` = `60d03774` (`package.json`s, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `backend/mc-service/Cargo.toml`, root `Cargo.lock`, compose files,
  `.forgejo/workflows/*.yml`, `renovate.json`).
- **NPM** — `https://registry.npmjs.org/<pkg>` packuments (dist-tags, `dependencies`, `peerDependencies`,
  `engines`), and for `expo` the published tarball's `package/bundledNativeModules.json`
  (`registry.npmjs.org/expo/-/expo-<v>.tgz`; unpkg and jsDelivr do not resolve from the dev container).
- **CRATES** — `https://crates.io/api/v1/crates/<crate>[/<v>[/dependencies]]`.

Anything a stage needs that could NOT be measured today is listed in §11 as a **stage-start measurement**,
with the command that settles it. Nothing below is inferred from a release note alone.

---

## R1. The re-baseline — what item #254's eight stages actually have pending today

Item #254 (2026-08-27) is stale in both directions: some of its stages have already landed, and the
dashboard now carries majors the item never listed.

| # | Stage (item #254) | Item said | Pending TODAY (measured) | Already landed / changed since the item |
|---|---|---|---|---|
| 1 | CI actions | 8 action majors | **All 8 still pending** (DASH `renovate/major-ci-actions`, Awaiting Schedule): `actions/checkout` v4→**v7**, `actions/setup-node` v4→**v7**, `actions/upload-artifact` v3→**v7**, `actions/setup-java` v4→**v6** (item said v5), `android-actions/setup-android` v3→v4, `astral-sh/setup-uv` v5→**v10.2.0**, `dorny/paths-filter` v3→v4, `pnpm/action-setup` v4→v6. Also detected: `java-jdk 17 → 25` on the two `setup-java` sites (app-ci.yml:529, cd-deploy.yml:460). | Use counts (REPO): checkout ×22, setup-node ×12, pnpm/action-setup ×8, upload-artifact ×7, setup-uv ×5, setup-java ×2, setup-android ×2, paths-filter ×2. `reactivecircus/android-emulator-runner` has no major pending. |
| — | **pnpm 12** (not in item) | — | **Pending** (DASH `renovate/major-pnpm-pin`): `pnpm` 11.25.0 → 12.10.1 (`package.json` `packageManager` + `frontend/mcm-app/Dockerfile` corepack pins). | pnpm 12.0.0 published 2026-08-26, after the item. |
| 2 | nx 22→23 | nx, @nx/expo, @nx/playwright, @nxlv/python 21→23, @monodon/rust 2→3 | **All pending**: `nx`/`@nx/expo`/`@nx/playwright` 22.7.10 → 23.x (latest **23.3.0**, NPM; DASH branch `renovate/major-nx-monorepo` names 23.2.1); `@nxlv/python` ^21.0.3 → 23 and `@monodon/rust` ^2.3.0 → 3 ride the **js majors** group, not the nx group. | DASH still lists `@nx/expo 22.6.3` in Detected Dependencies; REPO has 22.7.10 exactly since PR #705 — the dashboard's extraction lagged. |
| 3 | Expo/RN 57 | SDK 57, RN "0.87?" | **Pending**: expo `^56.0.8` (installed 56.x, RN **0.85.3**) → SDK 57 = expo **57.0.27**, RN **0.86.3** (NPM). Not on the dashboard at all — Renovate is deliberately disabled for Expo/RN (`renovate.json`, four `enabled: false` rules). | `latest` moved 57.0.17 → **57.0.27**; SDK **58** now exists on the `next` tag (58.0.7, 2026-10-09) on **RN 0.88.0-rc.4**. See R4. |
| 4 | jest 30 / babel 8 / TS 7 | "re-scope after 3" → corrected to "jest/babel blocked on Expo; TS independent" | DASH js-majors group carries `jest` ^29.7→^30, `babel-jest` ^29.7→^30, `@babel/core` ^7.25→^8, `@babel/runtime` ^7.25→^8, `typescript` ~6.0.3→~7.0.0, `eslint` ^8.57→**^10** (two majors), `@testing-library/react-native` ^13.2→^14, `@react-native-async-storage/async-storage` ^2.2→^3. | **TS 7 is NOT independent** — contradicts the item's correction; see R5. **jest 30 is unblocked by SDK 58, not 57**; babel 8 stays blocked even at 58 — see R4. |
| 5 | express 5 + @types/express 5 + ioredis 6 | as listed | **Pending** (js majors group): `express` ^4.21→^5 (latest 5.3.0), `@types/express` ^4.17.21→^5 (5.0.6), `ioredis` ^5.10.1→^6 (6.0.0, 2026-07-31). | — |
| 6 | openai 7 / @ai-sdk/openai 4 | "agent transport" | **Pending** (js majors): `openai` ^6.42→^7 (7.32.0), `@ai-sdk/openai` ^3.0.68→^4 (4.0.91). Also pending and **coupled**: `@ag-ui/client` 0.0.59→**1.0.2** (js majors) and copilotkit 1.70.1→**1.77.0** (DASH Pending Approval; NPM latest is now **1.78.0**). | Neither `openai` nor `@ai-sdk/openai` is imported anywhere in `frontend/` — they are eager-import satisfiers for `@copilotkit/runtime` (commit `89ec0dae`). See R7. |
| 7 | docker majors | vault 2.0, opensearch 3, langfuse 4, clickhouse 24→26, postgres 16→18 | **Pending**: `mongodb/mongodb-community-server` 8.0.8-ubi9 → **9.0.2-ubi9** (DASH Pending Status Checks, branch `renovate/major-docker-base-images`; four compose refs — bff ×2, mc-service ×3 incl. prod). **Held by rule, not pending**: observability `postgres:16-alpine` (×4 refs; `allowedVersions: "<17"`, shared Langfuse/Unleash pin) and `hashicorp/vault:1.18` (`allowedVersions: "<1.19"`, a security hold). | **Landed**: OpenSearch **3** (feature 071), Langfuse **4** (4.35.0; feature 072 — a parallel PR is moving it to a 4.5x minor), ClickHouse **26.6** (PR #698; 26.6→26.9 is calendar-minor, not a major), Redis **8** (PR #698), Keycloak + agent-db postgres **18**. |
| 8 | cargo | bson 3, base64 0.23, reqwest 0.13 | **Pending**: `bson` 2→3 (DASH `renovate/major-cargo-deps`), `base64` 0.22→0.23 + `reqwest` 0.12→0.13 (DASH Pending Approval, `cargo 0.x breaking`). | Two of the three are **blocked upstream today** — see R9. |
| — | **copilotkit 1.77** (not in item) | — | Pending Approval (1.70.1 → 1.77.0; 1.78.0 now latest). | Placed in stage 6 — R7. |
| — | **Override ranges** (not in item) | — | Five js-majors entries: `undici@<6.27.0`, `nanoid@>=3.0.0 <3.3.18`, `js-yaml@>=3.0.0 <3.15.1`, `js-yaml@>=4.0.0 <4.3.1`, `fast-uri@<3.1.5`. | Not dependency upgrades at all — R2. |
| — | **Tamagui 3** (not in item; added 2026-10-18) | — | Not pending on 2026-10-10: Tamagui 3.0.0 was published that day at 03:03Z, after this table was measured. First seen on the dashboard as drift by US3 PR 3b on 2026-10-17: `tamagui` and `@tamagui/{config,core,shorthands,stacks}` ^2.3.0 → ^3.0.0, in js-majors. | **Planned as US10** (operator decision 2026-10-17, item #254), placed after US4. See R12. |

Minor/patch items on the dashboard (playwright 1.64, node 24.21, uv 0.13, rust 1.99, trivy, semgrep,
maestro, ollama, `@types/react` ~19.3, langfuse 4.53, nx 22.7.12) are **out of scope**: they are routine
channels and move on their own schedule. `@types/react ~19.3` is React-locked and belongs to whichever SDK
ships React 19.3 (SDK 58 does — R4).

**Open-PR state at measurement time**: zero open pull requests on the forge (API `pulls?state=open`
with `MCM_FORGE_TOKEN`). Feature 080 (MinIO→RustFS) has no branch on the remote yet.

---

## R2. The five "override majors" — NOT a CVE-relevant change; reject them and stop them being proposed

**Where they live.** Not root `package.json` — pnpm 11 stopped reading its `pnpm` field. They are in
`pnpm-workspace.yaml` → `overrides:` (REPO), where every keyed entry is a security floor:

| Override key (vulnerable span) | Current value (floor + major cap) | Renovate proposes | Advisory it exists for (REPO git history) | Resolved today (REPO lockfile) | Who depends on it |
|---|---|---|---|---|---|
| `undici@<6.27.0` | `>=6.27.0 <7` | `>=6.27.0 <9` | added by feature 034 / pnpm-11 migration (runtime SCA) | 6.29.0, 7.29.1 | 6.x: `@ai-sdk/provider-utils` ×3, `@expo/server`; 7.x: `@module-federation/dts-plugin` |
| `nanoid@>=3.0.0 <3.3.18` | `>=3.3.18 <4` | `>=3.3.18 <7` | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8 (`fc3c47ae`) | 3.3.20 | `@gorhom/portal`, `expo-router`, `postcss` |
| `js-yaml@>=3.0.0 <3.15.1` | `>=3.15.1 <4` | `>=3.15.1 <6` | GHSA-5p4m-2wfm-xmqj (`fc3c47ae`) | 3.15.2 | `@istanbuljs/load-nyc-config` |
| `js-yaml@>=4.0.0 <4.3.1` | `>=4.3.1 <5` | `>=4.3.1 <6` | GHSA-5p4m-2wfm-xmqj, 4.x line | 4.3.2 (+5.4.3 un-overridden, via `@napi-rs/cli`) | 8 dependents |
| `fast-uri@<3.1.5` | `>=3.1.5 <4` | `>=3.1.5 <5` | GHSA-7p8r-x3mc-p8w7 (feature 057, `d1c1e87f`) | 3.1.8 | `ajv@8.20.0` |

**What the proposals change.** DASH shows the proposals touch only the **value's upper bound**. The key
(the vulnerable span) and the value's lower bound (the patched floor) are unchanged. So:

- **They do not weaken any fix.** The floor is untouched; `check-override-consistency.mjs` (key's upper
  bound == value's lower bound) still holds for all five.
- **They do not strengthen any fix either.** No advisory is closer to closed by allowing a higher major.
- **What they actually do is a silent cross-major substitution of a transitive.** A pnpm override REPLACES
  the dependent's spec for any version the key matches. A dependent that asked for `nanoid@^3` and resolved
  into the vulnerable span would be handed `>=3.3.18 <7` — i.e. **nanoid 6**, a different major its author
  never declared support for (nanoid 6 also requires node `^22 || ^24 || >=26` and is ESM-only).

**This was already measured and decided once.** Commit `fc3c47ae` (the js-yaml/nanoid floor raise): *"Both
js-yaml overrides are bounded to their major ('>=4.3.1 <5', not '>=4.3.1'). Left unbounded, the first
attempt resolved js-yaml to 5.2.3 — a silent major bump of an @expo/xcpretty transitive. Every other
override in this file bounds its major."* Renovate's npm manager reads `undici@<6.27.0` as an opaque
depName and the value as a version range (the same blindness `check-override-consistency.mjs`'s header
records for the key half), so it "widens" the range to include the newest major as if it were a direct
dependency.

**Decision.** Reject all five. Make the rejection durable rather than weekly: a Renovate packageRule that
disables `major` updates for `pnpm-workspace.yaml` override entries, plus a guard (extend
`check-override-consistency.mjs`) that fails when a keyed override's value cap exceeds `<(key major)+1`.
A genuine floor raise (a new advisory) is still a `minor`/`patch` on the value and stays proposable —
and the `vulnerabilityAlerts` path is untouched. This is US5's first PR (it is config + guard, no lockfile
churn), and it removes five of the 21 members of the js-majors group.

---

## R3. CI actions — two known traps, one of them already measured in this repo

- **`actions/upload-artifact` v4+ is not supported on this forge — measured three times.** `specs/023`
  (cd-deploy: "`upload-artifact@v4` unsupported on Forgejo → merged build+deploy into one job, no
  artifact"), `specs/042` research ("`GHESNotSupportedError`; v3 only"), `specs/048` tasks. Renovate
  proposes v3→v7 regardless. The runner has since moved to `forgejo-runner` v12 (openwiki
  server-setup §7), so the premise is **re-tested, not assumed** (§11, M1): a probe job uploads with the
  target major on a throwaway branch. Expected outcome on the evidence: still unsupported → `upload-artifact`
  is held at v3 by an `allowedVersions: "<4"` packageRule with the measured error as its description, which
  discharges it as a *recorded* hold, not a silent drop.
- **The node24 action runtime.** checkout/setup-node v5+ declare `using: node24`. The `ubuntu-latest` label
  maps to `docker://node:22-bookworm` (specs/023 research) and the `kvm` label runs on the host; whether
  forgejo-runner v12 executes `node24` actions in both is measured by the same probe (M1).
- **`java-jdk 17 → 25` is an Android toolchain decision, not a CI-action one.** It lives inside
  `setup-java`'s `with:` and Renovate would carry it in the same branch. The JDK must match what the
  Expo SDK's Gradle/AGP supports; it is held at 17 in US1 and re-decided in US4 against SDK 57's template.
- **The split.** PR 1a: checkout, setup-node, upload-artifact (the three node-runtime actions every job
  touches). PR 1b: setup-java, setup-android, setup-uv, paths-filter, pnpm/action-setup. `paths-filter` sits
  in 1b deliberately: if its major changes output semantics, a skipped job reads as a pass, so 1b's
  verification includes a forced non-skip (§plan).

**Sequencing.** Feature 080 (MinIO→RustFS) rewrites `.forgejo/workflows/app-ci.yml` and others; US1 starts
only after 080 has merged, so the two never conflict line-for-line and US1's red is attributable.

---

## R4. Expo — the target is SDK 57 / RN 0.86.3; SDK 58 is pre-release and changes the jest picture

`bundledNativeModules.json` from the published tarballs (NPM):

| | SDK 56 (56.0.23) | **SDK 57 (57.0.27, `latest`)** | SDK 58 (58.0.7, `next`, 2026-10-09) |
|---|---|---|---|
| react-native | 0.85.3 | **0.86.3** | 0.88.0-**rc.4** |
| react | 19.2.3 | 19.2.3 | 19.3.0 |
| reanimated / worklets | 4.3.1 / 0.8.3 | 4.5.1 / 0.10.1 | 4.7.0 / 0.13.0 |
| gesture-handler | ~2.31.1 | ~2.32.0 | ~3.2.1 |
| screens / safe-area | ~4.26.0 / ~5.7.0 | ~4.26.0 / ~5.7.0 | ~4.28.0 / ~5.9.1 |
| async-storage | 2.2.0 | **2.2.0** | **2.2.0** |
| jest-expo | ~56.0.5 | ~57.0.5 | ~58.0.9 |
| expo-router | ~56.2.21 | ~57.0.25 | ~58.0.17 |

Companion metadata (NPM), re-checking item #254's correction:

| | jest-expo deps | jest-expo peer `@react-native/jest-preset` | babel-preset-expo peer `@babel/runtime` | eslint-config-expo peer `eslint` |
|---|---|---|---|---|
| 56.0.5 / 56.0.20 / 56.0.4 | jest **29** family | ^0.85.0 | ^7.20.0 | >=8.10 |
| **57.0.5 / 57.0.14 / 57.0.2** | jest **29** family | ^0.86.3 | **^7.20.0** | >=8.10 |
| 58.0.9 / 58.0.12 / 58.0.4 | jest **30** family + **peer `jest ^30.0.0`** | ^0.88.0-rc.4 | **^7.20.0** | >=8.10 |

**Conclusions.**

1. **Target = SDK 57 (RN 0.86.3).** SDK 58 is on `next` with a release-candidate React Native; it is not a
   target for this feature. The item's correction holds: SDK 57 is the 0.86 line.
2. **PR #217's 15 Tamagui press-event errors (RN 0.87 narrowing) are NOT in scope for SDK 57** — 0.86 is
   below the narrowing. They become in scope at SDK 58 (RN 0.88). US4 still *measures* this: `nx typecheck`
   after the SDK move, with zero new press-event errors as the expectation.
3. **jest 30 unblocks at SDK 58, not 57.** jest-expo@58 moves to the jest 30 family and *peers* `jest ^30` —
   so at 58 the jest major is not optional, it is required. The re-check rule (FR-016) fires at SDK 58.
4. **babel 8 stays blocked through SDK 58.** `@babel/runtime ^7.20.0` at 56, 57 and 58, and the preset's
   ~45 plugin deps are all `^7.x`. `@babel/core` 8 also requires node `^22.18 || >=24.11` (fine for CI's
   24.19).
5. **async-storage 3 is blocked on Expo through SDK 58** (bundled 2.2.0 at all three); a native module
   outside `bundledNativeModules` breaks `expo install --check`.
6. **SAST allowlist entries are NOT discharged by SDK 57** (re-verified):
   - **node-forge (item #633, `GHSA-86w9-cpqp-85rv`, `<= 1.4.0`, no patched version)**: `@expo/cli@57.0.28`
     (what `expo@57.0.27` depends on) still declares `node-forge ^1.3.3`; `@expo/cli@58.1.6` raises it to
     `^1.4.0`, which is still inside the vulnerable range. Neither SDK discharges it.
   - **braces (item #648, `GHSA-vfj7-8cjw-p6xm`, `<= 3.0.3`)**: `@expo/metro-file-map` dropped micromatch at
     57.0.4, **but** `@expo/cli@57.0.28` still depends on `@expo/metro ~56.0.2`, which pins
     `metro-file-map 0.84.5` → `micromatch ^4.0.4` → braces. At SDK 58 `@expo/metro 58.0.0-rc.0` pins
     `metro-file-map 0.87.1`, which **still** declares `micromatch ^4.0.4`. And Jest's path keeps micromatch
     until jest 30 (`jest-util@30` uses picomatch). Neither SDK discharges it; the SDK-57 PR re-dates
     nothing and deletes nothing in `security/sast/allowlist.yaml` — but MUST re-run the audit and confirm
     the two entries still match exactly `node-forge@1.4.0` / `braces@3.0.3` (a version move would re-block).
7. **The constitution pins the SDK.** `.specify/memory/constitution.md` line 346 states "Expo SDK 56 … React
   Native 0.85 and React 19.2". v1.4.0 was exactly this kind of amendment (55→56). SDK 57 requires a
   constitution MINOR amendment (2.5.0 → 2.6.0, stack guidance only) with human approval, in the same PR.

**Re-measured 2026-10-18 for US5 (T032, NPM; the SDK US4 landed is 57 — `expo ~57.0.30`).** Nothing became free.

| | SDK 57 (what `main` runs) | SDK 58 (now `latest`, not our target — OQ-1) | US5 consequence |
|---|---|---|---|
| `expo` dist-tags | `sdk-57` = 57.0.30 | `latest` = **58.0.14** (stable since R4's `next` 58.0.7), `next` = 58.0.11 | SDK 58 is the trigger for the jest re-check, not a target here |
| jest-expo (newest of the line) | **57.0.6** (2026-10-12): `babel-jest`, `@jest/globals`, `jest-snapshot`, `jest-environment-jsdom` all **^29.2.1**; peer `@react-native/jest-preset ^0.86.3` | 58.0.11: the same deps at **^30.0.0**; peer `jest` **`^29.0.0 \|\| ^30.0.0`** (R4 read `^30.0.0` on 58.0.9 — relaxed since) | jest 30 / babel-jest 30 stay **held** (approval); released at SDK 58 |
| babel-preset-expo | **57.0.16**: peer `@babel/runtime ^7.20.0`; plugin deps `^7` | 58.0.17: peer `@babel/runtime ^7.20.0` | babel 8 stays **held** through SDK 58 (`@babel/core` latest 8.0.7, node `^22.18 \|\| >=24.11`) |
| `expo` itself | 57.0.30 depends `@babel/runtime ^7.20.0` | 58.0.14 the same | — |
| eslint-config-expo | **57.0.2** (no newer 57.x; `latest` = 58.0.4): peer `eslint >=8.10`, deps `@typescript-eslint/{parser,eslint-plugin} ^8.59.0`, `eslint-plugin-react ^7.37.3`, `eslint-plugin-import ^2.30.0`, `eslint-plugin-react-hooks ^7.0.0`, `eslint-plugin-expo ^1.1.0` | 58.0.4: same set | eslint 10 is reachable (5b) — but `eslint-plugin-react@7.37.5` peers `eslint … ^9.7` and `eslint-plugin-import@2.32.0` `… ^9` (neither declares 10): **measured in 5b, not assumed** |
| `bundledNativeModules.json` async-storage | **2.2.0** (57.0.30 tarball) | **2.2.0** (58.0.14 tarball) | async-storage 3 (latest 3.1.1) stays **held** |
| `@testing-library/react-native` | latest **14.1.0**: peers `jest >=29.0.0`, `react-native >=0.78`, `test-renderer ^1.0.0`, node `^22.13 \|\| >=24` | — | still **free** for 5c (jest 29 admitted) |

M5 (`@typescript-eslint/parser`): see R5.

---

## R5. TypeScript 7 is NOT independent — it is blocked on typescript-eslint

The item's correction says TS 6→7 "is genuinely independent". Measured:

- `@typescript-eslint/parser@8.71.1` (latest, and the installed version — REPO lockfile) declares
  **peer `typescript: ">=4.8.4 <6.1.0"`**. It is reached through `eslint-config-expo` (`.eslintrc.json`
  `"extends": "expo"` in both `frontend/mcm-app` and `packages/design-system`).
- `typescript@7.0.2` ships no `main` entry (bin `tsc` only) — the native port; tools that load the compiler
  API in-process (typescript-eslint, `@nx/js`'s TS helpers) are the ones exposed.
- So TS 7 is blocked by the **lint toolchain**, not by Expo. It gets the same treatment as jest/babel:
  recorded as blocked with a re-check rule (*"typescript-eslint's parser peer range admits 7"*), and an
  approval gate in Renovate so it stops arriving weekly.

**This contradicts item #254's 2026-08-27 correction** and is reported as such.

**M5 re-measured 2026-10-18 (T032, NPM).** `@typescript-eslint/parser` `latest` = **8.71.2** (2026-10-12), canary
8.71.3-alpha.13; both, and `@typescript-eslint/eslint-plugin` / `typescript-eslint` 8.71.2, still peer **`typescript
">=4.8.4 <6.1.0"`**. `typescript` `latest` = 7.0.2, `next` = 7.1.0-dev. TS 7 stays **held** (approval, PR 5a).

## R6. eslint 8 → 10 is a config-format migration, not a version bump

- DASH proposes `^8.57.0 → ^10.0.0` (two majors; 9.39.5 is `maintenance`). ESLint 9 made flat config the
  default; ESLint 10 removes eslintrc support. Both projects use `.eslintrc.json` and the lint target passes
  `--ext` (`frontend/mcm-app/project.json:36`), a flag flat config removes.
- `eslint-config-expo` peers `eslint >=8.10` at 56/57/58 and ships a flat entry point; `@typescript-eslint`
  8.71.1 peers `eslint ^8.57 || ^9 || ^10`. So eslint 10 is reachable at SDK 57 **without** TS 7.
- Requires node `^20.19 || ^22.13 || >=24` and a `jiti` peer for TS config files (only if the config is
  written in TS — it need not be).

**Measured at US5b (PR 5b), 2026-10-18.** REPO = `origin/main` `62556d3b`; NPM = the packuments of `eslint`,
`eslint-config-expo`, its plugins, and `@eslint/compat`.

- **Version: `^10.12.0`, not 10.13.0.** 10.13.0 (2026-10-16) is inside Renovate's 3-day cooldown. 10.12.0
  (2026-10-02) was already in the lock as `@nx/eslint`'s auto-installed peer, so pnpm reused it and resolved nothing
  new for eslint itself.
- **eslint-config-expo's plugins are NOT eslint-10 ready.** This is the R6 gap.
  - eslint-config-expo 57.0.2 (the newest 57.x) and 58.0.4 (`latest`) both peer `eslint >=8.10`.
  - But they depend on `eslint-plugin-react@^7.37.3`, whose newest is 7.37.5 (2025-04-03), peering
    `eslint … ^9.7`.
  - They also depend on `eslint-plugin-import@^2.30.0`, whose newest is 2.32.0, peering `… ^8 || ^9`.
  - Upgrade RED (T038) was `ESLint couldn't find an eslint.config.* file` on both projects.
  - With a plain flat config, every file then failed to load:
    `react/display-name: contextOrFilename.getFilename is not a function`. ESLint 10 removed `context.getFilename()`.
  - **Bridge: `@eslint/compat@2.1.1`** (`fixupConfigRules`; peer `eslint ^8.40 || 9 || 10`). It restores
    `getFilename`/`getCwd`/`getSourceCode`/`parserOptions` on the rule context and changes no rule. `pnpm peers
    check` still reports the two plugins' eslint peer, as expected.
  - **Re-check:** drop `@eslint/compat` when both plugins, as eslint-config-expo ships them, declare eslint 10.
  - **Alternative not taken:** eslint 9.39.5 (`maintenance`) has every peer clean and needs no shim. It was not
    taken because 9.x is the maintenance line and US5's target is the current major.
- **The flat preset is not the legacy preset re-expressed.** `--print-config` on the same file, `main` vs flat:
  - **15 rules are stronger**: `react/*` takes `flat.recommended` (display-name, jsx-uses-react/vars,
    no-danger-with-children, no-deprecated, no-direct-mutation-state, no-string-refs and require-render-return go
    warn → error). jsx-key, jsx-no-comment-textnodes, no-children-prop, no-find-dom-node, no-is-mounted and
    no-render-return-value are new errors, and `import/no-named-as-default` becomes a new warning.
  - **0 rules are weaker.** 9 core rules differ only in ESLint 10 spelling out its default options.
  - **Turned off for parity with main (each off or absent on `main`), because they report on today's code:**
    - `reportUnusedDisableDirectives` (ESLint 9+ default `warn`): 9 findings;
    - `react/no-unescaped-entities`: 4 errors;
    - `import/no-duplicates`: 10 warnings;
    - `import/no-named-as-default-member`: 14 warnings, all `axios.create` / `axios.isAxiosError`.
    - Enabling them is a separate change: 33 findings in mcm-app, 0 in design-system.
- **Scope kept identical.** Flat config cannot narrow extensions from the CLI, so `*.{js,jsx,mjs,cjs}` are globally
  ignored. That matches `--ext .ts,.tsx`: the linted file sets are byte-identical to `main` (mcm-app 356, design-system
  59). `tests/` stays unlinted, so the pre-existing rules-of-hooks error in `tests/app/(app)/_layout.test.tsx` is
  still out of scope.
- **Result (T039 GREEN):**
  - mcm-app 0 errors / 43 warnings. `main` also has 0/43, the **same 43 at the same file:line:rule** (5
    `no-require-imports`, 5 `no-unused-vars`, 33 `import/first`).
  - design-system 0/0 (`main` 0/0).
  - typecheck 0 errors; jest 131/131 and 1578/1578.
- **T040 mutation:** `var` in `src/utils/errors.ts` and an un-keyed, undefined `<Text>` in a design-system
  component made lint FAIL on both projects (`no-var`; `react/jsx-key` + `react/jsx-no-undef`). Then reverted.
- **Lock:** eslint family only. eslint 8.57.1 and its private tree leave (24 packages). `@eslint/compat` 2.1.1
  arrives. 14 snapshots re-key from the `eslint@8.57.1` peer to `eslint@10.12.0`. Every override resolves as before,
  and the pnpm-audit findings are identical (12 on both).

**Measured at US5c (PR 5c), 2026-10-19.** REPO = `origin/main` `8ea70cab`; NPM = the packuments of
`@testing-library/react-native`, `test-renderer`, `react-reconciler`, `react`; DOCS = RNTL 14.1.0's own
`docs/guides/migration-v14.md` (shipped in the tarball).

- **Version: `^14.1.0`** (2026-10-08, past the 3-day cooldown; 14.0.0 was 2026-06-05). Peers `jest >=29.0.0`
  (jest 29 stays — the jest 30 hold, item #792, is untouched), `react >=19.0.0`, `react-native >=0.78`,
  `test-renderer ^1.0.0`; node `^22.13 || >=24`. Deps `pretty-format`/`jest-matcher-utils ^30.4.1` were already
  in the lock.
- **`test-renderer ~1.2.0`, not `^1`.** `^1` resolves 1.3.1, which depends on `react-reconciler ~0.34.0`; 0.34.0
  peers **`react ^19.3.0`** and we run React 19.2.3 (SDK 57). The migration guide's own table maps React 19.2 →
  `test-renderer@1.2` (→ `react-reconciler 0.33.0`, peer `react ^19.2.0`). **Re-check:** move to the 1.3 line
  with React 19.3 (an Expo SDK bump). `react-test-renderer` stays in the lock — `jest-expo` 57 depends on it —
  but nothing in our tests imports it.
- **Upgrade RED (T041):** design-system 98/131 failed (11/14 suites), mcm-app 525/1578 failed (62/154 suites):
  `getByTestId is not a function`, `Cannot read properties of undefined (reading 'current')`,
  `` `render` function has not been called ``, `rerender is not a function`, `UNSAFE_getByType is not a function`.
- **Migration (T042), per the guide's "Async APIs by Default" and "Removed APIs":** `render`/`renderHook`/
  `fireEvent(.*)`/`act`/`rerender`/`unmount` awaited, and every local helper wrapping them made async (75 files,
  AST rewrite). Four hand fixes: two `expect(() => render(…)).not.toThrow()` → `await expect(render(…)).resolves`
  (the sync form would pass vacuously); `UNSAFE_getByType(Modal|ScrollView)` → `container.queryAll` on the host
  types `Modal`/`RCTScrollView`; one "initial `isLoading` true" test holds its fetch open (async `renderHook`
  flushes a resolved one — the guide's "transient states" note). No test deleted or skipped.
- **Result:** 131/131 and 1578/1578, 0 skipped; `act(...)` warnings in the mcm-app run 143 → 0; lint 0/43 and 0/0
  (unchanged); typecheck 0.
- **Coverage (mcm-app, same command both sides):** lines 61.34% = 61.34% (3279/5345), functions unchanged,
  statements 3603 → 3598, branches 1852 → 1847. The 5 are five double-submit latches
  (`if (decided|confirmed|actioned) return`) in `approval-request`, `import-preview`, `multi-select-options`,
  `render-movie-card`. v13 delivered a second `fireEvent.press` to a button already `disabled`; v14 honours the
  responder/`disabled` contract, so the second press stops at the button — the tests' "second press ignored"
  assertions still hold, now for the reason their titles give. Overlapping presses (`Promise.all`) do not reach
  the latches either (both read the stale `false`). design-system unchanged (90.55% lines). The ≥70% target
  stays with item #779.
- **Lock:** RNTL family only — `@testing-library/react-native` 13.3.3 → 14.1.0, `test-renderer` 1.2.0,
  `react-reconciler` 0.33.0, `@types/react-reconciler` 0.33.1 added. Every override resolves as before; pnpm
  audit identical (9 on both).
- **CI flake on PR #798 (first run): not caused by RNTL 14.** `app-ci / affected` failed one test,
  `movie-detail-screen.test.tsx` › "renders MovieDetail when movie is loaded": `Exceeded timeout of 5000 ms`, suite
  23.3 s, jest at default workers under `nx affected`. It is the first test in the file to render `MovieDetail`, so
  it pays that module graph's cold transform. This is the known flake from feature 015 (`c236106f`), and it has no backlog
  item. Measured locally, one at a time:
  - **`--maxWorkers=1`, warm cache, 6 runs each:** branch 144–175 ms, `main` 139–143 ms. 12/12 every run.
  - **`--no-cache` (cold, the CI shape), 3 runs each:** branch 1229–1288 ms, `main` 1267–1313 ms. RNTL 14 is not slower.
  - **Full suite, `--maxWorkers=2 --no-cache`:** branch 25 ms (1578/1578, 19.9 s), `main` 24 ms (1578/1578, 23.1 s).

  The test body is a single `await render` plus one synchronous `getByTestId`, with no `waitFor`/`findBy`, so it has
  no async misuse to fix. Its cost is the cold first render, multiplied by CI contention. Re-run, not changed.

## R7. Stage 6 is copilotkit + AG-UI first, then openai / ai-sdk — and the latter are not on the model path

- `@copilotkit/runtime` and `@copilotkit/react-native` pin `@ag-ui/client` **exactly**: 1.70.1 → `0.0.59`
  (= the app's direct pin), 1.77.0 → `1.0.1`, 1.78.0 → `1.0.2` (NPM). **`@ag-ui/client` 1.x therefore
  cannot move without copilotkit**, and copilotkit cannot move without it (two copies of the AG-UI client
  across the BFF↔client boundary is the AG-UI-native principle's failure mode). They are one PR.
- copilotkit ships breaking changes in minors (renovate.json rule, PR #263: removed `useRenderToolRegistry`,
  partial `render({ args })`). The upgrade target is whatever is latest at stage start (1.78.0 today), taken
  through the dashboard approval tick.
- `openai` and `@ai-sdk/openai` are **not imported anywhere** in `frontend/` (REPO grep). They were added by
  `89ec0dae` as *"eager-import satisfiers (unused — we use the empty adapter)"* for `@copilotkit/runtime`.
  The model call path is the Python agent gateway, not these packages. Consequences:
  - The `@model-decision` tier is the wrong instrument for them: a regression here is a **module-resolution
    failure at BFF start / first agent route load**, which the `@gate` tier and the BFF runtime-module
    pruning test (`prune-bff-runtime-modules.test.mjs`, the lazy `__require("openai")` reach) are built to
    catch.
  - `@copilotkit/runtime@1.78.0` declares `@ai-sdk/openai ^3.0.36` as **its own dependency** and `openai`
    as a peer `^4.85.1 || >=5.0.0` (openai 7 satisfies it). So the app's `@ai-sdk/openai` 4 would NOT be
    the copy copilotkit loads — moving it to 4 changes nothing copilotkit uses. Research question for the
    stage (M7): is the app's direct `@ai-sdk/openai` still needed at all after copilotkit ≥1.77? If not, it
    is **removed**, which is a stronger outcome than bumping a dead dependency.
  - `openai@7` declares peer `undici >=5 <9` and node `>=22`. Its interaction with the `undici@<6.27.0`
    override is checked (M7) — the override only acts on resolutions inside `<6.27.0`, so it should not
    affect a peer satisfied by 6.29/7.29, but that is measured, not assumed.
- **Stronger verification, because the model tier is non-blocking**: run the `@model-decision` tier on the
  branch via `workflow_dispatch` and compare its counts to the latest `main` run (no new failures beyond
  `main`'s own), plus the keyless golden replay gate, plus a BFF-container smoke that loads the agent route
  in the **prod** (pruned) image — the shape that has broken before.

## R8. Docker majors — MongoDB 9 is the only true pending stateful major; postgres and vault are held

- **MongoDB 8.0 → 9.0.** Two production stores run this image: the mc-service movie store (replica set,
  keyfile auth — *user data, must be preserved*) and the BFF store (backup/agent config; Node driver
  `mongodb@7.7.0`, REPO lockfile). The Rust driver is `mongodb 3.9.1`. ADR-0002's discipline applies:
  premise first (infra-image scan of the 9.0 digest with the gate's own criteria; driver compatibility for
  both drivers; the upgrade path and featureCompatibilityVersion steps), an **explicit data decision**
  (preserve — there is no acceptable wipe of the movie store), and rollback by tested restore.
  `renovate.json` already requires a dashboard tick for this major (PR #705).
  The constitution's stack line (line 253) names `mongodb-community-server:8.2.6-ubuntu2204-slim`, which is
  already stale against the 8.0.8-ubi9 actually run; the Mongo PR amends it.
- **MongoDB — T054 (M8) + T055 outcome, measured 2026-10-20: SUPPORTED, no blocker; target `9.0.4-ubi9`.**
  `www.mongodb.com` does not resolve in the sandbox, so every upstream citation below is the docs **source**
  in `github.com/mongodb/docs` at commit `b5c8fd24bcd2476778067bb0798fa5dfa45e9ff0` (branch `main`, which
  builds the current manual — it carries the 9.0 release notes); paths are relative to
  `content/manual/manual/source/` unless stated. Line 349's "constitution line 253" is now **line 254**.

  **Upgrade path — a direct 8.0 → 9.0 binary move is supported; no pass through 8.1/8.2/8.3.**
  - `includes/9.0-upgrade-guidance-checklists.rst` (rendered with `includes/9.0-upgrade-from-8.0-replacements.rst`,
    oldversion=8.0, olderversion=8.3): *"To upgrade an existing MongoDB deployment to 9.0, you must be running
    a 8.0 or 8.3 release."* 9.0 has a dedicated page `release-notes/9.0-upgrade-from-8.0.txt` ("Upgrade 8.0 to
    9.0") beside the 8.3 → 9.0 one. No minimum 8.0 **patch** is stated for the upgrade (only for downgrade,
    below), so 8.0.8 qualifies.
  - **Because 8.0 → 9.0 skips the rapid releases, their compatibility notes apply too** — read
    `release-notes/8.2-compatibility.txt` (which embeds 8.1's) and `8.3-compatibility.txt` as well as
    `9.0-compatibility.txt`; see "codebase impact" below.
  - **Prerequisite: FCV must be `"8.0"`** (`9.0-upgrade-from-8.0.txt`: *"the 8.0 deployment must have
    featureCompatibilityVersion set to 8.0"*). Check on each store with
    `db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 })`. **Not yet measured on our stores**:
    a volume first created on an older major and carried forward could still be at `"7.0"` — T056/T059 must
    read it first, and if it is not `"8.0"`, run `setFeatureCompatibilityVersion: "8.0", confirm: true` on
    8.0.8 before any image move.

  **FCV steps and order** (`release-notes/9.0-upgrade-from-8.0-replica-set.txt`, `…-standalone.txt`):
  1. On 8.0.8: confirm FCV `"8.0"` (above). Replica set: `replSetGetStatus` shows no member in ROLLBACK/RECOVERING.
  2. **Binary swap first**: `db.adminCommand({ shutdown: 1 })` → replace the binary (here: the image digest) →
     restart. For a replica set the documented rolling order is secondaries one at a time → `rs.stepDown()` the
     primary → upgrade it. **The movie store is a single-member set (`rs0`)**, so there is no secondary and no
     step-down: shut the one member down, start it on 9.0.4, and it re-elects itself primary (same as the
     standalone procedure, plus `rs.status()` showing PRIMARY before step 3). The BFF store is standalone
     (`mongod --auth --bind_ip_all`, `bff/compose.prod.yaml`) — the standalone page applies verbatim.
  3. **FCV raise last, after a burn-in**: on the primary/standalone,
     `db.adminCommand({ setFeatureCompatibilityVersion: "9.0", confirm: true })` — *"If you omit the confirm
     parameter or set confirm to a value other than true, the command fails"*; idempotent, safe to retry. On a
     replica set it *"implicitly performs a replSetReconfig to add the term field to the configuration
     document"*. `includes/featureCompatibility-caveat.rst`: *"It is recommended that after upgrading, you
     allow your deployment to run without enabling these features for a burn-in period … When you are
     confident that the likelihood of downgrade is minimal, enable these features."* — this is plan.md's
     "FCV raise only after soak".
  - **Rollback consequence (load-bearing for T056)**: `release-notes/9.0-downgrade-to-8.0.txt` +
    `includes/downgrade/latest-patch-release.rst`: *"If you need to downgrade from 9.0, downgrade to the latest
    patch release of 8.0."* So a **binary** downgrade onto the same volume is supported only to the newest
    8.0.x (8.0.34 on Docker Hub today), **not to 8.0.8**, and only after FCV is set back to `"8.0"`. Rollback
    to 8.0.8 is therefore **restore-from-backup onto a fresh 8.0.8 volume**, never "point the old image at the
    upgraded volume" — which is exactly T056's restore rehearsal; it must not be shortened to an image revert.

  **Driver support — both ✓ (full support) for server 9.0.** Source: `content/drivers/source/includes/compatibility/`
  `rust/mongodb-compat.rst` and `nodejs/mongodb-compat.rst` (legend `mongodb-compat-legend.rst`: ✓ = *"All
  features are supported"*; ⊛ = *"will work … but not all new MongoDB features are supported"*).

  | Driver | Locked (REPO) | Table row | MongoDB 9.0 |
  |---|---|---|---|
  | Rust `mongodb` (mc-service) | **3.9.1** (`Cargo.lock`; `Cargo.toml` `mongodb = "3"`, `bson` 2.15.0) | `3.9` | **✓** (footnote: no OCSP — unused here). 3.6–3.8 are only ⊛ |
  | Node `mongodb` (BFF) | **7.7.0** (`pnpm-lock.yaml`; `frontend/mcm-app/package.json` `^7.3.0`) | `7.6 to 7.7` | **✓**. 7.3–7.5 are only ⊛ |

  Note the specifier `^7.3.0` still admits ⊛ versions: the lockfile, not the range, is what gives full support.

  **Image — `mongodb/mongodb-community-server:9.0.4-ubi9`** (same family as today's `8.0.8-ubi9`: Red Hat UBI 9,
  `-ubi9`, not `-slim`/`-ubuntu2204`). Resolved from Docker Hub's tag API
  (`hub.docker.com/v2/repositories/mongodb/mongodb-community-server/tags/<tag>`), never constructed:

  | Tag | Index digest | linux/amd64 manifest | OS | last_updated |
  |---|---|---|---|---|
  | `8.0.8-ubi9` (current) | `sha256:784dd73b701c3fb846876394c8137a9b42c35791ed1c8a931d8efa2cb0c8dd81` | `sha256:c030553a…` | RHEL 9.6 | 2025-08-01 |
  | `9.0.4-ubi9` = `9.0-ubi9` | `sha256:35497f8379df6f6f57f2498784f6ed6cdf9893d81a7fb0e02d1498a0b63c6e44` | `sha256:1ace2d8d84ca3a034a3b3950fcbceb41a64a8baf0f00a1752955b07782662a71` | RHEL 9.8 | 2026-10-19 |

  9.0.4 (2026-10-13, `release-notes/9.0.txt`) is the newest 9.0 GA and fixes SERVER-133518 (a sharded-only
  step-up hang in 9.0.0–9.0.2). In-image check: `mongod --version` → `v9.0.4`, `mongosh` 2.6.0 present (the
  compose healthchecks and the `mc-service-store-init` entrypoint call `mongosh`), runs as uid 1000 `mongod`,
  same `docker-entrypoint.py` entrypoint as 8.0.8. **New fact for T057/Renovate**: unlike `8.0.8-ubi9` (static
  since 2025-08-01), `9.0.4-ubi9` is **rebuilt daily** — each build also gets an immutable dated tag
  (`9.0.4-ubi9-20261019T064506Z` = the digest above; 10-18's was `sha256:3165ae24…`). A `tag@digest` pin is
  still correct (the digest is what pulls), but expect Renovate digest-refresh PRs at that cadence.

  **Codebase impact of 8.1 → 9.0 compatibility notes (REPO grep of `backend/`, `frontend/mcm-app/src/bff-server/`,
  `agents/`, `mcp-servers/`) — nothing breaks; one item to exercise in T056/T058.**
  - **SERVER-89953 (9.0 Known Issues, open)**: *"At FCV 9.0, listIndexes reports `collation: { locale: "simple" }`
    for indexes that use simple collation"*, which makes ODMs (Mongoose `syncIndexes()`) drop and rebuild
    unchanged indexes. This repo uses no ODM and never calls `listIndexes`/`syncIndexes`: mc-service's
    `adapters/mongodb/indexes.rs` re-issues `createIndexes` with explicit names at every start (two collation
    indexes `en`/strength 2, the rest simple) and drops only the two retired names (`movie_text_search` — the
    old `$text` index — and `sort_title_year`); the BFF's `mongo-client.ts` does `createIndex` once per process.
    `createIndexes` with an identical spec is a server-side no-op, so this should not bite — but it is the one
    path that touches index metadata, so **T056 must restart mc-service and the BFF against the upgraded volume
    after the FCV raise** and confirm both index passes succeed with the index list unchanged (a fresh-volume
    integration run alone would not exercise "pre-existing index at FCV 9.0").
  - Not used here, so no impact: server-side JS (`$where`/`$function`/`$accumulator`/`mapReduce` — 9.0 moves it to
    WASM/UTC dates), empty-field-name `$group` accumulators (only `$lookup`/`$match`/`$count` in `main.rs`'s orphan
    check), `$map`/`$filter`/`$reduce` array-index access (8.3), wildcard indexes (8.3), `$$CLUSTER_TIME` on a
    standalone (8.2), hedged reads (removed 8.1), change streams/read-preference changes, views, Queryable
    Encryption, cross-database `renameCollection`, sharding. The 8.1 driver incompatibility is JVM ≤3.x / .NET
    ≤2.14.1 only. `net.wireObjectCheck`/`--objcheck` are deprecated in 9.0 — neither compose passes them.
  - Absorbed without change: the cascade-delete transaction (`collection_repository.rs` `start_transaction`) is
    far under 9.0's new `maxConcurrentMultiDocumentTransactions` default (10000); the new per-operation memory cap
    (≥ 1 GB) is irrelevant at this data size; the case-insensitive `$regex` search and compound keyset cursors
    use only long-standing operators.

  **T055 — the scan: 9.0.4-ubi9 has 0 blocking findings vs 8.0.8-ubi9's 8. Premise holds.** Instrument checked
  against the gate: `.forgejo/workflows/infra-image-scan.yml` installs `TRIVY_VERSION=v0.74.0`;
  `scripts/infra-image-scan.mjs` `scanImage()` runs `trivy image --format json --no-progress --scanners vuln
  <ref>` and `normalizeTrivy()` marks a finding **blocking** iff Critical **and** a FixedVersion exists — i.e.
  exactly `--severity CRITICAL --ignore-unfixed`. Ran locally with `aquasec/trivy:0.74.0`,
  `--image-src remote --platform linux/amd64`, both the gate's full invocation **and** the
  `--severity CRITICAL --ignore-unfixed` form, then fed the full JSON through the gate's own
  `loadSeverityMap()` + `normalizeTrivy()` (imported from the script, not re-implemented). DB:
  `ghcr.io/aquasecurity/trivy-db:2`, UpdatedAt **2026-10-20 01:16 UTC** (`mirror.gcr.io` does not resolve here).

  | Image | Blocking (gate) | Unique advisory | Fixable High | All findings (H/M/L) |
  |---|---|---|---|---|
  | `8.0.8-ubi9@sha256:784dd73b…` | **8** | CVE-2025-68121 Go stdlib v1.23.8 (fix 1.24.13/1.25.7) in the 8 bundled database-tools binaries (`bsondump`, `mongodump`, …) — the seed allowlist entry | 431 | 457 / 1022 / 391 |
  | `9.0.4-ubi9@sha256:35497f83…` | **0** | — (0 Critical of any kind; Go stdlib v1.26.8) | 32 | 197 / 4280 / 2310 |

  The two forms agreed (8 vs 0). **Consequence for T057**: the seed entry `mongodb/mongodb-community-server:8\.0\.8-ubi9`
  / `CVE-2025-68121` in `security/infra-images/allowlist.yaml` is **discharged** and must be **deleted** in the
  same PR (re-keyed it would match nothing and fail UNMATCHED ENTRIES). **CI evidence**: the workflow has **no
  `workflow_dispatch`** (triggers: Tue/Fri cron, path-filtered push, every PR), so there is no dispatch that
  scans a not-yet-referenced image; the authoritative CI scan of this digest is the `infra-image-scan` job on
  T057's own PR, which runs Trivy because the compose refs change. This entry is a local scan with the gate's
  pinned version, flags and normalizer — not a CI run.
- **Observability postgres 16** is held by `allowedVersions: "<17"` because one pin backs both
  `langfuse-postgres` and `unleash-postgres`, and `langfuse-postgres-shared-pin.guard.test.mjs` asserts it.
  It stays in scope as its own PR, moving **both** databases together, updating the guard **at its cause**
  (the premise becomes "both move together on one pin", not deleted), lifting the hold in the same change.
  ADR-0002 §4 lets Langfuse traces be discarded; it says nothing about Unleash flag state, which is
  preserved (dump/restore) — the operator confirms (OQ-3).
- **Vault 1.18** is held below 1.19 because every newer tag scanned was strictly worse (net +1 Critical,
  pgx). In scope as a **scan-gated** task: scan the current 1.x/2.x tag with the gate's criteria; move only
  if it clears libcrypto3 + grpc without adding pgx; otherwise the hold is re-recorded with the new scan
  date and digest. Vault is dormant (ADR-0001), so its value is lowest and it goes last.
- **Vault — T063 outcome (a), measured 2026-10-20: the hold is LIFTED, the refs move to 2.2.** Tags and
  digests resolved from Docker Hub's tag API (multi-arch index digests; scanned `--platform linux/amd64`).
  Scanner: `aquasec/trivy:0.74.0` (the gate's pinned `TRIVY_VERSION=v0.74.0`), `trivy image --severity
  CRITICAL --ignore-unfixed --scanners vuln`, DB from `ghcr.io/aquasecurity/trivy-db:2` (UpdatedAt
  2026-10-19 19:08 UTC — `mirror.gcr.io` does not resolve in the sandbox). Fixable Critical = the gate's
  `blocking` (`normalizeTrivy`: Critical with a FixedVersion).

  | Tag | Digest (index) | OS | Fixable Criticals (unique advisory — package installed → fix) |
  |---|---|---|---|
  | `1.18` (current = 1.18.5) | `sha256:750bb37c1638fa194ab37053a81618c61bb0491ddec6fccac87c07a8e6cd8166` | alpine 3.21.3 | **3**: CVE-2025-68121 stdlib v1.23.6; CVE-2026-31789 libcrypto3+libssl3 3.3.3-r0 → 3.3.7-r0; CVE-2026-33186 grpc v1.69.4 → 1.79.3 (all seed-allowlisted) |
  | `1.21.4` (newest community 1.x; 1.21.5+ are Enterprise-only) | `sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569` | alpine 3.23.3 | **4**: CVE-2026-31789 libcrypto3+libssl3 3.5.5-r0 → 3.5.6-r0; CVE-2026-33186 grpc v1.75.1; CVE-2026-33815 + CVE-2026-33816 pgx/v5 v5.7.6 → 5.9.0 — unchanged since PR #289 |
  | `2.2.0` = `2.2` = `latest` (newest 2.x, 2026-10-15) | `sha256:e0acd3c681bdf57f002d7214e5d050b876e1704678005c6b0406dd96a65be919` | alpine 3.24.2 | **0** — and 0 High of any kind (full scan: 1 Medium, 1 Unknown). libcrypto3/libssl3 3.5.8-r0, grpc v1.83.2, pgx/v5 v5.10.0, Go 1.27.2 |

  2.2.0 clears libcrypto3 + grpc without adding pgx, so FR-013's condition is met by a scan. Changes:
  both refs (`vault/compose.yaml`, `vault/compose.prod.yaml`) → `hashicorp/vault:2.2@sha256:e0acd3c6…`; the
  three `hashicorp/vault:1\.18` seed entries in `security/infra-images/allowlist.yaml` **deleted** (a
  re-keyed entry would match nothing → UNMATCHED fails the gate); `renovate.json`'s `<1.19` ceiling replaced
  by a vault **major-approval** rule (the opensearch/langfuse shape — patch/minor stay automatic and
  scan-gated, and with no vault allowlist entry `infra-image-scan` blocks any worse tag);
  `renovate-workflow.guard.test.mjs` updated at the cause (no ceiling on any track; the approval successor;
  no widening onto caddy/otel-lgtm; refs digest-pinned 2.x and no vault allowlist entry), mutation-RED on
  seven mutations (ceiling restored, approval removed, rule widened to all docker, approval on every track,
  a vault allowlist entry added, prod ref back to 1.18, digest dropped) before GREEN (152/152, 0 skipped).
  **Upgrade notes read** (`CHANGELOG.md` 1.19.0 → 2.2.0; developer.hashicorp.com does not resolve here):
  nothing breaks this config. 1.20.0 makes `disable_mlock` mandatory for raft — `vault.hcl` already sets
  it; 2.0.4 rejects duplicate HCL attributes — none; 2.0.0 authenticates `sys/rekey`/`generate-root` by
  default — not used by a dormant Vault; 2.2.0 changes the container's `cap_ipc_lock` handling (its notes
  carry both a remove and a set line) — the compose keeps `cap_add: IPC_LOCK` and `disable_mlock = true`,
  which is correct either way. **Verified locally** on 2.2.0 with the prod `vault.hcl` (throwaway
  container + volume, removed): comes up uninitialized + sealed, the compose healthcheck's `wget` passes,
  one vault process, 0 errors; init (1/1) → unseal → kv-v2 write → restart → sealed → re-unseal → read back
  held on raft. Also without `IPC_LOCK`: single process, no double-start. Dev posture (`server -dev`,
  `VAULT_DEV_ROOT_TOKEN_ID`, as `vault/compose.yaml`): healthy, kv write/read OK.
  **The prod cutover shape, rehearsed**: a raft volume first opened by 1.18.5 (uninitialized, as prod's
  `vault-store-data` is) → 2.2.0 on the same volume: uninitialized + sealed, healthy, 0 errors, one
  process → **rollback** to 1.18.5 on that volume: same. A dormant, never-initialized Vault holds no data,
  so the move and its rollback are both a plain image swap.
- **Already landed (discharged)**: OpenSearch 3, Langfuse 4, ClickHouse 26.x, Redis 8, Keycloak/agent-db
  postgres 18.

## R9. Cargo — bson 3 is doable; base64 0.23 and reqwest 0.13 are blocked upstream today

- **bson 2 → 3.** `mongodb 3.9.1` (= latest, CRATES) carries **both** `bson-2` and `bson-3` optional
  features; its `default = ["compat-3-0-0", "rustls-tls", "dns-resolver"]` and `compat-3-0-0 =
  ["compat-3-3-0", "bson-2"]`. So bson 3 needs `mongodb = { default-features = false, features =
  ["compat-3-3-0", "bson-3", "rustls-tls", "dns-resolver"] }` alongside `bson = "3"` — and the movie
  domain's serde/`doc!`/`Bson` usage migrated to bson 3's API. bson 3.1.0 is latest.
- **base64 0.22 → 0.23 is blocked upstream.** `bson 3.1.0` itself still requires `base64 ^0.22.1` (CRATES),
  as do mongodb, jsonwebtoken, hyper-util and axum (renovate.json rule, PR #216). Moving mc-service's own
  `base64` to 0.23 only **duplicates** the crate; it cannot replace 0.22.1.
- **reqwest 0.12 → 0.13 is blocked upstream.** reqwest is a **dev-dependency** (Keycloak ROPC token
  minting in integration tests only). `axum-keycloak-auth 0.8.3` (latest) still requires `reqwest ^0.12.12`,
  so 0.13 necessarily adds a second reqwest — which `backend/mc-service/Cargo.toml`'s own comment forbids.
  0.13 also feature-gates `RequestBuilder::form`, which the integration test targets use (PR #216 — and
  `mc-service-checks` does not build those targets, so only `app-e2e` caught it).
- **The musl/vendored-OpenSSL surface** (`openwiki/gotchas/mc-service-musl-openssl.md`): any reqwest move must
  be proven not to change what the **release** musl binary links — `cargo tree -e features --target
  x86_64-unknown-linux-musl` diff on the normal (non-dev) graph, plus the Docker `rust:alpine` build.
- **Outcome for 8b under today's facts**: the stage runs its re-check (M9); if both blockers still hold,
  each gets a backlog item with the measured reason and a re-check rule ("`axum-keycloak-auth` requires
  reqwest 0.13" / "`bson`+`mongodb` require base64 0.23"), and the dashboard approval gate stays as the
  thing that keeps them off the weekly budget. That is item #254's acceptance shape (landed, or its own item
  with a recorded reason) — not a silent deferral.

### R9 re-check (M9, T066), measured 2026-10-20

crates.io dependency endpoints (`/api/v1/crates/<c>/<max_stable_version>/dependencies`), after PR #812 landed bson 3:

| Crate (latest) | `base64` | `reqwest` |
|---|---|---|
| `bson` 3.1.0 | `^0.22.1` (normal) | — |
| `mongodb` 3.9.1 | `^0.22` (normal) | `^0.12.12` (normal, optional); `^0.12.2` (dev) |
| `axum-keycloak-auth` 0.8.3 | — | `^0.12.12` (normal) |

Both blockers stand: base64 0.23 would only duplicate the crate, and reqwest 0.13 would add a second reqwest.
Per OQ-2 each is held with its own item — item #815 (base64) and item #816 (reqwest) — and the dashboard
approval gate stays. T068 does not run.

### R9 evidence — PR 9a (bson 2 → 3), measured 2026-10-20

- **Manifest.** `mongodb = { version = "3", default-features = false, features = ["compat-3-3-0", "bson-3",
  "rustls-tls", "dns-resolver"] }` — feature names read from the `mongodb-3.9.1` `Cargo.toml` (`default =
  ["compat-3-0-0", "rustls-tls", "dns-resolver"]`, `compat-3-0-0 = ["compat-3-3-0", "bson-2"]`), so this is
  exactly the default set with `bson-2` swapped for `bson-3`. `bson = { version = "3", features = ["serde",
  "chrono-0_4", "uuid-1"] }` — bson 3.1.0 keeps the `chrono-0_4`/`uuid-1` names but makes **`serde` an optional
  feature** (mongodb's own `bson3` dependency enables it; named here so mc-service does not lean on that).
- **Verify RED (T064)**: `pnpm nx test:unit mc-service --skip-nx-cache` → **8 compile errors** in the lib test
  build: `bson::from_document` gone (2 — renamed `deserialize_from_document`), `bson::Regex { pattern, options }`
  now `CString`, not `String` (4), and the regex test's `CString == &str` / `.contains` (2).
- **A hidden second break the compiler did not report: serde_json `preserve_order`.** bson 2 enabled
  `serde_json/preserve_order`; bson 3 does not. With the bump alone, `Cargo.lock` dropped `indexmap`+`foldhash`
  from serde_json and every `json!` object went **alphabetical** — the RFC 9457 problem body would have changed
  from `type,title,status,detail` to `detail,status,title,type` on the wire, with all tests green. mc-service now
  names `serde_json = { features = ["preserve_order"] }`; `problem_body_keeps_rfc_9457_member_order_on_the_wire`
  pins the exact bytes (**mutation RED**: dropping the feature fails it, 157/1).
- **NUL in search text.** A BSON regex pattern is a cstring. bson 2 failed the whole query at serialization
  (`InvalidCString` → 500); bson 3 rejects it at `CString` construction. `escape_for_regex` now emits the PCRE
  escape `\x00` (the same literal match), and `ci_contains_regex` maps an (unreachable) conversion failure to a
  400 `ValidationError`, not a panic. Live proof: `search_with_nul_character_matches_literally_and_does_not_error`
  — the server accepts `\x00` and it matches only the stored NUL title (**mutation RED**: no escape →
  `ValidationError("Search text is not a valid pattern")`). Found on the way: the unique index's `strength: 2`
  collation treats NUL as **ignorable**, so `"Ma\0trix"` and `"Matrix"` (same year/contentType) collide (E11000).
- **Stored-document compatibility.** The stored shapes use only ObjectId, DateTime, string, i32, bool, null,
  arrays and nested documents — no `serde_helpers`, no uuid/chrono-typed fields, no Decimal/i64. Golden
  fixtures: the exact bytes **bson 2.15.0** wrote for a fully-populated `MovieDao` and a `CollectionDao` (generated
  once from a scratch crate pinned to `bson =2.15.0` with the same struct definitions) decode through the
  driver's raw path (`deserialize_from_slice`) and re-serialize **byte-identical** via both `serialize_to_vec` and
  `serialize_to_raw_document_buf` (**mutation RED**: a field reorder / a `skip_serializing_if` on a null field
  fail both). Live: every document in the local dev `mc_db` (20 movies, 6 collections, written by earlier bson-2
  builds) decoded 20/20 + 6/6 and re-serialized byte-identical 20/20 + 6/6 (throwaway example, not committed).
- **Keyset cursor**: serde_json over a struct, no bson type in it — byte-identical by construction; pinned by
  `page_cursor_wire_bytes_are_stable_across_builds` (a literal base64 cursor must still decode, and an encode
  must reproduce it). **Errors**: no `bson::de`/`ser::Error` is matched anywhere; `mongodb::error::ErrorKind::Write`
  (duplicate-key → `DuplicateCollectionName`/`DuplicateMovie`) is unchanged and its integration tests pass.
- **Lockfile**: one `[[package]]` changes — `bson 2.15.0 → 3.1.0`; its dependency list drops `getrandom 0.2.17`,
  `once_cell`, `serde_json` and gains `simdutf8`, `thiserror 2.0.21` (both already in the lock). No package is added
  or removed. `cargo tree -d` shows **no bson duplicate** (`cargo tree -i bson@2.15.0` → no match). The musl
  normal-graph `cargo tree -e features` diff vs `main` is bson/mongodb feature names only, plus `time/large-dates`
  dropping (bson 2 enabled it; it governs years beyond ±9999 in formatting, unused here) — **no TLS change**.
- **Verify GREEN (T065)**: `test:unit` **160 passed / 0 failed** (155 on `main` + 5 new);
  `MCM_REQUIRE_LIVE_STACK=1 test:integration` **187 passed / 0 failed / 0 ignored**, 4 binaries (186 + 1 new);
  `cargo build --tests` all targets; `nx lint` (clippy `--all-targets -D warnings`) clean; `rust:alpine` musl
  Docker build green; web E2E (Playwright v1.63.0 image, dev-container BFF, bson-3 mc-service image) **149 passed,
  3 failed, 56 skipped, 3 did not run** — the 3 are assistant-dock specs (`assistant.spec.ts:62/78`,
  `responsive.spec.ts:73`) with no agent stack up; the same specs on the **pre-081** mc-service image gave the
  identical 2-failed/7-passed split (`:62` is intermittent on both), so they are environment, not bson. Skips are
  the agent specs (no `E2E_AGENT_PRODUCTION`) and the backup specs (backup credentials deliberately withheld from
  the shared backup containers); CI's `app-e2e` runs the full gate tier.

## R10. pnpm 12 — a lockfile-wholesale stage with a hard-fail settings check

From the v12.0.0 release notes (GitHub API, `pnpm/pnpm` tag `v12.0.0`):

- **Canonical cycle breaking in peer resolution**: "The first install that actually re-resolves … re-keys
  walk-order-dependent peer variants of cyclic packages once." → the first resolving install rewrites the
  lockfile broadly. It is therefore subject to the same quiet-lockfile rule as nx and Expo.
- **`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`**: an unrecognised `pnpm-workspace.yaml` key is now a hard
  failure when the project's pinned pnpm version is the running one. Every key in that file
  (`packages`, `allowBuilds`, `minimumReleaseAgeExclude`, `overrides`) must be recognised by 12 — and the
  file's header already says: *if a pnpm bump warns about ignored keys, MIGRATE them — never dismiss*,
  because the overrides are security controls (R2).
- `pnpm install --frozen-lockfile false` removed (REPO grep: not used).
- `engineStrict` now fails installs through optional subtrees (we do not set engineStrict — verify).
- Engines: node `>=18`.

**Placement**: immediately after US1 (CI actions, which includes `pnpm/action-setup` v6) and **before** nx,
so that both later wholesale lockfile rewrites (nx, Expo) happen once, under the final package manager.

## R11. nx 23 and its plugins — the plugins are already a major behind nx today

REPO lockfile resolves **three** `@nx/devkit` copies: 20.8.4, 21.6.11, 22.7.10. NPM:

- `@monodon/rust@2.3.0` → `@nx/devkit ">= 19 < 21"` (already out of range against nx 22); `3.0.0` (latest)
  → `@nx/devkit ^22.0.0`. **There is no @monodon/rust release for nx 23** — at nx 23 it keeps a devkit-22
  copy. Measured at stage start whether its executors still load (M3).
- `@nxlv/python@21.x` → `@nx/devkit ^21.0.0`; `23.2.1` → peer `@nx/devkit >=22.0.0` (works on 22 and 23).
- `@nx/expo@23.3.0` peers `expo >=53`, `@expo/metro >=55`, and **exact** `@nx/playwright 23.3.0`.
- `nx` lives in two files (package.json + `nx.json` `installation.version`), held together by
  `check-toolchain-consistency.mjs` and the `nx monorepo` Renovate group.

**Order inside US3**: plugins first (they are already compatible with nx 22 at their new majors), then nx 23
via `nx migrate`, so a red names either the plugins or nx — never both.

---

## R12. Tamagui 2 → 3 (US10) — measured 2026-10-18

**Instruments** (all read 2026-10-18 around 06:10Z):

- **REPO**: `origin/main` = `64e7715d` (US4, #778, merged).
- **NPM**: the packuments (`time`, `dist-tags`, per-version `dependencies`/`peerDependencies`/`deprecated`) of
  `tamagui` and of `@tamagui/` `core`, `config`, `stacks`, `shorthands`, `babel-plugin`, `static`,
  `static-sync`, `static-worker`, `metro-plugin`, `cli`, `compiler-core`, `font-inter`, `config-v5`,
  `animations-react-native` and `codemod-flat-values`.
- **TARBALL**: `@tamagui/core` and `@tamagui/web` at 2.7.7 and at 3.0.18, `@tamagui/shorthands` at 2.7.7 and
  at 3.0.18, plus `@tamagui/react-native-types` 3.0.18 and `@tamagui/style-grammar` 3.0.18, read and diffed.
- **UPSTREAM**: every GitHub release body from v3.0.0 to v3.0.18
  (`https://api.github.com/repos/tamagui/tamagui/releases`; v3.0.0 is
  <https://github.com/tamagui/tamagui/releases/tag/v3.0.0>). Also the v3 upgrade guide, read from its source at
  the v3.0.18 tag:
  <https://raw.githubusercontent.com/tamagui/tamagui/v3.0.18/code/tamagui.dev/data/docs/guides/how-to-upgrade.mdx>.
  That source is the page published at <https://tamagui.dev/docs/guides/how-to-upgrade>, but `tamagui.dev`
  does not resolve from the dev container (DNS), so the source was read instead. "Guide §N" below means its
  numbered sections.

### What is installed (REPO)

| Manifest | Specifier → resolved |
|---|---|
| `frontend/mcm-app` dependencies | `tamagui`, `@tamagui/config`, `@tamagui/core`, `@tamagui/stacks`: `^2.3.0` → **2.7.7** |
| `frontend/mcm-app` devDependencies | `@tamagui/babel-plugin` `^2.3.0` → **2.7.7** |
| `packages/design-system` dependencies | `tamagui`, `@tamagui/config`, `@tamagui/core`, `@tamagui/shorthands`, `@tamagui/stacks`: `^2.3.0` → **2.7.7**; peer `tamagui: ">=2.0.0"` |
| `packages/design-system` devDependencies | `@tamagui/font-inter` **`>=2.0.0`** → **3.0.13** |

The lock holds **121** `tamagui`/`@tamagui/*` packages at 2.7.7 and **21 at 3.0.13**. The v3 packages came in
through `@tamagui/font-inter`, whose open range `>=2.0.0` resolved the v3 line in the lock regeneration of
`d79a994e` (2026-10-16), with no Renovate PR involved. It drags `@tamagui/core@3.0.13` and 20 v3 internals in
beside `@tamagui/core@2.7.7`. Nothing imports it; the only mention is a comment in
`packages/design-system/fonts/index.ts`. It is harmless today, but it is the duplicate `@tamagui/core` that
guide §1 says to remove, and it shows that an open range can take a major in without anyone reviewing it.

**What the code actually uses (REPO grep, non-test sources).** The import surface is small:

- `@tamagui/core`: `useTheme` (81 files), `Text`, `View`, `ViewProps`, `TamaguiProvider`, `styled`,
  `createTamagui`, `createTokens`, `createFont`.
- `@tamagui/stacks`: `XStack`, `YStack`.
- `@tamagui/shorthands`: `shorthands`.

Nothing imports from `tamagui` itself. `frontend/mcm-app/README.md` forbids it, and the root package appears
only as a compiler component name in `babel.config.js`. Nothing imports from `@tamagui/config` either. The
config is fully custom (`createTamagui` from `@tamagui/core`), so no v4/v5/v6 preset is in use. It configures
**no animation driver**. Zero hits for any of these: Sheet, Adapt, Dialog/Popover/Select from Tamagui, Toast,
`themeInverse`, `<Theme inverse>`, `$true`, token stepping, `useProps`/`useStyle`/`usePropsAndStyle`,
`styleable`, `createStyledContext`, `ThemeableStack`/`SizableStack`, `createMedia`,
`onDidAnimate`/`onAnimationComplete`, `animateOnly`, `backgroundActive`, sigil-detection code
(`[0] !== '$'`), `$sm={…}`-style media props, and `useMedia`.

### Target version (NPM)

| Version | Published (the five Renovate-grouped packages) | Past the 3-day cooldown at |
|---|---|---|
| 2.7.7 (installed) | 2026-08-15T00:25–00:27Z | — |
| 3.0.0 | 2026-10-10T03:03–03:04Z | 2026-10-13 |
| 3.0.13 | 2026-10-14T21:33–21:55Z | **2026-10-17T21:55Z**: the newest fully past the cooldown when measured |
| 3.0.14 | 2026-10-15T12:23–12:28Z | 2026-10-18T12:28Z |
| **3.0.18** (`latest`) | 2026-10-16T10:08–10:15Z (`@tamagui/metro-plugin` 10:11Z) | **2026-10-19T10:15Z** |

There were 19 stable patches in six days (3.0.0 → 3.0.18). The `beta` and `canary` tags are 3.0.0
pre-releases and out of scope. **The target is the newest 3.0.x whose every package in the set is past
3 days when the stage starts (M10).** That is expected to be **3.0.18** or later: the stage cannot start
before 2026-10-19 anyway (plan US10). **`@tamagui/babel-plugin` has no 3.x**: `latest` is 2.7.7, and the same
is true of `@tamagui/static-sync` and `@tamagui/static-worker`. Guide §1 lists all three as removed packages.

### Compatibility with what US4 installed (Expo ~57.0.30, RN 0.86.3, React 19.2.3, RNW 0.21.4, TS 6.0.3)

- **Peers (3.0.18)**:
  - `tamagui`: `react >=19`, plus `react-native-safe-area-context *` (optional).
  - `@tamagui/core`, `@tamagui/stacks` and `@tamagui/static`: `react >=19`.
  - `@tamagui/web`: `react >=19` and `react-dom *`.
  - `@tamagui/config` and `@tamagui/shorthands`: none.
  - **No `react-native`, `react-native-web` or `expo` peer**, so nothing pnpm can flag.
- **Stated baseline** (guide intro): React 19, React Native 0.81+, TypeScript 5+.
- **Upstream ran the US4 pair itself.** v3.0.0 merged "chore(deps): upgrade Expo 57 and React Native 0.86"
  (tamagui#4173). Later patches added RN 0.87 startup (3.0.2, #4266) and Metro 0.87 (3.0.14, #4326): both
  lines are supported.
- **`@tamagui/metro-plugin` 3.0.18** peers `metro` and `metro-resolver` `>=0.84.4 <0.88.0`. The lock has
  `metro` **0.84.5 / 0.84.6**, so it is in range. SDK 58's Metro 0.87 is in range too.
- **`@tamagui/static` 3.0.18** depends on `react-native-web ~0.21.0`. The lock has 0.21.4, so it is satisfied.
- **Verdict: compatible. No hold is proposed.** Only the stage's RED/GREEN runs can show it works.

**A typing risk that only the typecheck can settle: the RN 0.87 types arrive with Tamagui 3, not with
RN.** `@tamagui/web` 2.7.7 imports `PressableProps`, `ViewProps`, `TextProps` and related types from
`'react-native'`, so they are whatever the app installs. `@tamagui/web` 3.0.18 imports them from
`@tamagui/react-native-types` 3.0.18 instead. That file's header reads *"GENERATED … from react-native
0.87.1"*, and `onPress?: PressableProps['onPress']` keeps its shape. PR #217's 15 errors in 14 files were
this exact pairing: an app `GestureResponderEvent` checked against Tamagui's `PressableProps['onPress']`
under the RN 0.87 narrowing. R4 §2 placed that narrowing at SDK 58 (RN 0.88). Under Tamagui 3 it may arrive
**now, on RN 0.86**. The exposure is 168 `onPress=` sites in 69 files. Two design-system components declare
`onPress?: (e: GestureResponderEvent) => void` against `'react-native'`: `primitives/Button.tsx:45` and
`primitives/PillButton.tsx:24`. This was not measured (it needs an install); the typecheck RED (T077)
records the count.

### Breaking changes (UPSTREAM) that touch this repo (REPO)

| # | v3 change (source) | Exposure here | What the stage must do |
|---|---|---|---|
| B1 | **The Babel compiler plugin is removed**; Metro compiles through `@tamagui/metro-plugin` / `@tamagui/cli/metro` (guide §1 "Remove tooling packages", "Replace the React Native animation driver on web") | `frontend/mcm-app/babel.config.js` runs `@tamagui/babel-plugin` (feature 015, `c236106f`) on everything except `NODE_ENV=test`. It is **load-bearing**: per its own comment, it lets Metro tree-shake the `@mcm/design-system` barrel, and without that the un-tree-shaken graph OOM-crashed Metro's dev bundler. | Replace it with `withTamagui()` from the standalone **`@tamagui/metro-plugin`**, composed with the existing `metro.config.js` overrides (segment shim, dotenv blocklist). Do **not** use `@tamagui/cli`: 3.0.18 depends directly on `typescript 7.0.2`, `express ^4` and `micromatch ^4`. The Metro plugin also touches the **Android** bundle, which the Babel plugin did too, so this needs the full mobile suite. Upstream warns that the plugin does not invalidate Metro's transform cache when the Tamagui config changes, so clear it (`expo export --clear`, `rm -rf node_modules/.cache/tamagui`) and re-check the nx cache inputs of `export-server` (T079). If the plugin cannot be made to work, the fallback is runtime-only, provided the bundle budget and a dev `expo start` both hold (see "Bundle budget" below). |
| B2 | **`$`-sigil token values have no runtime compatibility path** (guide "Required: migrate tokens…") | **113 sites in 36 files** (design-system 56 in 21, app 57 in 15). Almost all are `fontFamily="$body"` / `"$heading"`. Also `outlineColor: '$primary'` ×6, `borderRadius: '$9'` ×2, and the `defaultProps` `color: '$onBackground'`. Colours are mostly `theme.<role>?.val` raw values, so they are unaffected. | Run `@tamagui/codemod-flat-values --source-semantics v2-pixels` (report mode, then `--write`). Hand-fix every flagged row, then grep `="\$` and `'\$` to zero. A missed site still typechecks but resolves to nothing. |
| B3 | **Pseudo-state objects are replaced by flat clauses** (`hover:`, `press:`, `focus-visible:`); v3 *forwards* an unconverted `hoverStyle` instead of applying it (guide "What a clean typecheck will not catch") | Design system: `hoverStyle` 19 in 11 files, `pressStyle` 22 in 12, `focusVisibleStyle` 12 in 6. App: `hoverStyle` 3 in 3, `pressStyle` 3 in 3. Several are conditional (`pressStyle={interactive ? {…} : undefined}`, `surfaces/Card.tsx:81–92`), which is the shape the codemod reports rather than converts. | Convert, then grep the guide's quick-reference patterns to zero. **The focus-ring guard** `packages/design-system/components/focus-ring.test.ts` asserts the v2 spelling (`focusVisibleStyle`, never `focusStyle`). It is **updated at its cause** to the v3 spelling: the `focus-visible` state modifier (`@tamagui/style-grammar` 3.0.18 `CoreStateModifierName`), and no bare `focus:`. It is never deleted. |
| B4 | **`createTamagui({ defaultProps })` is removed** (guide §17; the 3.0.18 `ConfProps` type has no `defaultProps`) | `packages/design-system/tamagui.config.ts:154–160` defaults every Tamagui `Text` to `fontFamily: '$body'` and `color: '$onBackground'`. | Move the defaults into the design system: a styled `Text`, or `variables` read by the styles. If they were dropped silently, every bare `Text` would change font and colour with no type error. Assert it in a unit test (T074). |
| B5 | **A numeric `lineHeight` on a Tamagui component becomes a ratio** (guide §7) | Up to **31** numeric `lineHeight` sites (design system 18 in 9 files, app 13 in 12). Some are React Native `StyleSheet`s, which are unaffected. Font-token `lineHeight` scales in `createFont` stay absolute. | The codemod's `v2-pixels` mode rewrites proven sites to `"Npx"`. Review the rest by hand. |
| B6 | **An explicit `undefined` prop no longer clears a default variant** (guide §5) | `styled()` is used only in `primitives/Button.tsx` (`ButtonBase`, `StateLayer`). | Covered by the Button unit tests. Check that none passes `undefined` to mean "no variant". |
| B7 | **The provider order flips when `@tamagui/native/setup-safe-area` is used** (guide, "Provider order") | `src/app/_layout.tsx:75–76` puts `TamaguiProvider` outside `SafeAreaProvider`, and nothing imports `setup-safe-area`. | Not triggered. Recorded because the failure is `NO_INSETS_ERROR` at startup, and its message names `SafeAreaProvider`, which points away from the upgrade. |
| B8 | **Native defaults to `optimizeFor: 'first-render'`**, so a theme change re-renders more of the tree | The dark/light toggle is exercised by the mobile and web suites. | Nothing to change. A theme-toggle regression would show in those suites. |
| — | Unchanged, by diff or type read | The `@tamagui/shorthands` root export is identical apart from quote style (v3 adds a `v6` entry). `allowedStyleValues` and `mediaQueryDefaultActive` are still `TamaguiSettings` keys. `useTheme()` values still carry `.val`. Package `exports` have the same shape (`require` → `dist/cjs`), so Jest's `transformIgnorePatterns` entries for `tamagui\|@tamagui` still apply. | — |

**Config v6 is out of scope.** The guide recommends staying on the current values and moving to v6 as a
separate design migration. Here there is no preset to move: tokens and themes are the repo's own, and they
stay byte-identical.

### What must move together

- **Renovate's group**: `tamagui` and `@tamagui/{config,core,shorthands,stacks}`.
- **Outside that group, but it must move in the same change:**
  - `@tamagui/babel-plugin` → removed. `@tamagui/metro-plugin` 3.x is added, pinned to the same version.
  - `@tamagui/font-inter` → removed (unused), or pinned to the same version.
  - the design-system peer `tamagui: ">=2.0.0"` → `>=3.0.0 <4`.
- **Unused direct dependencies**: `tamagui` (root) and `@tamagui/config` are declared in both manifests and
  imported nowhere. Each is either removed (the remaining imports resolve, and `pnpm why` shows the lock
  shrank) or moved, and the decision is recorded (T073). This follows US7b's pattern for `@ai-sdk/openai`.
- **Exact pins, one version.** Guide §1 says to bump every Tamagui package together and leave no duplicate
  `@tamagui/core`, `@tamagui/web` or `tamagui` in the lock. `@tamagui/static` depends on
  `check-dependency-version-consistency`. Tamagui publishes several patches a day, so a later partial lock
  refresh under `^3.0.x` could split the set. US10 therefore pins **exact** versions and adds a Renovate
  `tamagui` group covering `tamagui` and `/^@tamagui\//` on every update type. A guard (T072) enforces both.

### Supply chain (SAST)

- **The braces entry is not discharged.** `@tamagui/metro-plugin` 3.0.18 → `@tamagui/static` 3.0.18 →
  `fast-glob ^3.2.11` → `micromatch ^4.0.8` → `braces ^3.0.3`. The `^braces@3\.0\.3$` entry (item #648)
  already names "fast-glob@3.3.3 (via @tamagui/static…)" in its justification, and that stays true. Nothing
  is re-dated. `@tamagui/cli` would add a direct `micromatch` dependent, which is another reason not to
  install it.
- **The node-forge entry is unaffected.** Tamagui does not reach node-forge.
- **New build-time pins**: `esbuild 0.28.1` (exact, through `@tamagui/static`; v2 had 0.27.7) and
  `@tamagui/compiler-core` → `yuku-analyzer 0.6.1`, `magic-string 0.30.21`. All are build tooling. The audit
  decides; no allowlist entry is pre-written.

### Bundle budget

`scripts/check-web-bundle-budget.mjs` holds the web entry chunk to **2,000,000 B**. It was 1,762,630 B after
feature 077, and the constitution's v2.5.0 exception counts `@tamagui/web` among its irreducible ~1,000 KB.
On disk, v3 is larger:

| Directory | 2.7.7 | 3.0.18 | Change |
|---|---|---|---|
| `@tamagui/web` `dist/esm` | 1,662,331 B | 2,618,786 B | +58% |
| `@tamagui/core` `dist` | 1,125,578 B | 1,632,527 B | +45% |

Those figures include source maps and are not a bundle measurement. They are still a real risk to a ~237 KB
headroom. **Raising the budget is not this stage's call**: it bounds a constitutional exception. If T081
fails the budget, the story stops and asks the operator. The other levers are removing the unused root
`tamagui` package and checking the compiler's flattening (B1).

### `movie-sort` (item #781)

`src/components/movie-sort-control.tsx` lays out a React Native `ScrollView` + `StyleSheet` row of design-system
`Chip` and `IconButton` components. Their sizes come from the repo's own tokens, not from Tamagui's v3 control
ladder (guide §5 applies only to Tamagui's own `Button`/`Input`/… which are not used). Its geometry should
not move. Its status in the full mobile suite is **recorded either way**. A `PASS-REMOVE-NONBLOCKING` there
would be a layout change to explain, not a fix to claim: item #781 owns the fix.

### Hold?

**No hold is proposed.** Tamagui 3 admits React 19.2, and its peers do not constrain RN, RNW or Expo.
Upstream ran Expo 57 / RN 0.86 in v3.0.0, and the Metro plugin admits Metro 0.84. If M10 or the RED
measurements find a blocker the stage cannot fix (for example the Metro plugin breaking the Android bundle
with no runtime-only fallback inside the budget), the stage stops and records a hold:

- the Tamagui majors go behind dashboard approval, with the measured error in the rule description;
- the backlog item cites "item #254";
- the re-check rule is: *"re-measure at each new Tamagui 3.x minor and at the next Expo SDK"*.

The open `@tamagui/font-inter >=2.0.0` range is bounded to `<3` in that case, so the lock stops carrying a
second major.

---

## 11. Stage-start measurements (cannot be settled today; each has its command)

| ID | Stage | Question | How it is settled |
|---|---|---|---|
| M0 | all | Is the lockfile quiet? | `curl …/pulls?state=open` → zero Renovate PRs; not inside `* 2-4 * * 5` America/New_York; no other lockfile-wholesale stage open. |
| M1 | US1 | Does forgejo-runner v12 run `node24` actions and `upload-artifact` ≥4? | A probe workflow on a throwaway branch, jobs on both `ubuntu-latest` and `kvm`, each running checkout@v7 + setup-node@v7 + upload-artifact@v7; read the job log, not the tick. |
| M2 | US2 | Does pnpm 12 accept every `pnpm-workspace.yaml` key, and do all 14 overrides still apply? | `pnpm@12 install` in the worktree; compare the resolved versions of every overridden package before/after. |
| M3 | US3 | Does @monodon/rust 3 (devkit 22) load under nx 23? | `pnpm nx show project mc-service --json` + `pnpm nx run mc-service:test` under nx 23. |
| M4 | US4 | Current SDK-57 patch, RN, companions; is SDK 58 out of RC yet? | `curl -sS https://registry.npmjs.org/expo` dist-tags + the jest-expo/babel-preset-expo recipe from item #254's correction. If SDK 58 is stable by then, the operator chooses (OQ-1). |
| M5 | US5 | Does typescript-eslint admit TS 7 yet? | `curl -sS https://registry.npmjs.org/@typescript-eslint/parser` → latest's `peerDependencies.typescript`. |
| M6 | US6 | express 5 path-syntax and `req.query` changes in the BFF's express usage; ioredis 6 breaking changes against `session-manager.ts` eviction. | grep the BFF for `express`/`ioredis` call sites; the release notes for both majors. |
| M7 | US7 | Is the app's direct `@ai-sdk/openai` still needed after copilotkit ≥1.77? Does openai 7's undici peer interact with the override? | Remove it in the worktree, build the prod BFF image, load the agent route; `pnpm why undici`. |
| M8 | US8 | MongoDB 9 upgrade path from 8.0 (FCV steps), Rust driver 3.9.1 + Node driver 7.7 server-9 support, 9.0 digest scan. | MongoDB compatibility tables + the infra-image scan in CI (ADR-0002 §3: CI is the authoritative scanner). |
| M9 | US9 | Do bson/mongodb still require base64 0.22? Does axum-keycloak-auth still require reqwest 0.12? | `curl` the crates.io dependency endpoints as in R9. |
| M10 | US10 | Which is the newest Tamagui 3.0.x with **every** package in the set past the 3-day cooldown? Do its peers, and `@tamagui/metro-plugin`'s `metro` range, still admit the US4 stack? Does `@tamagui/static` still reach `braces` through `fast-glob`? Is the dashboard still proposing only the five grouped packages? | The R12 recipe: the packuments' `time`, `dist-tags` and per-version `peerDependencies`/`dependencies`, plus every GitHub release body after R12's 3.0.18, read for anything breaking. |

---

## Re-baseline deltas

Each story re-reads the dashboard at its start (T003) and records here what moved since R1.

### US1 (PR 1a) — 2026-10-16

**Instruments**: DASH = `node scripts/backlog.mjs show 29` (body updated `2026-10-16T07:02:49Z`, read only);
REPO = `origin/main` = `9388d96e` (after feature 080 merged as PR #730).

| What | R1 (2026-10-10) | Today (2026-10-16) | Consequence |
|---|---|---|---|
| `renovate/major-ci-actions` dashboard section | Awaiting Schedule | **Rate-Limited** | none — still not opened; US1 lands the bumps by hand |
| The 8 CI-action majors | as R1 | **All 8 still pending**, same targets except `astral-sh/setup-uv` → **v10.3.0** (was v10.2.0) | PR 1b takes the latest v10 at its start |
| `java-jdk 17 → 25` | detected on the two `setup-java` sites | still detected, still inside the major-ci-actions branch | **held at 17 in PR 1a** (`allowedVersions: "<18"`) until US4 |
| Use counts (REPO) | checkout ×22, setup-node ×12, pnpm/action-setup ×8, upload-artifact ×7 | checkout ×**21**, setup-node ×**11**, pnpm/action-setup ×**7**, upload-artifact ×7, setup-uv ×5, setup-java ×2, setup-android ×2, paths-filter ×2 | feature 080 (`63297e91`) deleted `minio-image.yml`, which carried one each of checkout, setup-node and pnpm/action-setup. tasks.md T007's "22 / 12 / 7" is superseded by 21 / 11 / 7 |
| Other drift | — | copilotkit Pending Approval now targets **1.79.0** (R7 said 1.77.0 / latest 1.78.0); nx minor is 22.7.12 | owned by US7 / out of scope; re-read at those stories' start |

Every major US1 owns as of today: `actions/checkout` v4→v7, `actions/setup-node` v4→v7, `actions/upload-artifact`
v3→v7 (PR 1a); `actions/setup-java` v4→v6, `android-actions/setup-android` v3→v4, `astral-sh/setup-uv` v5→v10.3.0,
`dorny/paths-filter` v3→v4, `pnpm/action-setup` v4→v6 (PR 1b); plus the `java-jdk` 17→25 proposal (held → US4).

### M1 — the runner probe (T004), 2026-10-16

**Setup.** A throwaway branch `081-probe-ci-actions` (one commit, `d6c27606`, from `origin/main`) carried
`.forgejo/workflows/probe-081.yml`: two jobs, `runs-on: ubuntu-latest` (`docker://node:22-bookworm`) and
`runs-on: kvm` (the `kvm:host` host-mode label — the same label `app-e2e`, `dast`, `cd-deploy/build-deploy` and
`devcontainer-image` use). Each job ran, SHA-pinned: `actions/checkout@3d3c42e5…` (v7 = v7.0.1),
`actions/setup-node@949feb24…` (v7 = v7.1.0, `node-version: 24.19.0`), `actions/upload-artifact@ff15f030…`
(v3, the control) and `actions/upload-artifact@cf430e03…` (v7 = v7.0.2). All three v7 actions declare
`runs.using: node24`. Every probe step was `continue-on-error` with an id, followed by a verify step, and a
recorder posted each outcome as a commit status (`probe-081/<label>/<action>`). It ran once, as the forge's
run id 5411 (`/actions/tasks` run_number 5410); both jobs `success`. The branch was then deleted from the
remote (`git push origin --delete 081-probe-ci-actions`); it was never merged.

**What could and could not be read.** The forge serves **no job log**: `/api/v1/…/actions/runs/N/logs` 404s
(ci-diagnostics.md), and the web route `/jumbleknot/mcm/actions/runs/5404/jobs/0/logs` also 404s with either
token (measured today; web routes do not accept API-token auth). There is no artifact API either
(`/actions/artifacts` and `/actions/runs/N/artifacts` → 404). So the evidence is the **step outcome** of each
`uses:` step plus an in-job verify, read from the commit statuses the probe posted — not the tick, and not a log.
An in-job attempt to re-run the fetched v7 dist and capture its error text found no copy of the action on
either label (`REPRODUCTION: dist-not-found` — the runner keeps fetched actions outside the paths searched), so
the error **text** was read off-runner (below).

| Label | checkout@v7 | setup-node@v7 | upload-artifact@v3 (control) | upload-artifact@v7 |
|---|---|---|---|---|
| `ubuntu-latest` | **ran** — `uses/verify=success/success head=d6c2760` | **ran** — `uses/verify=success/success node=v24.19.0` | `uses=success` | **failed** — `uses=failure artifact-id=` (no artifact id output) |
| `kvm` | **ran** — `uses/verify=success/success head=d6c2760` | **ran** — `uses/verify=success/success node=v24.19.0` | `uses=success` | **failed** — `uses=failure artifact-id=` |

(Quoted verbatim from the commit-status descriptions on `d6c27606`.)

**The error text.** The same v7.0.2 dist (`cf430e03…/dist/upload/index.js`) run in the dev container with
`GITHUB_SERVER_URL` set to this forge's URL and the probe's inputs exits 1 with:

```
::error::@actions/artifact v2.0.0+, upload-artifact@v4+ and download-artifact@v4+ are not currently supported on GHES.
```

preceded by `Artifact upload failed with error: GHESNotSupportedError: …`. Control: with
`GITHUB_SERVER_URL=https://github.com` the same code passes that check and fails later on
`Unable to get the ACTIONS_RUNTIME_TOKEN env variable` — so the server-URL check (`isGhes()` before any upload)
is what refuses this forge. This is a reproduction off the runner; the runner-side evidence is the `failure`
outcome next to a `success` control.

**Conclusions.**

1. forgejo-runner executes `using: node24` actions on both labels — `checkout@v7` and `setup-node@v7` move in
   PR 1a (21 and 11 sites).
2. `upload-artifact` v4+ is **still unsupported** — the fourth measurement (specs 023/042/048). It stays at v3
   (7 sites, unchanged) and is held by `allowedVersions: "<4"` in `renovate.json`, ordered after the
   `ci actions` group, its description quoting `GHESNotSupportedError` and the release condition (re-run this
   two-label probe; a release note alone is not enough). Asserted by `renovate-workflow.guard.test.mjs`.
3. `java-jdk` is held at 17 (`allowedVersions: "<18"`) until US4 (spec US1 AC4), asserted by the same guard.

### US1 (PR 1b) — 2026-10-16

**Instruments**: DASH = `node scripts/backlog.mjs show 29` (body updated `2026-10-16T15:21:38Z`, read only);
REPO = `origin/main` = `3b505f9a` (PR 1a, #769, merged); UPSTREAM = `git ls-remote --tags` against each
action's github.com repo plus its releases API and `action.yml` at the target SHA, read the same day.

| What | PR 1a delta (earlier 2026-10-16) | Today, PR 1b start | Consequence |
|---|---|---|---|
| `renovate/major-ci-actions` dashboard section | Rate-Limited | still **Rate-Limited**, same 8 deps listed | none — landed by hand |
| PR 1b targets on DASH | setup-java v6, setup-android v4, setup-uv v10.3.0, paths-filter v4, pnpm/action-setup v6 | **unchanged** | — |
| Newest upstream release (UPSTREAM) | — | setup-java **v6.1.0** (= `v6` tag), setup-android **v4.0.4** (= `v4`), setup-uv **v10.3.0** (no `v10` tag exists), paths-filter **v4.0.3** (= `v4`), pnpm/action-setup **v6.1.0** (the `v6` tag still points at v6.0.10) | pin those five commits |
| DASH per-file listing | — | still lists `.forgejo/workflows/minio-image.yml` with one pnpm/action-setup (8 sites) | stale DASH body: feature 080 deleted that file. REPO count is the truth: **7** |
| Use counts (REPO, before) | as PR 1a: setup-uv ×5, setup-java ×2, setup-android ×2, paths-filter ×2, pnpm/action-setup ×7 | **unchanged** | 18 sites in 5 files (app-ci ×10, cd-deploy ×5, infra-image-scan ×2, renovate ×1) |

**Pins** (each SHA verified as the tag's commit object by a depth-1 fetch of the tag and `rev-parse
<tag>^{commit}`, not read off a listing):

| Action | From | To | Comment | Sites before → after (old pins left) |
|---|---|---|---|---|
| `actions/setup-java` | `cf277c60…` v4 | `b843ebf9b913146b38da2eaa7aeddf76074ae1ad` | `# v6` (= v6.1.0) | 2 → 2 (0) |
| `android-actions/setup-android` | `9fc6c4e9…` v3 | `be39fa834029ff78f1a44aa3bb0819b8fc2bd8fd` | `# v4` (= v4.0.4) | 2 → 2 (0) |
| `astral-sh/setup-uv` | `d4b2f3b6…` v5 | `1c37ad07a6a961277cf70c0d37d6f313000f5884` | `# v10.3.0` | 5 → 5 (0) |
| `dorny/paths-filter` | `0e4a8c6e…` v3 | `ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d` | `# v4` (= v4.0.3) | 2 → 2 (0) |
| `pnpm/action-setup` | `b906affc…` v4 | `ea17c68df8912ef543352723c149a84f56e3d413` | `# v6.1.0` | 7 → 7 (0) |

**Why two comments name a full version, not `# vN`.** The comment is Renovate's `currentValue`. setup-uv
stopped publishing major/minor tags at v8.0.0 ("No more major and minor tags"), so `# v10` would name a tag
that does not exist. pnpm/action-setup's floating `v6` tag still points at v6.0.10, while v6.1.0 is the
release that adds pnpm 12 support (US2's target); a v6.1.0 SHA under `# v6` would read to Renovate as a
digest drift from the `v6` tag and be "updated" back to v6.0.10.

**Breaking changes read, and what each needed here:**

- **`actions/setup-java` v4 → v6.** v5.0.0's only breaking change is the node24 runtime (PR 1a's probe: the
  runner executes `using: node24` on both labels). v6.0.0: ESM migration ("not a user-facing breaking change"),
  legacy `adopt*` distributions removed, three env-var-name inputs renamed with deprecated aliases
  (`server-username`/`server-password`/`gpg-passphrase` → `*-env-var`), and package-signature verification
  on by default for Temurin — "When omitted, failures produce warnings" (action.yml `verify-signature`), so
  it cannot fail the step unless set `true`. This repo passes only `distribution: temurin, java-version: '17'`
  — none of the renamed or removed inputs. **No input change; `java-version: '17'` untouched** (held until US4).
- **`android-actions/setup-android` v3 → v4.** node24 runtime; default `cmdline-tools-version` moves
  `12266719` (16.0) → `15859902` (22.0, v4.0.4); default `packages` changes from `tools platform-tools` to
  `platform-tools` (v4.0.2, "Fix for removed tools package" — the same withdrawal run 3409 hit). This repo
  pins `packages: 'platform-tools'` explicitly at both sites, which stays (the two sites' comments were
  corrected: the `tools` default was v3's). **Not measured locally**: whether cmdline-tools 22.0's
  `sdkmanager` runs under JDK 17 — dl.google.com is unreachable from the dev container. It is exercised by
  app-e2e (mobile filter true on this PR, `kvm` label) and by the `cd-deploy` `build_apk` dispatch
  (`ubuntu-latest`); if it fails, the fix is `cmdline-tools-version: '12266719'`, not a JDK move.
- **`astral-sh/setup-uv` v5 → v10.3.0.** v6: `pyproject-file`/`uv-file` removed (→ `working-directory`),
  venv activation opt-in, default `cache-dependency-glob` widened. v7: node24, `server-url` removed. v8:
  custom `manifest-file` format changed, no floating tags. v9: `prune-cache` default `false`. v10:
  `enable-cache: auto` disables the cache on `pull_request_target`/`workflow_run`/`release`; v10.1.0 verifies
  downloads with checksums and `download-from-astral-mirror` defaults `true`. Every site passes only
  `version: '0.12.10' # uv-version` and `github-token`, both still inputs at v10.3.0 (0.12.10 is inside the
  embedded checksum set, which runs through 0.13.0); no site uses a removed input. `enable-cache: auto`
  is the same test in v5 and v10 (`RUNNER_ENVIRONMENT === 'github-hosted'`, read in `src/utils/inputs.ts` at
  both SHAs); v10 only adds exclusions for events this repo does not use with it (tag push,
  `pull_request_target`, `workflow_run`, `release`), so caching behaves as before. **No input change.** The `# uv-version` customManager and its guard are untouched (the uv version does not move).
- **`dorny/paths-filter` v3 → v4.** v4.0.0's only change is node24. Diffing `src/main.ts` v3 pin → v4.0.3:
  the pull-request branch is restructured into a `switch` that adds `merge_group`, with identical
  behaviour for `pull_request` (token present → changed files from the API; else `git diff` against
  `base.sha`); `action.yml` adds a `some-with-excludes` quantifier (default still `some`); v4.0.2 adds a
  `safe.directory` workaround for container jobs. **Output semantics are unchanged** (`'true'`/`'false'` per
  filter). infra-image-scan's `if: github.event_name == 'pull_request'` guard on the step is still needed (the
  non-PR fall-back to `repository.default_branch` is unchanged). Proven on the PR, not argued — T010.
- **`pnpm/action-setup` v4 → v6.1.0.** v5.0.0: node24. v6.0.0: pnpm 11 support; v6.0.7+ bootstraps a pinned
  pnpm with `npm ci` (npm co-located with the action's node) and then `pnpm self-update`s to the target. The
  target is read from `devEngines.packageManager`, else `packageManager` — here `pnpm@11.25.0` — and an
  explicit `version:` input that disagrees with `packageManager` is a hard error ("Multiple versions of pnpm
  specified"). No site here passes `version:` (check-toolchain-consistency keeps it that way), so every site
  resolves `packageManager`. Corepack is not involved: the action never calls it, and the corepack users
  (guardrails' `corepack enable`, the Playwright `docker run … corepack enable`) are separate steps the bump
  does not touch. **No input change.** (Side note, not fixed here: the comments in cd-deploy's prod-apk disk
  step and `prod-apk-disk-step.guard.test.mjs` say the action "resolves pnpm through corepack"; it resolves
  it through npm. The guard's conclusion — never delete `/usr/local/lib/node_modules` — still holds, because
  npm lives there.)

**Runtime probe: none run.** All five targets declare `using: node24`, the runtime PR 1a's two-label probe
already showed executing; none needs a runner capability the PR's own CI does not exercise (affected on
`ubuntu-latest`, app-e2e/dast on `kvm`, prod-apk via the `build_apk` dispatch). Not exercised before merge:
`renovate.yml`'s setup-uv (schedule/dispatch only) and `cd-deploy` `build-deploy`'s pnpm/action-setup +
setup-uv (runs on the post-merge `main` push) — same action, same inputs as the app-ci sites that do run.

### US2 (PR 2) — 2026-10-17

**Instruments**: DASH = `node scripts/backlog.mjs show 29` (body updated `2026-10-16T15:21:38Z`, read only);
REPO = `origin/main` = `6074300d` (PR 1b, #770, merged); NPM = `registry.npmjs.org/pnpm` packument
(`time`, `dist-tags`, `engines`); UPSTREAM = the `pnpm/pnpm` GitHub releases API, every `v12.*` body read.

| What | R1 / R10 (2026-10-10) | Today | Consequence |
|---|---|---|---|
| DASH `renovate/major-pnpm-pin` | Pending, 11.25.0 → 12.10.1 | **Rate-Limited**, "update dependency pnpm to v12"; Detected Dependencies list `11.25.0 → 11.28.5, 12.11.2` (package.json + both Dockerfile stages) | DASH lags NPM; NPM is the truth for the target |
| DASH `renovate/pnpm-pin` (minor) | — | Rate-Limited, 11.25.0 → **11.28.5** | superseded by this PR; Renovate closes/rebases it on its next run |
| Newest pnpm 12 (NPM) | 12.10.1 | `latest` = **12.14.0** (2026-10-15T13:39Z — inside the 3-day cooldown) | target = **12.13.0** (2026-10-13T08:26Z), the newest past `minimumReleaseAge: 3 days` at 2026-10-17T00:13Z |
| pnpm 12 `engines.node` | `>=18` | `>=18.*` (12.13.0) | the repo floor `>=22.13` (set from pnpm 11) is **kept**, not lowered — `//engines` comment updated |
| pnpm pins tied to `packageManager` | package.json + 2 Dockerfile corepack pins | **unchanged set** — every `pnpm/action-setup` (7) passes no `version:`, every guardrails/renovate/wiki-maintain/Playwright site is `corepack enable` (resolves `packageManager`), `.devcontainer/toolchain.Dockerfile` resolves at runtime, `tools/openwiki-generator` declares none (item #286) | 3 lines moved |

**Breaking changes (UPSTREAM, v12.0.0 "Major Changes", and no `Major`/breaking section in v12.1.0–v12.13.0)
mapped to this repo:**

- `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS` — **none raised.** Every key in both `pnpm-workspace.yaml`
  files (`packages`, `allowBuilds`, `minimumReleaseAgeExclude`, `overrides`; nested: `allowBuilds`,
  `minimumReleaseAge`) is recognised by 12.13.0. The upgrade RED for this key class was clean: `CI=true pnpm
  install --frozen-lockfile` under 12.13.0 printed no warning at all. Nothing to migrate; nothing deleted.
- Canonical cycle breaking in peer resolution — **not triggered here.** pnpm 12 considers the 11.25.0 lock
  current: `pnpm install --no-prefer-frozen-lockfile` and `--lockfile-only --no-prefer-frozen-lockfile` both
  answer `Already up to date` and write nothing. The re-key happens on the first install that re-resolves.
  **Measured** on a scratch copy by forcing a resolve (root `yaml` `^2.9.0` → `^2.9.1`, `--lockfile-only`):
  +66/−48/~49 lines — expo/expo-router peer-variant hashes re-keyed, `ajv-formats`/`metro-symbolicate` lose a
  peer suffix, and the `@napi-rs/cli` peer variant under `@monodon/rust` moves `@emnapi/core`/`runtime`
  1.11.2 → 1.10.0. That lands with the next lockfile-wholesale change (US3, or Renovate's lock maintenance),
  not here.
- **NEW, not in R10: the lockfile becomes TWO YAML documents.** With `packageManager` pinning pnpm 12, pnpm
  prepends an env lockfile (`importers['.'].packageManagerDependencies: pnpm 12.13.0` + the 14 `@pnpm/exe.*`
  native-binary packages, 158 lines) — written by the first install, frozen included. The dependency
  document after it is byte-identical to `origin/main`'s lock. `check-toolchain-consistency.mjs` parsed the
  file with single-document `parse()` and exited 2 (`Source contains multiple documents`) — fixed to read the
  LAST document (Renovate's own choice, `parseYaml(raw).at(-1)` in renovate@44.165.1's pnpm extractor);
  guarded by tests (p5b)/(p5c)/(p5d). nx 22.7.10's lockfile parser is unaffected (3303 external nodes, the
  same set as on the single-document lock). No other script parses the lock.
- pnpm 12 is a **native (Rust) binary** behind an npm wrapper. corepack 0.36.0 prints `Downloading the pnpm
  12.13.0 binary for linux-x64...` on first use and runs; the Alpine BFF image gets `linux-x64-musl`.
- `engineStrict`, `--frozen-lockfile false`, git-hosted dependencies — not used here (REPO grep).
- Agent skills (v12.7.0): an install now reports `Agent skills awaiting approval: @copilotkit/runtime` (root)
  and `openwiki` (nested). Nothing is linked until approved, so the default is deny. No decision recorded.

**Nested `tools/openwiki-generator`**: `pnpm --dir tools/openwiki-generator install --frozen-lockfile` from the
root runs 12.13.0, passes its supply-chain verification (471 entries), and leaves its lockfile byte-identical
(no env document: that manifest pins no package manager). `minimumReleaseAge: 4320` **still enforces** under
12: adding `@pnpm/exe@12.14.0` (published 2026-10-15) to a scratch copy fails `ERR_PNPM_NO_MATURE_MATCHING_VERSION`
("15 versions do not meet the minimumReleaseAge constraint"); `12.13.0` resolves. `sast`'s nested-lockfile
audit (item #721) is unchanged: `sast-scan.mjs --scope full --only pnpm-audit` gives the identical 30-finding
list under 11.25.0 (control) and 12.13.0, including the `tools/openwiki-generator:` entries.

**BFF image (`docker-build mcm-app`, cold `--no-cache`, control = `origin/main` under 11.25.0)**: the build
passes under 12.13.0. `pnpm deploy --legacy` under 12 selects among the LOCKED versions differently from 11.
The prod runtime tree is 81 packages in both, with one difference: `es-object-atoms` 1.1.1 → 1.1.2. Both
versions are in the lock, which assigns 1.1.1 to `get-intrinsic`/`get-proto`. The build-time `standalone`
tree shrinks from 2497 to 1908 entries. Every deployed `name@version` is present in `pnpm-lock.yaml`, so no
version outside the lock enters the image. Builder deploy step: 79 s (11, under load) vs 54 s (12, unloaded);
one 775 s run under 12 was contention plus the sandbox's slow registry (`Request took 10758ms`).

### US3 (PR 3a, the nx plugins) — 2026-10-17

**Instruments**: DASH = `node scripts/backlog.mjs show 29` (body updated `2026-10-17T03:01:38Z`, read only);
REPO = `origin/main` = `be862e64` (PR 2, #771, merged); NPM = the `@monodon/rust`, `@nxlv/python` and `nx`
packuments (`time`, `dist-tags`, per-version `dependencies`/`peerDependencies`); UPSTREAM = the GitHub
releases of `Cammisuli/monodon` (`rust-*`) and `lucasvieirasilva/nx-plugins` (`nx-python-v22.*`, `v23.*`), every
body read; TARBALL = the published 2.3.0/3.0.0 and 21.3.1/23.2.1 tarballs, diffed.

| What | R1 / R11 (2026-10-10) | Today | Consequence |
|---|---|---|---|
| DASH, the two plugins | ride `renovate/major-js-majors-(review-individually)` | unchanged: still in that group (Awaiting Schedule); Detected `@monodon/rust ^2.3.0 → ^3.0.0`, `@nxlv/python ^21.0.3 → ^23.0.0` | PR 3a lands both by hand; Renovate drops them from the group on its next run |
| Newest `@monodon/rust` 3 (NPM) | 3.0.0 | `latest` = **3.0.0** (2026-06-01T20:53Z), still no release for nx 23 | target **3.0.0** |
| Newest `@nxlv/python` 23 (NPM) | 23.2.1 | `latest` = **23.2.1** (2026-09-28T18:09Z) | target **23.2.1** (past the 3-day cooldown) |
| `@nxlv/python` devkit relation | `>=22.0.0` peer | confirmed: **peer** `@nx/devkit >=22.0.0` since 22.2.1 (no longer a dependency), so it binds to the root `22.7.10` | the 21.6.11 copy leaves the lock |
| nx (DASH/NPM) | 23.3.0 | `latest` = **23.3.0** (2026-10-07T15:17Z); nx minor 22.7.12 Awaiting Schedule | owned by PR 3b; re-read at its start |
| `@nx/devkit` copies (REPO lock) | 20.8.4, 21.6.11, 22.7.10 | 20.8.4 (only via `@monodon/rust@2.3.0`), 21.6.11 (only via `@nxlv/python@21.3.1`), 22.7.10 | after PR 3a: **22.7.10 only** |

**Breaking changes (UPSTREAM + TARBALL) mapped to this repo:**

- `@monodon/rust` 3.0.0 "drop createNodes v1 and migrate to Nx 22": `src/graph.js` exports only `createNodesV2`
  (nx 22 uses v2 already), and the inferred project's `release.version` moves from `generator:
  '@monodon/rust:release-version'` to `versionActions: '@monodon/rust/src/release/version-actions'` (the nx 22
  release API). The executor set (`build check lint run test wasm-pack napi release-publish`) is unchanged and
  the `run` executor (the only one this repo uses, `mc-service:serve`) is byte-identical apart from its source
  map. The `nx.json` plugin options (`testTargetName` …) are ignored by both versions (the plugin infers only
  `nx-release-publish`). This repo runs no `nx release`, so nothing to migrate.
- `@nxlv/python` 22.0.0 "migrate workspace to nx 22.x" (requires nx 22 — met); 23.0.0 is a version-alignment
  bump with no code change. The `install` and `run-commands` executor schemas (the only two this repo uses,
  across movie-assistant and the three MCP servers) are identical 21.3.1 → 23.2.1. 23.2.0's uv-lock external
  nodes come from the plugin's `createNodes`, which this repo does not register in `nx.json` — not active here.
- Result: the project list and every project's target list (with executors) are identical BEFORE/AFTER; the
  only change in `nx show project --json` across all 8 projects is mc-service's `release` block above.

**Lockfile**: the first resolving install under pnpm 12 lands the re-key US2 predicted. Proven separable with a
control: `origin/main` + only `yaml ^2.9.0 → ^2.9.1`, `--lockfile-only`, produces the same 8 re-keyed snapshots,
the same 34 in-place snapshot rewrites (byte-identical to this PR's) and the same 4 package-metadata rewrites.
That set includes one change US2 did not list: an **orphan** `expo-router@56.2.21(0b04…)` snapshot carrying
`react-native-screens@4.30.0` (expo-router peers `^4.26.0`; the app pins `~4.25.2`). Nothing references it —
the app's `expo-router` stays on the `f61e…` snapshot with `react-native-screens@4.25.2` (checked in the lock and
in `node_modules` links) — so it changes no resolved runtime tree. Everything else is the two plugins: devkit
20.8.4/21.6.11 and their `ejs`/`jake`/`filelist`/`enquirer`/`minimatch@9.0.3` leave; `archiver` 7→8 (and its
`zip-stream`/`compress-commons`/`crc32-stream`/`readdir-glob`/`is-stream`), `@renovatebot/pep440`,
`chalk-template`, `tree-sitter-wasms`, `web-tree-sitter` arrive as `@nxlv/python@23.2.1` dependencies.

### US3 (PR 3b, nx 22 → 23) — 2026-10-17

**Instruments**: DASH = `node scripts/backlog.mjs show 29` (body updated `2026-10-17T12:42:35Z`, read only);
REPO = `origin/main` = `4aae23df` (PR 3a, #773, merged); NPM = the `nx` and `@nx/*` packuments (`time`,
`dist-tags`, per-version `dependencies`/`peerDependencies`); UPSTREAM = the `nrwl/nx` GitHub releases 23.0.0,
23.1.0, 23.2.0 and 23.3.0, every body read; TARBALL = `nx` 22.7.10 vs 23.3.0 and `@nx/nx-linux-x64-gnu` 22.7.10
vs 23.3.0, diffed.

| What | R1 / R11 / PR 3a delta | Today | Consequence |
|---|---|---|---|
| DASH `renovate/major-nx-monorepo` | 23.3.0 | **Awaiting Schedule**, `nx`/`@nx/expo`/`@nx/playwright` 22.7.10 → **23.3.0**; `renovate/nx-monorepo` (minor) 22.7.12 still Awaiting Schedule | this PR lands the major by hand; the 22.7.12 minor is superseded |
| Newest nx 23 (NPM) | 23.3.0 | `latest` = **23.3.0** (2026-10-07T15:17Z, 10 days old); `next` = 24.0.0-beta.2 | target **23.3.0** — past the 3-day cooldown; every `@nx/*` 23.3.0 was published the same day (15:13–15:17Z) |
| DASH, the two plugins | still in js-majors | **still listed** (`@monodon/rust ^2.3.0 → ^3.0.0`, `@nxlv/python ^21.0.3 → ^23.0.0`) although PR 3a merged at 12:33Z | DASH lag (body 12:42Z, extraction older); REPO is the truth |
| **NEW drift, not in R1** | — | js-majors group now also carries **`tamagui`, `@tamagui/config`, `@tamagui/core`, `@tamagui/shorthands`, `@tamagui/stacks` ^2.3.0 → ^3.0.0** | not US3's. **Resolved 2026-10-18:** planned as **US10** (operator decision 2026-10-17 on item #254), after US4. See R12 |
| `@nx/devkit` copies | 22.7.10 only (after PR 3a) | **22.7.10** (only via `@monodon/rust@3.0.0`, a *dependency* `^22.0.0`) + **23.3.0** (every `@nx/*` 23.3.0, and `@nxlv/python`, whose *peer* `>=22.0.0` now binds 23.3.0) | M3 below |

**M3 — `@monodon/rust` 3.0.0 (devkit ^22) under nx 23: it loads.** pnpm keeps a devkit-22.7.10 copy for it,
because `@nx/devkit` is a *dependency* of `@monodon/rust`, not a peer. That copy's own peer is `nx: ">= 21 <= 23
|| ^22.0.0-0"`, which admits 23.3.0 (`<=23` is `<24.0.0-0`), so pnpm links it to **nx 23.3.0**. There is no unmet
peer, and no second nx: `node_modules/@monodon/rust` → `@nx+devkit@22.7.10_nx@23.3.0` → `nx@23.3.0`. The plugin
was exercised through a real executor and its `createNodesV2` export:
- `nx run mc-service:serve` (`@monodon/rust:run`) composed `cargo run -p mc-service`, compiled, and ran
  `target/debug/mc-service`, which then exited as expected on `Missing required environment variable:
  MC_DB_URL`. This is the same evidence PR 3a recorded under nx 22.
- `nx show project mc-service --json` lists the plugin-inferred `nx-release-publish`
  (`@monodon/rust:release-publish`), so the plugin's `createNodesV2` still loads. nx 23's "rename CreateNodes
  V2 types" is a type rename. The runtime still reads the `createNodesV2` export, and the migration for it only
  rewrites *imports* of `@nx/playwright/plugin` and `@nx/expo/plugin`.
- `mc-service:test` was NOT used as the M3 instrument. It is `nx:run-commands`, as are `test:unit` and `lint`, so it
  never touches `@monodon/rust`. (tasks.md T018 names it. PR 3a's delta showed why that is the wrong instrument.)

**Migrations (`nx migrate 23.3.0` → `migrations.json`, 8 entries, `--run-migrations`)**:

| # | Migration | Result |
|---|---|---|
| 1 | `nx:23-0-0-consolidate-release-tag-config` | no change (no `release` block in nx.json) |
| 2 | `nx:23-0-0-add-migrate-runs-to-git-ignore` | `.gitignore` += `.nx/migrate-runs` (moved next to the other `.nx/*` lines) |
| 3 | `@nx/playwright:update-23-0-0-migrate-create-nodes-v2-import` | no change (nothing imports `createNodesV2`) |
| 4 | `@nx/expo:update-23-0-0-migrate-create-nodes-v2-import` | no change |
| 5 | `@nx/expo:update-23-1-0-update-metro-config-for-expo-56` | no change; its AI "prompt phase" (`tools/ai-migrations/@nx/expo/23.3.0/ai-instructions-for-expo-56.md`) is a generic SDK-54/55→56 guide — this repo has been on SDK 56 since feature 005. **Not applied**; file deleted |
| 6 | `@nx/expo:update-23-1-0-replace-standalone-metro-for-expo-56` | no change |
| 7 | `@nx/expo:update-23-1-0-update-jest-winter-runtime-for-expo-56` | no change |
| 8 | `nx:23-2-0-set-cache-on-executor-target-defaults` | no change. nx.json's `targetDefaults` has no executor keys, so cacheability still resolves per target name |

`nx migrate` itself rewrote `nx.json`. It set `installation.version` to 23.3.0. It also re-serialised the file,
which **removed a pre-existing duplicate `"build"` key** in `targetDefaults` (`{cache: true}` … later
`{cache: false}`). `JSON.parse` keeps the last value, so the effective value was always `cache: false`. The
rewrite keeps `false` at the first position, so nothing changes in behaviour. It also expanded `deploy.dependsOn`
onto several lines. `migrations.json` and `tools/ai-migrations/` were deleted after the run: no
`migrations.json` has ever been committed in this repo.

**Breaking changes (UPSTREAM) mapped to this repo:**
- **23.1.0 "linter: drop eslint v8 support"**: `@nx/eslint@23.3.0` peers `eslint ^9 || ^10`, and this repo is on
  eslint 8.57.1. **Not exercised here.** No `@nx/eslint` plugin is registered in nx.json. Every lint target is
  `nx:run-commands` invoking the project's own eslint, and both `.eslintrc.json` files extend only `expo`. pnpm
  auto-installs `eslint@10.12.0` as the peer of `@nx/eslint` *inside its own snapshot*. The hoisted
  `node_modules/.pnpm/node_modules/eslint` and both projects' `node_modules/eslint` remain **8.57.1**, and
  `mcm-app:lint` gives the same `0 errors, 43 warnings` as before. The eslint 8→10 move stays US5's.
- 23.0.0 drops the `'self'`/`'dependencies'` magic strings in `dependsOn`. No project.json uses them (REPO grep).
- 23.0.0 removes `initTasksRunner`, legacy vitest-in-`@nx/vite`, the Angular/webpack/SVGR/Tailwind items, and jest
  `setupFile`. None is used here.
- 23.2.0 changes cacheability resolution from target-name keys to executor keys (migration 8). There are no
  executor keys here, and every project's resolved `cache` is identical BEFORE/AFTER (below).
- **The `@nx/playwright` 23 inferred `e2e` target now carries `parallelism: false`**, because the Playwright
  config's web server is not an inferred serve task (`chainRequiresSerialization`), and
  `e2e-ci--merge-reports` gains an explicit `continuous: false`. These are the **only** differences in
  `nx show project --json` across all 8 projects. CI never runs `nx e2e`: app-e2e calls
  `pnpm exec playwright test` in the Playwright image. So this changes only how a local
  `nx run-many -t e2e` schedules.

**Remote cache (CI depends on it).** CI sets only `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` (app-ci.yml `env:`), and nx.json has no cache literal. nx 23.3.0's
`tasks-runner/cache.js` `getHttpCache()` still keys off `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and still constructs
the native `HttpRemoteCache`. `getHttpCache()` and the remote-cache selection around it are byte-identical
between 22.7.10 and 23.3.0. The diff of `cache.js` touches only batch-output logging and terminal-output
bookkeeping. 23.1.0's release notes add a zip-slip fix and a TLS-disabled warning on the native side.
The native binary's strings for both versions name the same `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`,
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` and `NX_REMOTE_CACHE_URL` variables and the same `/v1/cache/` path.
**No config-format or env-var change.**

**NEW, security-relevant: nx 23 downgrades undici into ten advisories.** `nx@23.3.0` depends on `undici: 7.29.0`
**exactly**. nx 22 used `axios` and had no undici dependency. Until now the lock's only 7.x was **7.29.1**, through
`@module-federation/dts-plugin`, which nx 23's plugin tree no longer pulls in. 7.29.0 is inside ten advisories that
7.29.1 fixes (OSV): GHSA-rfgv-xxqx-mfg5 and GHSA-w293-vg96-wgc3 (High), GHSA-2jfj-6hjv-fm6j, GHSA-3wwx-pv8p-q78v,
GHSA-3xpg-4rpp-hhhm, GHSA-pmjh-fq2x-6v4x and GHSA-rx4f-c7p8-82vq (Medium), and GHSA-2gqq-gqf2-x968,
GHSA-8436-99hf-9mmv and GHSA-r53p-7pc4-xj5r (Low). `sast-scan --only pnpm-audit` reported all ten as
`pnpm-audit/dev`, which does not block. Per spec ("an upgrade changes a security-override's resolution: reviewed as
a security change") this PR adds a keyed floor, `undici@>=7.0.0 <7.29.1: '>=7.29.1 <8'`, which is the same shape as
`undici@<6.27.0` and passes check-override-consistency. It resolves to **7.30.1** (2026-10-15T14:18Z, 0 OSV
advisories). 7.30.1 is inside Renovate's 3-day proposal cooldown but passes pnpm 12's verify-time release-age
policy, which is the policy that governs transitives (item #271). Forcing a 3-day `minimum-release-age` on the install is
not an alternative. It is a verify-everything check, and it rejects ~20 entries that the 2026-10-16
lock-maintenance already landed (`rollup@4.64.7`, `ai@6.0.307`, …).

**Lockfile**: the env document (pnpm 12.13.0) is unchanged, and every change is in the dependency document. There are no
package-metadata rewrites. 135 packages leave and 67 arrive. A reachability walk from every importer that does not
enter `nx`/`@nx/*`/`@monodon/*`/`@nxlv/*` reaches **none** of them, either before or after, so all are
(a) nx-family. In detail: the whole `@nx/*` 22.7.10 family plus `@nx/module-federation` (and with it `@module-federation/*`,
`@rspack/*`, `webpack`, `@webassemblyjs/*`, `@svgr/*`, `svgo`, `rollup-plugin-typescript2`, `typescript@5.9.3`,
`axios@1.18.1`, `undici@7.29.1`) leave. `@nx/*` 23.3.0 arrives, along with nx 23's own dependencies (`undici` → 7.30.1 via the floor, `ora`
5.4.1, `open` 10.1.0, `smol-toml` 1.9.0, `which` 3.0.1, `@clack/*`, `jsonc-parser`) and `@nx/eslint`'s auto-installed
peer `eslint@10.12.0` with its tree. The newest arrival is the `@nx/*` 23.3.0 set (2026-10-07); `undici@7.30.1` is
the single exception, explained above. Snapshot-level changes (b) are re-keyings with no version change:
- `@nx/expo@23.3.0` resolves a second `expo@56.0.23` peer variant (`e508…`). It differs from the app's
  (`037f…`) **only** in `supports-color` 7.2.0 vs 8.1.1 under `debug`/`@babel/core`. The shared, cyclic
  `expo-keep-awake@56.0.3(expo@56.0.23)(react@19.2.3)` snapshot now points its `expo` at the nx variant. This is
  the walk-order-dependent cyclic peer re-key that US2 described. The app's importers are byte-identical, and
  `expo-keep-awake`'s sources import only `expo-modules-core` and `react`, never `expo`. So the app's runtime
  graph does not enter the second variant, even though a lock walk now reaches it, and with it
  `react-native-screens@4.30.0` under that variant's `expo-router`. The app keeps 4.25.2.
- In-place: `metro@0.84.5`/`metro-symbolicate@0.84.5` point at the `supports-color@7.2.0` variants of
  `metro-config`/`metro-transform-worker`/`metro-source-map`; `ajv-formats@3.0.1` gains `ajv: 8.20.0`; 43
  snapshots flip to `optional: true`. Each of those is now reached only through an optional peer of an `@nx/*` 23
  plugin: the rollup plugins, `postcss-modules*`, the `express@4.22.3(supports-color@7.2.0)` variant, and
  `http-proxy-middleware`. The app's `express@4.22.3(supports-color@8.1.1)` is unchanged. Two `@babel/plugin-syntax-*`
  snapshots flip the other way.
- Re-keyed only by their `nx`/devkit peer: `@monodon/rust@3.0.0`, `@nxlv/python@23.2.1`, `@nx/devkit@22.7.10`,
  `@eslint-community/eslint-utils@4.10.1`.

(c) Anything else: none. Override resolutions are unchanged except: `axios` loses 1.18.1 (nx 22 was its only
user; 1.20.0 remains, inside `>=1.18.0 <2`), and `undici` 7.x moves 7.29.1 → 7.30.1 under the new floor. No
existing floor moved.

### US4 (PR 4, Expo SDK 56 → 57) — 2026-10-17

**Instruments**: DASH = `node scripts/backlog.mjs show 29` (body updated `2026-10-17T13:56:24Z`, read only);
REPO = `origin/main` = `97106c8e` (PR 3b, #774, merged); NPM = the `expo`, `jest-expo`, `babel-preset-expo`,
`eslint-config-expo`, `@expo/cli`, `react-native`, `@react-native/metro-config` and `expo-template-bare-minimum`
packuments, and the published `expo` 57.0.28 / 57.0.30 / 58.0.14 tarballs' `bundledNativeModules.json`;
TARBALL = `expo-template-bare-minimum` 56.0.37 vs 57.0.32 and `@react-native/gradle-plugin` 0.85.3 vs 0.86.3, diffed;
RENOVATE = the `renovate@44.166.0` tarball (`versioning/semver-partial`, `workers/repository/process/lookup/filter.js`,
`manager/github-actions/known-actions/java-version-dynamic.js`), read.

| What | R1 / R4 (2026-10-10) | Today | Consequence |
|---|---|---|---|
| `expo` dist-tags | `latest` 57.0.27, `next` 58.0.7 (RC RN) | **`latest` = 58.0.14** (SDK 58 is STABLE: 58.0.0 published 2026-09-29, on RN **0.88.0** / React **19.3.0**), `sdk-57` = 57.0.30, `next` = 58.0.11 | OQ-1 was answered by the operator BEFORE this stage: **stay on SDK 57**. SDK 58 is recorded, not taken |
| Newest SDK-57 patch past the 3-day cooldown (at 2026-10-17T15:4xZ) | — | **57.0.28** (2026-10-12T14:28Z); 57.0.29 (10-14T16:32Z) and 57.0.30 (10-15T14:38Z) were inside it | installed as `expo@57.0.28`, then `expo install --fix` rewrote the specifier to **`~57.0.30`** (below) |
| `bundledNativeModules.json` (57.0.30) | 57.0.27: RN 0.86.3, React 19.2.3 | RN **0.86.3**, React **19.2.3**, reanimated 4.5.1, worklets 0.10.1, gesture-handler ~2.32.0, screens ~4.26.0, safe-area ~5.7.0, svg 15.15.4, **async-storage 2.2.0**, jest-expo ~57.0.6, expo-router ~57.0.28, `@expo/dom-webview` ~57.0.1 | React is unchanged at 19.2 — the amendment names 19.2. 57.0.28 → 57.0.30 differs only in `~` patch floors of Expo's own modules |
| Companions (NPM) | 57.0.5 / 57.0.14 / 57.0.2 | jest-expo **57.0.6** (jest **29** family; peer `@react-native/jest-preset ^0.86.3`), babel-preset-expo **57.0.16** (peer `@babel/runtime ^7.20.0`), eslint-config-expo **57.0.2** (peer `eslint >=8.10`) | item #254's correction holds: jest 30 / babel 8 stay blocked at SDK 57; SDK 58's jest-expo ~58.0.11 is where jest 30 arrives (R4 §3) |
| `@expo/cli` (what `expo@57.0.30` resolves) | 57.0.28 | **57.0.31**: still `node-forge ^1.3.3`, still `@expo/metro ~56.0.2` | neither SAST entry is discharged (T030) |
| DASH | — | no Expo/RN entries (Renovate is disabled for them by design); still lists nx 23, pnpm 12 and the two nx plugins (lag — all merged); copilotkit Pending Approval → **1.79.0**; `langfuse` → **v5** (Python, Pending Status Checks) is NEW; tamagui 3 still in js-majors; **`java-jdk 17 → 18`** in `renovate/major-ci-actions` | the java-jdk line exposed a defect in the US1 hold — below |

**`expo install --fix` overrides the cooldown choice, and `--check` is the done-criterion.** The SDK-57 CLI reads
Expo's versions endpoint, not the installed tarball, and recommends `expo ~57.0.30`; `expo install --check` then
reports a mismatch for anything older. The lock therefore resolves **`expo@57.0.30`** (2026-10-15T14:38Z): inside
Renovate's 3-day *proposal* cooldown until 2026-10-18T14:38Z, past pnpm 12's verify-time release-age policy (the one
that governs installs, item #271; the frozen install passes). Choosing 57.0.28 would not have changed the
transitive tree: every Expo module is a `~57.0.x` range and resolves its newest patch either way.

**What `--fix` changed beyond the SDK line** (each kept, each checked):
- `@types/jest` `^30.0.0` → **`29.5.14`** (mcm-app; mirrored into design-system). `^30` was chosen in feature 005
  (`be2761b1`) because TS 6 stopped auto-loading `@types/jest@29` globals; the same commit added `"types": ["jest"]`
  to both tsconfigs, which is what actually fixed it. With that in place `@types/jest@29.5.14` typechecks the app
  (tests included) and design-system with **0 errors** under TS 6.0.3, and now matches the jest 29 runtime.
- `app.json` `plugins` += `expo-font`, `expo-status-bar` — the SDK-57 CLI registers the config plugins of installed
  packages that ship one. No options; they affect prebuild only (exercised by CI's APK build).
- `react-native-svg` 15.15.5 → **15.15.4** (the SDK's bundled pin; 15.15.5 stays in the lock for design-system's
  `>=15.0.0`). `react-native-screens` ~4.25.2 → ~4.26.2, which also retires the orphan `react-native-screens@4.30.0`
  snapshot US3 recorded.
- Tamagui: **untouched** (still `^2.3.0`); `--fix` does not manage it. Tamagui 2 → 3 is its own later stage:
  **US10** (R12).

**`@react-native/metro-config` stays 0.85.3, an unmet *optional* peer.** It enters only as `react-native-worklets`'
peer `'*'`, and pnpm prefers the version already locked. `@react-native/community-cli-plugin@0.86.3` peers it at
`0.86.3`, **optional**. Neither consumer is on this app's path: `metro.config.js` builds on `expo/metro-config`, and
community-cli-plugin serves the RN CLI (`react-native start`), which Expo does not use. Forcing a re-resolve
(`pnpm update --depth Infinity @react-native/metro-config`) picks **0.88.0** (npm `latest`), which is worse, and
pnpm refuses a version on an indirect dep (`ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP`), so it was reverted.

**`@nx/expo` and SDK 57**: `@nx/expo@23.3.0` ships no SDK-57 migration; its `update-23-1-0-update-metro-config-for-expo-56`
prompt (`ai-instructions-for-expo-56.md`) is SDK-56 specific — move to `@expo/metro`, source Metro from
`expo/metro-config`, drop standalone `metro*` deps — and the app already does all three. Nothing to apply. **The
second `expo` peer variant does not collapse**: two `expo@57.0.30` snapshots remain, differing only in
`supports-color` 7.2.0 (`@nx/expo`'s side) vs 8.1.1 (the app's), the same shape as at SDK 56.

**JDK (T027) — stays 17; and the US1 hold was inverted.** SDK 57's `expo-template-bare-minimum@57.0.32` `android/`
tree is byte-identical to SDK 56's (`56.0.37`, Gradle 9.3.1), and `@react-native/gradle-plugin@0.86.3`, like 0.85.3,
builds with `kotlin { jvmToolchain(17) }` on AGP 8.12.0. Nothing asks for a newer JDK. **But the dashboard proposed
`java-jdk 17 → 18` *through* the hold.** RENOVATE: github-actions extracts `java-version` with `semver-partial`
versioning; `filterVersions` tries a regex `allowedVersions`, then the dep's own versioning's `isValid`/`matches`, and
only then npm semver. semver-partial's `parseRange('<18')` coerces to `{major: 18, minor: 0}`, so `isValid` is true
and `matches(v, '<18')` is `major === 18 && minor === 0`: the US1 value **admitted exactly JDK 18.0.x and blocked 17**.
Fixed with a regex ceiling `/^17\./` (evaluated before any versioning); the guard now also models semver-partial
and asserts what the ceiling *admits* (17.0.x yes; 18.0.x, 21, 25 no). RED: 2 failures (the ceiling string, and
`'<18' blocks 17.0.12+7`); GREEN: 131/131. The `upload-artifact` hold (`<4`) is unaffected: action refs use the
`github-actions` versioning, whose `parseRange` accepts only `N` / `N.M`, so `<4` is not valid there and the filter
falls through to npm semver, which reads it as intended.

**CI `affected` red on the first PR-4 run — a real RN 0.86 cost, made visible by load (run 5489).** One mcm-app
test failed: `tests/app/(app)/_layout.test.tsx` › "resolves the assistant config from a descendant of the Stack AND
of the dock gate", `Exceeded timeout of 5000 ms` (suite 13.9 s; 1577/1578 passed; the same run's
`ui-action-tools.test.tsx` took 29.2 s, so the runner was heavily loaded). Measured locally, that one file,
`--maxWorkers=1`, three runs each, against a throwaway `origin/main` worktree:

| | cold transform cache (`--no-cache`) | warm cache |
|---|---|---|
| `main` (RN 0.85.3) | 563 / 566 / 582 ms | 66–178 ms |
| SDK 57 (RN 0.86.3) | 1105 / 1107 / 1110 ms | 97–103 ms |

Why: a fresh `--cacheDirectory` shows the branch transforms `ReactFabric-dev.js` (~2.2 MB), `MessageQueue`,
`BatchedBridge` and `ReactNativePrivateInitializeCore` for this test and `main` does not. A `jest.mock` stack trace
on `react-native/Libraries/Renderer/shims/ReactFabric` names the chain: nav bar `TouchableOpacity` (a lazy getter,
reached only during render) → `Animated` → `AnimatedEvent` → `RendererProxy` (the jest preset's mock, which
`requireActual`s) → `RendererImplementation.js:18`. RN 0.86 rewrote `RendererImplementation` to `import ReactFabric`
at module scope, where 0.85 `require`d it lazily inside `getFabricRenderer()`; the preset's mock is unchanged.
The CPU profile agrees: +216 ms `@babel/traverse`, +94 ms `@babel/parser` and so on. The extra time is transform
work. Upstream, inherent to RN 0.86, and paid once per worker by the first render that touches `Animated`. Fixed on
that test only with a named 15 s bound and the measurement in a comment. The timeout was not raised suite-wide.
`affected` publishes evidence only on failure, so `main`'s green runs record no per-test timings to compare. The
three `affected` bundles in retention (runs 3589, 4899 and this one) contain no earlier failure of this test, and
the backlog has no item for flaky mcm-app unit timeouts.

### US4 follow-up: the RN 0.86 renderer slowdown removed at its cause (2026-10-17)

The 15 s per-test timeout added in `d83678f4` treated the symptom. The cost was not loading
`ReactFabric-dev.js` but **Babel-transforming** it. The app's `transformIgnorePatterns` lets all of
`react-native` through Babel, and RN 0.86 now loads the 725 KB renderer eagerly. That file is
already-compiled CommonJS (`@noflow`, no Flow types, no ESM), so a fresh Jest process pays a transform
it does not need. CI is always a fresh process.

The fix adds `/node_modules/react-native/Libraries/Renderer/implementations/` to
`transformIgnorePatterns`. The test-specific timeout and its comment are removed.

Measured with this test alone, cold (`--no-cache`), `--maxWorkers=1`, three runs each:

| state | test duration |
|---|---|
| `main`, RN 0.85.3 (from d83678f4's measurement) | 563–582 ms |
| SDK 57, renderer transformed | 1104–1260 ms |
| SDK 57, renderer **not** transformed | **591–630 ms** |

This is back to the SDK 56 figure, so the default 5 s Jest timeout is ample again.

### US10 (PR 10, Tamagui 2.7.7 → 3.0.x) — 2026-10-18

**Instruments**: NPM = packuments of `tamagui`, `@tamagui/{core,config,stacks,shorthands,metro-plugin,web,static,font-inter,codemod-flat-values}`
(read 2026-10-18T11:00Z); REPO = `origin/main` `323c8997`; DASH = `node scripts/backlog.mjs show 29` (body updated
2026-10-18T04:42Z, read only); TARBALL = `@tamagui/{web,core,style-grammar,codemod-flat-values}@3.0.13` and
`@tamagui/metro-plugin@3.0.18`, read; WEB = before/after captures of the static `expo export` (main vs branch) served
locally with every `/bff-api/*` call stubbed, in `mcr.microsoft.com/playwright:v1.63.0-noble`, pixel-diffed (`compare -fuzz 2%`).

**Version (M10).** At stage start (2026-10-18T11:00Z) the newest 3.0.x whose whole set is past the 3-day cooldown is
**3.0.13** (last package 2026-10-14T21:55Z). 3.0.14 clears 10-18T12:29Z, 3.0.18 (`latest`, nothing newer) clears
10-19T10:15Z. The work was done on 3.0.13; the PR moves to the newest qualifying version when it opens. `@tamagui/metro-plugin`
3.0.13 peers `metro`/`metro-resolver` `^0.84.4` (lock: 0.84.5/0.84.6). No new release body after 3.0.18.

**DASH delta vs R12**: Tamagui still in `js majors` (`@tamagui/{config,core,shorthands,stacks}`, `tamagui`); new since
US4: `pnpm 12.14.0` (Pending Status Checks), `@types/react ~19.3.0` (js patch/minor), `langfuse v5` (major-python-deps);
`java-jdk 17 → 18` still listed in Pending Status Checks.

**RED (T077, bump only, sources untouched)**: `mcm-app:typecheck` **32 errors in 19 files**, of which **2 press-event**
(`Button.tsx` onPress → frame, `PillButton.tsx` handler call: `GestureResponderEvent` vs Tamagui 3's RN-0.87-generated
event); design-system `tsc` **29 in 16** (same 2 press-event). Jest: every Tamagui suite *failed to run* — 56 suites
(`@tamagui/style-grammar/token-categories` and `@tamagui/core/inject-styles` map their `react-native` export to an ESM-only
`.mjs`) — then, once loadable, `createTokens` threw on `true` keys and on a token named `transparent`. Real RED after those
two: design-system 9 failed / 118 passed (T074 Text defaults ×2, T075 focus-ring ×7); mcm-app 1578/1578.

**Sites**: `$` sigils 111 in 35 files (R12's 113/36 counted differently); pseudo-state objects 59; numeric `lineHeight` on
Tamagui Text 31 → `"Npx"`; `defaultProps` 1. Codemod 3.0.13: design-system 86 sites (79 clean, 7 flagged), app 67 (64/3).

**Two v3 semantics no codemod or typecheck catches (measured, fixed)**:
- A bare name on a colour property resolves **token-first, theme second**. The config duplicated the light roles as
  colour tokens, so `onBackground`/`primary` rendered the LIGHT value in the dark theme (#1a1c1e for #e3e2e6). The
  duplicates are removed; all 39 roles are theme-defined.
- Tamagui 2's web stylesheet gave every Tamagui text the font's `true` line height (20px); v3 does not. Restored on the
  design-system Text, web only.

**GREEN**: typecheck 0/0, design-system jest 131/131, mcm-app jest 1578/1578, lint 0 errors, lockstep guard 6/6,
renovate guard 131/131, SAST gate passed (braces/node-forge entries unchanged and still exact).

**Bundle**: web entry 1,767,030 B (main) → **1,881,353 B** with the Metro plugin / **1,881,066 B** runtime-only, of
2,000,000. Dev server (`expo start --web --clear`) serves `/` and the 6.17 MB web bundle without OOM either way (min
available 8.8–9.0 GB of 15). BFF prod image builds (417 MB).

**OQ-5 — the Metro plugin, MEASURED, needs the operator.** `@tamagui/metro-plugin` 3.0.13 (3.0.18's code is identical
here) wired as OQ-5's default:
1. Its resolver resolves almost nothing in this repo (34,780 `metro/resolve-failed` warnings per export): it `lstat`s
   pnpm's symlinked `node_modules/<pkg>` and treats the directory as a file, and it does not know Expo's `@/` tsconfig
   alias. `metro-resolver` must also be resolvable from the app's own `package.json` (added at 0.84.5).
2. Worse, on **web** it lowers some app modules to static atomic classNames and never emits their CSS (plan CSS is only
   published in the experimental zero-runtime mode). Measured on `/settings` alone: 7 classes with no rule — the app
   bar lost its 24px gap, the settings menu its width/gap, a chip its radius/gap/cursor. `disableExtraction: true` does
   not stop it.
3. It saves nothing: entry chunk 1,881,353 B vs 1,881,066 B runtime-only, and the dev server does not need it.
Runtime-only (no Metro plugin) + the two fixes above is **pixel-identical to `main`** on 44 of 48 captures; the other 4
(settings/account, the elevated Card) differ because v2 dropped `shadowOpacity` on web (`0 1px 3px rgb(0,0,0)`) and
v3 applies it (`0 1px 2px rgba(0,0,0,.12)`) — native is unaffected. Runtime-only is OQ-5's fallback, which needs
operator approval; it is prepared on branch `081-us10-tamagui-3-runtime-only`, not chosen.

**Operator decisions, 2026-10-18 (item #254).**
- **OQ-5: runtime-only APPROVED.** The reason is the plugin measurements above: it dropped CSS on `/settings` (7 rules),
  printed 34,780 resolve warnings per export, and saved 0 bytes. No constitution amendment: its "runtime-only by default"
  line is accurate again.
- **Cooldown override: Tamagui 3.0.18 now.** It sits inside Renovate's 3-day cooldown until 2026-10-19T10:15Z. The lock
  moved 22 Tamagui packages 3.0.13 → 3.0.18 and nothing else. MEASURED: pnpm's own install-time release-age policy already
  admits 3.0.18. It was about 51 h old at install, and the cold frozen install passed `Lockfile passes supply-chain
  policies` with no `minimumReleaseAgeExclude` entry. So no exemption was added. A no-op entry would break that list's
  documented rule that an entry is a needed security-floor exception.
- **Re-run on 3.0.18**:
  - typecheck 0 errors on both mcm-app and design-system;
  - jest 131/131 and 1578/1578;
  - lint 0 errors;
  - `scripts/__tests__` 1718/1718;
  - entry chunk **1,881,037 B** of 2,000,000;
  - SAST gate passes;
  - web captures identical to `main` on 44/48, the same 4 shadow-opacity differences.
- **Android regression found by the full suite, and fixed.** PR #788 run 5540: `assistant-config-gating` failed 3/3 at
  `Tap on id: settings-nav-assistant`. In Tamagui 3 any state clause, hover included, makes a View attach its own event
  handlers on native. NavList's inner View (inside an RN `Pressable`) then swallowed the tap: the feature-062 trap,
  reached through `hover`. NavList and Tabs now pass the hover clause on web only. Run 5543 is green, with all 22 blocking
  flows passing and the agent flows passing. `movie-sort` (#781) and `login-invalid` (#782) are FAIL-NONBLOCKING as on `main`.
- **Performance (operator condition).**
  - Web, same harness for both builds, 5 interleaved runs:
    - Slow-3G cold TTI 67.7 s → 70.2 s (+3.7%, which is bytes: +111 KB);
    - CPU 4× TTI 953 → 978 ms;
    - 300-row table render 1,295 → 1,332 ms.
  - CI `perf.spec` on the PR: 1,837 KB / 71.0 s, under the 1,950 KB / 75 s ceilings.
  - Android per-flow seconds (5543 vs `main`-based 5512/5505) all sit inside the ±5 s baseline spread.
  - Verdict: no meaningful regression.

### US5 (PR 5a, override cap + holds) — 2026-10-18

**Instruments**: DASH = `node scripts/backlog.mjs show 29` (body updated `2026-10-18T04:42:40Z`, read only — it
predates US10's merge); REPO = `origin/main` = `62556d3b` (PR #788, US10, merged); NPM = the packuments in R4/R5's
2026-10-18 re-measure; RENOVATE = renovate@44.167.1's `applyPackageRules` (`dist/util/package-rules`) run on the
repo's own `packageRules` (presets not resolved), and `workers/repository/updates/generate.js`, read.

| What | R2 (2026-10-10) | Today | Consequence |
|---|---|---|---|
| Override widenings on DASH | five | **six** — US3 3b added `undici@>=7.0.0 <7.29.1: '>=7.29.1 <8'`, which Renovate now proposes as `<9` | the disable rule and the cap rule cover all six; T033's table lists six |
| Uncapped keyed floors (REPO) | — (fc3c47ae: "every other override bounds its major") | **four**: `form-data@<4.0.6`, `hono@<4.12.25`, `brace-expansion@<5.0.9`, `shell-quote@<1.9.0` — value `>=X` with no cap | out of the cap rule's scope (capping them rewrites the lock's `overrides:` — not a 5a change); NAMED on every gate run. Not filed; recorded for the coordinator |
| Held majors on DASH | jest, babel-jest, `@babel/core`, `@babel/runtime`, typescript, async-storage in `js majors` | the same six, still in `js majors` | each moved to its own approval-gated group |
| `@types/jest` | `^30.0.0` | US4 set **`29.5.14`** (matches the jest 29 runtime); `latest` 30.0.0 | held WITH jest (same group): moving it alone re-splits types from runtime |

**The approval trap (RENOVATE, new).** `generate.js:240` computes a branch's approval as
`config.upgrades.some((upgrade) => upgrade.dependencyDashboardApproval)`. So `dependencyDashboardApproval` on a
member still grouped into `js majors (review individually)` would gate the WHOLE js-majors branch — eslint, express,
ioredis, openai, RNTL, … — behind one tick, and that tick would release the held majors with them. Each hold
therefore sets its own `groupName` (four groups: `held jest major`, `held babel major`, `held typescript major`,
`held async-storage major`). Not `allowedVersions`, by US4's java-jdk lesson: a ceiling's meaning depends on the
dep's versioning, an approval gate has none.

**Resolved behaviour (RENOVATE `applyPackageRules`, before = `origin/main`, after = this PR):**

| Dep (manifest) | patch | minor | major BEFORE | major AFTER |
|---|---|---|---|---|
| the six keyed overrides (`pnpm-workspace.yaml`) | flows, js patch/minor | flows, js patch/minor | flows, js majors | **disabled** |
| jest (mcm-app, design-system), babel-jest, @types/jest (mcm-app) | flows | flows | flows, js majors | **tick**, `held jest major` |
| @babel/core, @babel/runtime (mcm-app) | flows | flows | flows, js majors | **tick**, `held babel major` |
| typescript (mcm-app, design-system) | flows | flows | flows, js majors | **tick**, `held typescript major` |
| async-storage (mcm-app) | flows | flows | flows, js majors | **tick**, `held async-storage major` |
| control: eslint, express, RNTL, openai | flows | flows | flows, js majors | flows, js majors (unchanged, no tick) |

**Backlog items (T037)** — filed by the coordinator: jest 30 → item #792; babel 8 → item #793;
typescript 7 → item #794; async-storage 3 → item #795.


### US6 (PR 6, express 5 + @types/express 5 + ioredis 6) — 2026-10-19

**Instruments**: REPO = `origin/main` `25bc4ed6`; NPM = `pnpm view` packuments on 2026-10-19; UPSTREAM =
the ioredis v6.0.0 GitHub release body and PRs #2127 (RESP3) / #2160 (connection defaults); the installed
`send` 0.19.2 / 1.2.1 and `@expo/server` 0.5.3 sources, read; IMAGE = `mcm-bff:latest` built from this branch.

**Targets (NPM).** express 5.3.0 (2026-10-09, already in the lock through Expo's tooling, so no new
package entered); `@types/express` 5.0.6; ioredis 6.0.0 (2026-07-31). All past Renovate's 3-day cooldown;
the install passed `Lockfile passes supply-chain policies` with no `minimumReleaseAgeExclude` entry. The
lock moved `ioredis 5.11.1 → 6.0.0`, `@ioredis/commands 1.10.0 → 2.0.0`, added
`@types/express{,-serve-static-core} 5`, `@types/serve-static 2`, and dropped `redis-parser`.

**M6 inventory (T043).** express is reached in exactly ONE file; ioredis in two source files and four
integration-test files. No TS source imports express or its types.

| Call site | What it uses | Breaking change that touches it | Outcome |
|---|---|---|---|
| `server.js` `app.all('*', …)` | the catch-all to the Expo handler | path-to-regexp v8: a bare `*` is rejected at boot (`Missing parameter name at index 1: *`) | **BROKE** — renamed `'/{*splat}'` (braces = `/` still matches) |
| `server.js` `express.static(DIST_CLIENT, …)` | static assets, `maxAge`/`immutable` | serve-static 2 changes the `dotfiles` default: it now ignores files INSIDE a dot-directory too | **BROKE, silently** — see below |
| `server.js` `app.disable('x-powered-by')`, two `app.use` header middlewares, `req.path`, `app.listen` | — | none of the v5 removals (`req.param`, `res.send(status)`, `app.del`, `res.redirect('back')`, …) are used | unchanged |
| `@expo/server/adapter/express` (0.5.3, vendored) | `req.protocol`, `req.get('host')`, `req.url`, `req.rawHeaders`, `res.status`, `res.setHeaders`, `next(err)` | none removed in v5; `req.query`'s new `simple` parser is irrelevant, the adapter builds a `Request` from `req.url` | unchanged; its d.ts still names `@types/express ^4` (devDependency only) |
| `cache-service.ts`, `transient-file-store.ts` `require('ioredis').default` | the default export as a constructor | none: 6.0.0 still exports `default === Redis` (measured) | unchanged |
| the commands used: `get/set EX NX/del/incr/incrby/expire/smembers/sadd/srem/scard/eval/getBuffer/quit` | reply shapes | RESP3 is the new default (`protocol: 3`); `replyMapping` defaults to `legacy`, so sets/maps still arrive as arrays. Redis is 8.10.2 in dev, CI and prod (HELLO 3 supported). The leader-lock `EVAL` returns an integer either way | unchanged — proven against real Redis by the integration tier |
| connection defaults (#2160) | none overridden | exponential reconnect backoff (5 s cap, jitter) instead of linear (2 s cap); TCP keep-alive 30 s instead of off | accepted: a faster-failing link check and slower retry storms, no behaviour the BFF relies on |
| Node floor | — | ioredis 6 needs Node ≥ 20 | BFF image runs Node 24 |

**T044 coverage gaps.** Eviction order is covered (`session-manager.test.ts` "evicts the oldest inactive
session…", plus the real-Redis `concurrent-session-cap.integration.test.ts`); every ioredis call site runs
against real Redis in the integration tier (unit tests mock ioredis). The gap was `server.js`: nothing
below the web E2E suite exercised it. New `tests/unit/bff-server-adapter.test.ts` boots the REAL
`server.js` in a child process with only the Expo handler stubbed (`tests/unit/fixtures/expo-adapter-stub.cjs`).
16 cases on express 4, all green; each group proved sensitive by a named `server.js` mutation:

| Mutation | RED |
|---|---|
| M1 `app.all('*'` → `app.get('*'` | the 4 POST/PUT/DELETE/PATCH forwarding cases |
| M2 `app.all('*', h)` → `app.use(h)` | `rejects a malformed percent-encoded path with 400 before the Expo handler` (a route decodes params; middleware does not) |
| M3 drop `app.disable('x-powered-by')` | the 4 header-middleware cases |
| M4 web CSP not path-scoped | `sends the web CSP … outside /bff-api only` |
| M5 `immutable: false` (run as `pnpm nx test mcm-app -- --testPathPattern='tests/unit/bff-server-adapter'`) | `serves a built asset with the production cache headers` |

**T045 RED (upgrade).** `pnpm nx typecheck mcm-app`: **0 errors** (nothing in TS touches express;
the BFF types its Redis client with its own `RedisLike`). `pnpm nx test mcm-app`: **16 failed / 1578
passed** — every case in the new file, because `server.js` died at boot with `PathError [TypeError]:
Missing parameter name at index 1: *`. The unit tier is blind to ioredis (mocked), so ioredis produced
no RED; its proof is T046's integration run.

**The silent break (IMAGE, new).** With only the route renamed, 15/16 passed; the one RED was the
characterisation case `serves a file inside a dot-directory` (serve-static 1 ignored only a path whose
LAST segment is a dotfile; serve-static 2 ignores dot-directories too). It first looked harmless — the
app has no `public/` — and the case was briefly flipped to pin the stricter rule. **That was wrong, and
building the image showed it**: `expo export` writes every dependency-shipped asset under
`dist/client/assets/node_modules/.pnpm/…` — **45 files, including the Outfit brand fonts and
expo-router's icons**. Under plain express 5 they would 404 to the Expo handler. No other test would
have caught it: `font-fallback.spec.ts` exists precisely to prove the app renders WITHOUT its fonts.
Fix: `server.js` sends a request whose last DECODED segment is a dotfile to the default (`ignore`)
static instance and everything else to a `dotfiles: 'allow'` one — serve-static 1's rule, reproduced.
The case was restored and three added (the real `.pnpm` asset path with cache headers; a dotfile
inside a dot-directory; `/%2Eenv`). Mutations: plain `express.static` (the bump without the fix) → the
two dot-directory cases RED; no `decodeURIComponent` → `/%2Eenv` RED; `allow` everywhere → the three
dotfile cases RED. **All 19 cases also pass against `origin/main`'s `server.js` on express 4.22.3**
(NODE_PATH pointed at that store entry), so the file characterises express 4 and the fix preserves it.

**T046 GREEN.**
- `pnpm nx typecheck mcm-app` 0 errors; `pnpm nx lint mcm-app` 0 errors (43 warnings, all pre-existing in `src/`, untouched);
- `pnpm nx test mcm-app`: **155/155 suites, 1597/1597 tests** (1578 + 19);
- `MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app` against auth + mcm (`app` + `bff-nonsecure`,
  the BFF built from this branch) + the backup destinations: **58/58 suites, 401 passed, 0 failed, 0
  skipped**. Two `agent-audit-opensearch` cases return early on `SKIP: OpenSearch unreachable` — the
  optional `audit` profile, which the preflight documents as legitimate and app-e2e does not bring up either;
- container smoke on `:8082`: the `.pnpm` font 200 `font/ttf`; `/` 200; `/bff-api/%E0%A4%A` 400; `/.env`
  404; `/bff-api/auth/user` 401 JSON; `X-BFF-Source` present, no `X-Powered-By`; web CSP on `/`.

**T047 (local part).** Web E2E in `mcr.microsoft.com/playwright:v1.63.0-noble` against the same BFF,
`E2E_TIER=gate`, 13 non-agent specs (auth incl. logout, **session-timeout**, security-headers,
font-fallback, collections, movies, settings, theme, account-deletion, backups, responsive, a11y,
admin-settings-access): **153 passed, 3 failed, 0 skipped**. All three fail waiting for
`assistant-dock-toggle` (a11y ×2, responsive ×1): the dock renders only once `agent-config-seed`
can seed a runnable config, which needs the agent stack and a model key that this local run did not
bring up (the runbook's "Tell"). The concurrent-session cap has no web spec; it is the
`concurrent-session-cap` integration case above (real Redis, audit events asserted). NOT run locally:
the agent specs, `dast` (`zap-scan.mjs` bind-mounts `security/zap` from the checkout, which the
Docker daemon cannot see from a worktree; CI's `dast` job runs the stronger FULL mode on this PR) and
`e2e:mobile:session-timeout` (a manual Maestro flow — no `/dev/kvm` in this sandbox, and CI does not run
it). express and ioredis run only in the BFF, not in the native client.

### US7 (PR 7a, copilotkit 1.79.1 + @ag-ui/client 1.0.2) — 2026-10-19

**Instruments**: REPO = `origin/main` `2b5ba71c` (PR #802, US6, merged); NPM = `pnpm view` packuments on
2026-10-19 12:00 UTC; PKG = the installed `@copilotkit/{react-native,react-core,core}` 1.70.1 and 1.79.1
`dist/` (types and JS), read side by side.

**Target (NPM).** `latest` = **1.79.1** (react-native 2026-10-15T23:30Z, runtime 23:31Z: 3.5 days old, past
Renovate's 3-day cooldown). 1.79.0 (10-12) and 1.78.0 (10-09) are older; nothing newer exists outside
`canary`. Both 1.79.1 packages pin **`@ag-ui/client` 1.0.2 exactly** (and `@ag-ui/core`/`encoder` 1.0.2), so
the app's direct pin is 1.0.2, not the 1.0.3 that is `latest` for `@ag-ui/client` (10-16). The newest new
transitive is `@copilotkit/channels-*` 0.11.1 (2026-10-16T01:32Z, also past 3 days). The install passed
`Lockfile passes supply-chain policies`, with no `minimumReleaseAgeExclude` entry.

**Lock delta.** +30 / −42 packages. `@ag-ui/client` went from **three** versions on `main`
(0.0.54, 0.0.59, 1.0.2) to **one** (1.0.2); `@ag-ui/core` likewise (1.0.2 in two zod-peer variants).
1.79.1's runtime adds `@copilotkit/channels-{core,intelligence,slack,teams,ui}`, `web-inspector`,
`a2ui-renderer`, `mcp-apps-renderer` and `@slack/bolt` (which drags an express 4 subtree in beside the
app's express 5; the BFF's own `server.js` still resolves express 5). `openai` stays 6.49.0 and the
copilotkit runtime still declares `@ai-sdk/openai ^3.0.36` itself, so PR 7b's premise (R7) is unchanged.

**T048 RED (upgrade).**
- `pnpm nx typecheck mcm-app`: **11 errors in 8 files, all one error**: `TS2344: Type '<Props>' does not
  satisfy the constraint 'StandardSchemaV1<unknown, unknown>'` at every `useRenderTool<T>(…)` call
  (disambiguation-options, multi-select-options, render-collection-summary, render-import-report,
  render-movie-card, request-import-file, selection-options, ui-action-tools ×4).
- `pnpm nx test mcm-app`: **155/155 suites, 1597/1597 passed — GREEN on the broken code.** See below.

**The breaking change, and why the unit tier was blind to it (PKG).** At 1.70.1 `@copilotkit/react-native`
shipped its OWN `useRenderTool` (`dist/useRenderTool-*.mjs`): a three-line wrapper that called react-core's
`useFrontendTool({ name, description, parameters, handler, agentId, render })`, so every MCM generative-UI
tool was a **frontend tool** carrying a renderer. 1.79 deleted it, and `headless.d.mts` now re-exports
**react-core's** `useRenderTool` under the same name. That hook is **render-only**: it calls
`copilotkit.addHookRenderToolCall(renderer)` and nothing else. It takes a schema type parameter
(`<S extends StandardSchemaV1>`, hence TS2344), has no `description`, and names the arguments `parameters`
(it also spreads the original props, so `args` still arrives at runtime).

So the bump without migration still draws every card. The renderer lands in the same `renderToolCalls`
registry that `useRenderToolCall()` reads, which is why 1597/1597 stayed green. But the tools silently
stop being frontend tools, and that is not cosmetic to CopilotKit core: `processAgentResult` acts on an
assistant tool call **only** when `getTool(name)` returns a frontend tool. Only the type change made it
visible. A "fix" that satisfied `tsc` the obvious way (rename `args` → `parameters`, drop the generic)
would have shipped the semantic change with every gate green.

**Coverage gap closed first (T048, same discipline as US6's T044).** New
`src/components/agent/generative-ui-tool-registration.test.tsx` mounts the eight registration hooks inside
the app's real `AssistantProvider` (nothing mocked) and asserts, for each of the 11 tools, (a) a frontend
tool with that name and a non-empty description, and no handler, and (b) a renderer in `renderToolCalls`:
- against **1.70.1** (jest `moduleNameMapper` pointed at the 1.70.1 store entry): **22/22**;
- against **1.79.1, unmigrated**: **11 failed / 11 passed**. Every "frontend tool" case fails with
  `expect(tool).toBeDefined()`, and every renderer case passes. This is the RED.

**T049 migration.** All 11 call sites call **`useFrontendTool<T>(…)` directly** — the exact registration the
removed wrapper made, with the same `args`/`status` render props (`args` partial on `InProgress`, which the
066 schema gates already handle) and the same `description`. Both versions of core append an empty tool
result and request a follow-up run for a handler-less frontend tool (`executeSpecificTool`, read at 1.70.1
and 1.79.1). Staying on `useFrontendTool` therefore keeps today's run behaviour rather than changing it as
a side effect of a dependency bump. Moving to the render-only hook is a separate product decision.
Lost: the old wrapper narrowed `render`'s return to `ReactElement | null`. `useFrontendTool`
returns `ReactNode`; every one of the 11 renders returns JSX or `null` today, and 1.79 offers the opt-in
`FrontendToolRenderFunction` annotation if that narrowing is wanted back. Test mocks that stubbed
`useRenderTool` now stub `useFrontendTool`; the comments that named the old hook are updated, and so is
the `run+api.ts` note on the single `@ag-ui/client`.

No other surface broke. `useAgent`, `useCopilotKit`, `useRenderToolCall`, `useInterrupt`, `CopilotKitProvider`
(`runtimeUrl`, `credentials`, `useSingleEndpoint`), the polyfill entry points, and the runtime's
`CopilotRuntime` / `ExperimentalEmptyAdapter` / `copilotRuntimeNextJSAppRouterEndpoint` all typecheck
unchanged. The `HttpAgent` → `agents` map still needs no cast, because the runtime and the app hold one
`@ag-ui/client`.

**T049 GREEN.**
- `pnpm nx typecheck mcm-app`: 0 errors;
- `pnpm nx test mcm-app` (`--maxWorkers=2`): **156/156 suites, 1619/1619** (1597 + 22);
- `pnpm nx lint mcm-app`: 0 errors, 43 warnings (the same pre-existing 43 as US6);
- the lockfile `packages:` section holds `@ag-ui/client@1.0.2` and no other version (`pnpm why @ag-ui/client
  -r` lists only 1.0.2).

**T050 keyless golden replay.** `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`: **51 passed, 0
failed, 0 skipped** (76 deselected by marker, as on `main`). The Python gateway is untouched by this PR. This
proves only that the cassettes still replay.

**Finding, pre-existing (not changed here).** `isBillableAgentRun` classifies by GraphQL `operationName`
(`availableAgents`/`loadAgentState`/`hello`). The client has run in `useSingleEndpoint` mode since 1.59,
and that mode posts `{"method":"info"}`, `{"method":"agent/connect"}` and `{"method":"agent/run"}` envelopes
with no `operationName` (core `createSingleRouteRequestInit`, 1.70.1 and 1.79.1 alike). So under
default-deny, every handshake POST is classified billable. 1.79 adds two more envelope methods,
`trajectory/connect` and `resource/request`, used by features this app does not enable. Recorded for the
coordinator; not in this PR's scope.

**T050 local `@gate` agent E2E (Ollama, no API spend).** The stack was the branch's `mcm-bff:latest`
(`X-BFF-Source: dev-container`) with the agent-e2e limit override, plus `agent-stack.mjs` with
`SPECIALIST_MODEL=qwen2.5` (gateway with production nodes on, three MCP servers, all built from the
branch). Playwright ran in `mcr.microsoft.com/playwright:v1.63.0-noble` from a staged named volume, with
`E2E_AGENT_PRODUCTION=1 E2E_REQUIRE_AGENT_STACK=1 E2E_TIER=gate`, across the 11 agent specs that carry
`@gate` (agent-card-navigate, assistant-navigate, agent-import-disambiguate, agent-cors,
agent-session-refresh, assistant-list-refresh, assistant-add, assistant-config, agent-import,
agent-navigate-collection, assistant-add-ambiguous). Result: **19 passed, 0 failed, 0 flaky, 0 skipped**.

Two runs before that one were INSTRUMENT failures, not results. Both are recorded because each reads
exactly like a client regression:
1. **No `TMDB_API_KEY` in the harness.** It lives only in `mcp-servers/web-api-mcp/.env.local`, which
   `agent-e2e.mjs` reads and a hand-built `docker run` does not. `agentSeedingEnabled()` was false, so
   global-setup silently skipped the seed. With no runnable config the dock never mounted, and every spec
   timed out on `assistant-dock-toggle`. Global-setup printed no "seeded" line, and that missing line is
   the tell.
2. **Seed rejected by the SSRF guard on the sandbox.** The BFF container resolves the default
   `http://host.docker.internal:11434` to `fe80::1`, which is link-local. `PUT /bff-api/agent/config` → 422
   *"That address is not allowed (link-local / cloud-metadata range)"*. Fix:
   `E2E_AGENT_OLLAMA_URL=http://172.18.0.1:11434`, the bridge gateway that devcontainer-sandbox.md §6
   names. Both the BFF and the gateway reach Ollama there, and it is a private address the guard allows.

**T050 CI.** PR #803 at `7ef32e82` is **mergeable, with every required context green**; the advisory `dast` is
green too.
- `app-e2e` gate tier (run 5628): **failed=0 flaky=0 passed=181 did-not-run=0 skipped=0**, contention
  0/0.
- The mobile agent flows run inside that green job.

**T050 model tier (dispatch).** `app-ci` was dispatched on the branch with `provider=anthropic` (run 5634, on
`7ef32e82`), and compared with `main`'s latest model-tier runs (counts bundles, `ci-failures` package):

| Run | Model tier | Gate tier | Turns (posts / 100 tests) |
|---|---|---|---|
| **5634, this branch** | **failed=0 flaky=1 passed=29 skipped=0** | failed=0 flaky=1 passed=180 | 220 / 211 → **104** |
| 5618, `main` `2b5ba71c` | failed=0 flaky=1 passed=29 skipped=0 | **failed=1** did-not-run=3 passed=177 | 215 / 208 → 103 |
| 5577, `main` `8ea70cab` | failed=0 flaky=0 passed=30 skipped=0 | — | — |

- **Model-tier failures ⊆ `main`'s: both are empty.**
- The one model-tier flaky test is the same test on both sides: `assistant-organize.spec.ts:107` (multi-item
  remove), passing on retry.
- The gate-tier flaky test, `assistant-add-ambiguous.spec.ts:78`, is the one that FAILED `main` run 5618
  (item #702). It passed on retry here. It also passed first time in the PR run and in the local Ollama run.
- The turn rate is unchanged, at 104 vs 103 gateway posts per 100 tests. That fits T049 keeping the
  frontend-tool registration (and with it any follow-up behaviour) exactly as it was. A behaviour change in
  either direction would have moved this number.

### US7 (PR 7b, openai 7.34.0; `@ai-sdk/openai` removed) — 2026-10-19

**Instruments**: REPO = `origin/main` `f45ea019` (PR #803, US7a, merged as `43e92656`); NPM = `pnpm view`
packuments at 19:22 UTC; IMG = the shared `mcm-bff:latest` (built 13:08Z today from the US7a tree: openai
6.49.0, the app's direct `@ai-sdk/openai` still declared); BUNDLE = `pnpm nx export-server mcm-app`'s
`dist/server` and its source map.

**Target (NPM).** `openai` `latest` is 7.39.0 (10-19). 7.35.0 to 7.39.0 are all under 3 days old. 7.35.0
was published at 10-16T20:29Z, about an hour short of the cooldown. The newest version past it is
**7.34.0** (10-14T21:34Z, 4.9 days). It is pinned in the lock and declared `^7.34.0`. The only breaking
change in 7.x is in 7.0.0: Node ≥ 22. The BFF runs node 24.21.0. `@ai-sdk/openai` 4.x would have been 4.0.95
(10-15), but it is not taken (T051).

**T051: removed.** The app has declared `@ai-sdk/openai` since `89ec0dae` (012) as an "eager-import
satisfier" for `@copilotkit/runtime`. It was never the copy the BFF loads:
- **BUNDLE.** Metro inlines `@ai-sdk/openai` into `run+api.js` from copilotkit's OWN dependency, the
  `@ai-sdk+openai@3.0.128_zod@3.25.76` entry. It is not an external specifier: `--check-bundle` lists 14
  dynamic specifiers and none of them is `@ai-sdk/openai`. The app's direct copy is the `(zod@4.6.7)` peer
  variant, and IMG's source map does not reference it.
- **IMG.** Inside the shared image, with the dependency still declared,
  `createRequire('/app/runtime/server.js').resolve('@ai-sdk/openai')` gives **MODULE_NOT_FOUND**. The prune
  had already removed it, and the agent route served anyway.
- **Removal.** `pnpm remove` drops 17 lock lines: the importer entry, the `(zod@4.6.7)` variant, and the
  `@ai-sdk/provider-utils@4.0.59(zod@4.6.7)` subtree that only that variant used. `pnpm why @ai-sdk/openai`
  went from 1 version in 2 instances to 1 instance, copilotkit's.
- **Prod image** built without it (`docker build -f frontend/mcm-app/Dockerfile`, private tag):
  - the prune keeps 77 packages (22.5 MB);
  - the bundle check gives 14 specifiers, 0 unaccounted;
  - in a container, `GET` and `POST /bff-api/agent/run` both return **401 JSON** `UNAUTHORIZED`, which means
    the route module, with `@copilotkit/runtime` and the inlined adapters, evaluated. The same image returns
    401 on `/bff-api/auth/user`;
  - the container log has no module error.

  IMG answers identically. `openai` constructs a client in both.

**T052 RED (upgrade), `openai` 6.49.0 → 7.34.0.**
- `node --test scripts/__tests__/prune-bff-runtime-modules.test.mjs`: **17/17, GREEN on the upgrade.** That is
  the instrument, not the code. The fixture builds a synthetic `openai@6.49.0` with no links, so no openai
  version could turn it red. What really changed shape is that openai 7 declares **`undici` as an optional
  peer** (`>=5 <9`; `require("undici")` in its x509 transport, reached only through the
  `openai/auth/x509-transport` subpath, not from the main entry). pnpm now links the workspace's
  `undici@6.29.0` beside it (`openai@7.34.0(undici@6.29.0)(ws)(zod)`).
- **Gap closed first, as in US6 T044 and US7a T048.** A new case asserts that the walk from the dynamic root
  ALONE (`computeClosure(nm, [], DYNAMIC_ROOTS)`) reaches `openai@7.*` and its `undici`:
  - against the old 6.x fixture: **1 failed / 17 passed** (`AssertionError: openai@6.49.0`). This is the RED;
  - fixture moved to the real 7.x layout (`openai@7.34.0_undici@6.28.0` plus the peer link): **18/18**.
- `pnpm nx typecheck mcm-app` gives 0 errors, and `pnpm nx test mcm-app` gives 156/156 suites and 1619/1619
  tests. Nothing in `frontend/` imports `openai`.
- **BUNDLE.** openai is ALSO inlined: `run+api.js.map` references **229** files of `openai@7.34.0` (154 of
  6.49.0 in IMG), beside the two external `__require("openai")` sites. So the bump does change the BFF's
  compiled code, not only `/app/runtime/node_modules`. `--check-bundle` gives 14 specifiers, 0 unaccounted.
- **Runtime tree.** `pnpm deploy --filter=mcm-app --prod --legacy` on the branch, then `--dry-run`:
  - 1460 → **77 packages**, the same count as T051 on openai 6;
  - the dynamic root adds `openai@7.34.0_undici@6.29.0_ws@8.22.0_zod@4.6.7`, `ws@8.22.0` and `zod@4.6.7`;
  - `undici@6.29.0` was already in the closure through `@expo/server`, so nothing new ships.

**`pnpm why undici` against the `undici@<6.27.0` override (M7).**
- Versions are unchanged: **6.29.0 and 7.30.1**, before and after.
- The override does interact, though not the way R7 assumed. pnpm applies a `undici@<6.27.0` selector to
  any range that INTERSECTS `<6.27.0`, and openai's peer `>=5 <9` does. The lock therefore records
  openai 7.34.0's peer as **`undici: '>=6.27.0 <7'`**, rewritten from the package's own range.
- Consequence: in this workspace only an undici 6.x ≥ 6.27 satisfies openai's peer, and it resolves to the
  6.29.0 that `@expo/server` and the AI SDK already use. That is the intended security floor, and no
  advisory-bearing undici can enter through this peer.
- Watch item: if the 6.x floor is ever retired while openai stays on 7, the peer would go back to `>=5 <9`.

**T053 GREEN (local).**
- The prune test: 18/18, 0 skipped.
- `renovate-workflow.guard.test.mjs`: 151/151. Its `@ai-sdk/openai` cases are rule-matching inputs, and they
  hold with the package gone.
- `pnpm nx lint mcm-app`: 0 errors, 43 warnings (the same pre-existing 43).
- **Prod-image route-load smoke on openai 7.**
  - A smoke-only derived image was used: IMG's pruned runtime, plus the branch's exported `dist/`, plus
    `openai@7.34.0` laid out the way deploy and prune lay it out (the `undici`, `ws` and `zod` sibling
    links).
  - Results: openai 7.34.0 resolves from `/app/runtime`; a client constructs;
    `require('openai/auth/x509-transport')` loads and pulls `undici` 6.29.0 through the peer link; agent
    route `GET`/`POST` return 401 JSON; no module error in the log.
  - A second full `docker build` was not run. The first one left about 6 GB of build cache that is
    `Shared: true` and cannot be pruned by ID, and it took the shared disk from 85% to 90%, over the
    sandbox's 88% stop line. CI builds the real image for `app-e2e` and `dast`.
- **NOT run locally: the `@gate` agent E2E.** No agent-gateway or MCP image exists in this sandbox, and
  `agent-stack.mjs` would build all four on a disk already over the line. CI's `app-e2e` runs the `@gate`
  agent tier against branch-built images.
- **NOT run: golden replay.** The Python gateway is untouched, so it would prove nothing about this PR.

**T053 CI.** PR #807 at `3cd2bd49` is **mergeable, with every required context green**. The advisory
`dast` is green too, and `trigger-cd` is path-gated (skipped).
- `app-e2e` gate tier (bundle 5649): **failed=0 flaky=1 passed=180 did-not-run=0 skipped=0**, contention 0/0.
  The flaky test is `agent-import.spec.ts:104` (`@gate`, passed on retry). It was not flaky in `main` run
  5645 or in this branch's dispatched run below. This flake has not been recorded on these runs before, and
  it is worth watching beside #702.
- The mobile agent flows run inside that green job.

**T053 model tier (dispatch).** `app-ci` was dispatched on the branch with `provider=anthropic` (run 5651,
whose ci-failures bundle is 5652, on `3cd2bd49`). It is compared with `main`'s latest model-tier run, the
push of `43e92656` (US7a merged):

| Run | Model tier | Gate tier | Turns (posts / 100 tests) |
|---|---|---|---|
| **5652, this branch** | **failed=0 flaky=2 passed=28 skipped=0** | failed=0 flaky=0 passed=181 | 220 / 211 → **104** |
| 5645, `main` `43e92656` | failed=0 flaky=3 passed=27 skipped=0 | failed=0 flaky=0 passed=181 | 222 / 211 → 105 |

- **Model-tier failures ⊆ `main`'s: both are empty.**
- `assistant-organize.spec.ts:107` was flaky on both sides, as it was in US7a.
- `agent-disambiguation.spec.ts:66` was flaky here only. On `main`, `agent-import-progress:78` and
  `agent-navigate-movie:87` were flaky instead. All of these are `@model-decision` and all passed on retry.
- The turn rate is unchanged, at 104 vs 105. That is expected, because openai is inlined but is not on the
  run path: the agent route uses `ExperimentalEmptyAdapter` and the LangGraph HTTP agent.
