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
| **NEW drift, not in R1** | — | js-majors group now also carries **`tamagui`, `@tamagui/config`, `@tamagui/core`, `@tamagui/shorthands`, `@tamagui/stacks` ^2.3.0 → ^3.0.0** | not US3's; recorded for the story that owns the design system / US5 re-scope |
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
- Tamagui: **untouched** (still `^2.3.0`); `--fix` does not manage it. Tamagui 2 → 3 is its own later stage.

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
