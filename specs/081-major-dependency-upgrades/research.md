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

## R6. eslint 8 → 10 is a config-format migration, not a version bump

- DASH proposes `^8.57.0 → ^10.0.0` (two majors; 9.39.5 is `maintenance`). ESLint 9 made flat config the
  default; ESLint 10 removes eslintrc support. Both projects use `.eslintrc.json` and the lint target passes
  `--ext` (`frontend/mcm-app/project.json:36`), a flag flat config removes.
- `eslint-config-expo` peers `eslint >=8.10` at 56/57/58 and ships a flat entry point; `@typescript-eslint`
  8.71.1 peers `eslint ^8.57 || ^9 || ^10`. So eslint 10 is reachable at SDK 57 **without** TS 7.
- Requires node `^20.19 || ^22.13 || >=24` and a `jiti` peer for TS config files (only if the config is
  written in TS — it need not be).

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
