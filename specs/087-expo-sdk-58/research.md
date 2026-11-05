# Research: Move the App to Expo SDK 58

Evidence for the choice of approach is in the [proposal](../../docs/proposals/MCM-Expo-SDK-58-Approach.md). This file
records implementation decisions. Labels: **[M]** measured or read from installed source on 2026-11-05, **[D]** stated
in documentation, **[I]** inferred.

## What planning found that the proposal did not

1. **An accepted CSP violation already exists.** `web-security-headers.js` and feature 032 record one tolerated `eval`
   violation from a library's `new Function("")` probe. The spike's walks saw zero **[M]**, but the test user had no
   assistant configured, so the assistant chunk never loaded. A zero-tolerance test on an assistant page could fail on
   a known, accepted line. See R8.
2. **The budget target's cache ignores its own script. [M]** `nx.json`'s default input is `{projectRoot}/**/*` with
   empty `sharedGlobals`, and `bundle-budget` declares no inputs. A change to `scripts/check-web-bundle-budget.mjs`
   alone gets a cache hit, so a new assertion would report green without running. See R6.
3. **The existing one-copy guard cannot see this failure. [M]** Its lock regex stops at `(`, so two peer contexts of
   one version count as one. This is exactly the spike's blank-page case. See R5.
4. **`expo-server` has no dependencies. [M]** Removing `@expo/server` drops `undici`, `abort-controller`, `debug` and
   `source-map-support` from the prune closure. `undici` stays reachable through `openai`, which an existing prune test
   pins. Anything else is caught at image build by `--check-bundle`. See R2.
5. **The adapter's `mode` option no longer exists. [M]** The new one takes `{ build, isDevelopment? }`, defaulting to
   false. See R1.
6. **A launch result has no channel to read it from on a pass. [M]** Failure digests publish on failure, and this forge
   has no log or artifact API. See R10.
7. **A real login in the main Playwright project could evict other sessions. [I]** The BFF caps concurrent sessions per
   user, so the walk needs its own identity. See R8.

## R1: The scheme fix

**Decision**: wrap the handler in `server.js`, so the URL the adapter parses is already absolute:

```js
const expoHandler = createRequestHandler({ build: DIST_SERVER });
app.all('/{*splat}', (req, res, next) => {
  req.url = `${req.protocol}://${req.get('host')}${req.url}`;
  return expoHandler(req, res, next);
});
```

**Rationale**: `convertRequest` runs `new URL(req.url, `${proto}://${req.headers.host}`)`, with `proto` from
`socket.encrypted` **[M]**. An absolute `req.url` makes the base irrelevant. `req.protocol` honours `trust proxy` and
`req.get('host')` reads the raw `Host`, so all three scenarios hold, as measured in the spike **[M]**. This is the only
hook the adapter offers, and it survives on SDK 58 **[M]**.

**Effect on behaviour**: `mode` was the old adapter's only use of `NODE_ENV`, and dropping it leaves production
behaviour as it is. Thrown errors still go through `next(error)` to Express's default handler, which omits stacks under
`NODE_ENV=production`. The dev container runs `NODE_ENV=development`, as it does today.

**Alternatives**: composing the adapter's exported `convertRequest` and `respond` by hand would own more of its internals
for no gain. Setting `socket.encrypted` is a hack that lies to other readers of the socket.

## R2: Dependency and prune

**Decision**: `expo-server` becomes a direct dependency of `mcm-app` at the version `expo-router` already resolves
(^57.0.3 on PR A). `STATIC_ROOTS` becomes `['express', 'expo-server']`. Prune test fixtures move to the new name.

**Rationale**: an absent root is a hard failure in `prune-bff-runtime-modules.mjs` **[M]**, so without the direct
dependency the image build fails rather than the running app, which is the failure mode wanted. `renovate.json`'s
`/^expo-/` rule already holds it with the SDK **[M]**.

**Stale text to update**: `README.md:103,158`, `Dockerfile:112`, comments in `server.js`,
`e2e-turn-tally.sh:238`, `client-evidence.ts:8`, `e2e-testing.md:109,113,248`, `devcontainer-sandbox-lifecycle.md:440`.
The two script and fixture comments are history, and need only say which adapter they meant.

**To watch**: `e2e-testing.md` lesson 5 records responses lost to `Cannot pipe to a closed or destroyed stream` in the
old adapter's `respond`. The new `respond` guards `writableEnded` and `destroyed` **[M]**, so this may improve or may
change shape. The Express entry does not pass the abort `signal` that the plain `http` entry does **[M]**. Read the
counts from PR A's run rather than assuming either way.

## R3: Testing through the real adapter

**Decision**: `bff-server-trust-proxy.test.ts` stops using the stub and boots real `server.js` against a fixture
`dist/server`: a `_expo/routes.json` with one API route and a function that returns `request.url`. The test asserts on
the URL the route received. Express and `expo-server` resolve through `NODE_PATH`, as today.

`bff-server-adapter.test.ts` keeps its stub, because its subject is the Express layer in front of the handler. The
stub moves to the new id and **drops its `X-Test-Origin` echo**, which claimed to mirror the adapter and is why a green
test could hide item #843 **[M]**. Its URL assertions expect the absolute form.

**Rationale**: FR-003 requires a test that fails when the fix is removed. A full export takes minutes, while a fixture
is keyless and takes under a second. The manifest shape is declared by `expo-server`'s `manifest.d.ts` **[M]**.

**Verify RED**: remove the wrapper and the proxy case fails with `http://mcm.example.test/...`.

## R4: The healthcheck

**Decision**: all three BFF healthchecks become:

```text
wget -q --spider http://127.0.0.1:3000/bff-api/auth/init && wget -q --spider http://127.0.0.1:3000/login || exit 1
```

A guard asserts every BFF service in both compose files requests a page and an API route.

**Rationale**: BusyBox `--spider` sends `GET` **[M, T015: a listener in the image logged `METHOD GET`]**, which is why
`/bff-api/auth/init` passes although it answers a real `HEAD` with 405. This plan first said `HEAD`, which was wrong. `/login`
answers both, because `expo-server` matches `htmlRoutes` for `GET` and `HEAD` **[M]**.
`/login` is public and prerendered, so the probe is cheap on both output modes **[M: 9.4 to 11.8 ms]**. It can be
exercised deliberately: a copy of `dist` with `htmlRoutes` emptied gives API 200 and page 404 (SC-005).

**Note**: this PR changes runtime behaviour, unlike the proposal's "no runtime effect" entry for it, so it is in PR A.
`scripts/cd/health-probe.sh` already requests `/` and stays as it is.

## R5: One instance of the styling library

**Decision**: extend `tamagui-version-lockstep.guard.test.mjs`. A pure function counts distinct keys for `@tamagui/core`
and `@tamagui/web` in the lock's `snapshots:` section, peer suffix included. More than one fails and names the keys. It
is tested against a synthetic lock holding two peer contexts, which is the FR-010 proof.

**Rationale**: pnpm creates one directory per snapshot key, so the lock is authoritative. It needs no install and runs in
guardrails. `main` has one key for each today **[M]**.

**Alternative**: reading the built bundle's source map would catch the same thing later and only when the export runs.

## R6: Cold-load budget and inline-script gate

**Decision**: both go into `check-web-bundle-budget.mjs`, which already reads the export, and the target declares its
inputs:

```json
"inputs": ["default", "{workspaceRoot}/scripts/check-web-bundle-budget.mjs"]
```

- **Budget**: for every `dist/server/**/*.html`, sum the sizes of its external scripts under `/_expo/`. The worst page
  must be within `DEFAULT_BUDGET_BYTES`, and the report names it. No HTML, a page with no scripts, or a referenced file
  missing on disk are all failures, because each could otherwise read as clean.
- **Deferred and server-only assertions**: unchanged. They still need exactly one entry chunk.
- **Allowlist**: every `<script>` without `src` is hashed exactly as a browser does, over the raw body. Anything off the
  list fails and prints the page and the `'sha256-...'` value. Data blocks are not exempt; none exist **[M]**, and one
  appearing deserves a decision.
- **Shared source**: `web-security-headers.js` exports `INLINE_SCRIPT_HASHES`, which the CSP is built from. The gate reads
  it through `createRequire`, so the two cannot disagree.

**Rationale**: under `static`, HTML is fixed at export, so offline checks are exact. A regex suffices because `</script>`
ends raw text in the HTML grammar. HTML lands in `dist/server` **[D, M]**, so it is served through the adapter and not
by `express.static` with its `immutable` header. The walk pins that (R8).

**Budget note**: 96.3% on the SDK 58 spike (1,925,703 B) **[M]**. A rise beyond it is a deliberate change that quotes
before and after, per the spec.

## R7: Output configuration

**Decision** (PR C), as run in the spike **[M]** and matching the docs **[D]**:

```json
"web": { "output": "static" },
"plugins": [
  ["expo-router", { "apiRoutes": true, "asyncRoutes": { "web": false } }],
  ["expo-build-properties", { "android": { "enableMinifyInReleaseBuilds": false } }]
]
```

The render-failure claim was read from source but never executed **[M, source only]**, so PR C proves it: a page that
throws at render must fail `nx export-server`, quoted once in `tasks.md` and reverted.

## R8: The browser walk

**Decision**: new `page-security-policy-walk.spec.ts`, tagged `@gate`, in the `lifecycle` Playwright project, using a
throwaway identity as `admin-registration.spec.ts` does. It covers sign-in, hard reload, a deep link to a collection it
created through the BFF, then in-app navigation. Teardown is by BFF API in `afterEach`. Zero tolerance here, matching
FR-009 and the spike's conditions.

`fixtures/security-policy-watch.ts` records `securitypolicyviolation` through an init script and `pageerror`, and provides
three checks each run depends on:

1. **Right server**: the response carries a CSP and `X-BFF-Source` names a container. Metro sets neither, and a walk under
   Metro would pass having tested nothing. Locally that is a visible skip; with `CI` set it fails.
2. **The instrument can see**: an injected inline script must produce a violation first, then the list is cleared.
   The spike's negative control proved this once, and this repeats it every run.
3. **Public behaviour**: `/no-such-page` answers 404 (US3 scenario 5), and a page's `Cache-Control` has no `immutable`.

**Assistant path**: the walk's user has no assistant, so the assistant chunk would go unchecked. One existing streamed
test, `navigate → the assistant opens the named collection screen` in `assistant-navigate.spec.ts`, also uses the watch.
It is `@gate`, and its verdict comes from a tool call the app renders. It has one permitted exception:
`blockedURI === 'eval'`, directive `script-src`, source the assistant chunk, at most two per document. Anything else fails.

**Rationale for the exception**: it was accepted in feature 032 and is documented beside the hash. `'unsafe-eval'` is not
added. A failure there would mean something other than those known lines. This goes beyond the spec's walk, so it needs no
spec change, but the operator should know it is there.

**Corrected in T027 [M]**: this plan said one per document, as feature 032 did. The real path fires two, because the assistant
chunk holds two copies of zod (`zod@3.25.76`, through its `v4/` subpath, and `zod@4.6.7`), each with its own `new Function("")`
probe in a try/catch. Removing a copy would be a dependency change outside this feature.

**Alternatives**: extending `security-headers.spec.ts` was rejected because it deliberately has no session. Running the
walk in the main project risks session eviction. Giving the walk's user an assistant would mix a model-dependent path
into a test whose verdict should depend only on our code.

## R9: Android launch check

**Decision**: `scripts/android-launch-smoke.sh` runs inside the existing emulator step, between `adb install` and the
agent flows (one added `script:` line, since that step runs line by line). It:

1. clears logcat and runs `am start -W -n com.grumpyrobot.mcmapp/.MainActivity`, requiring `Status: ok`;
2. polls `uiautomator dump` for `login-screen` with a bound;
3. fails on `FATAL EXCEPTION`, `ClassNotFoundException` or `NoSuchMethodException` naming the app's process;
4. prints one evidence line per check and force-stops the app, so the flows start cold.

Its log classifier is a separate function with a selftest over sample lines, since a grep that matches nothing looks
identical to a pass.

**Rationale**: `app-e2e` already builds a release APK and boots an emulator, so adding the check costs seconds and it
stays for every later SDK. It lands in PR B to run first on an APK expected to work.

**Scope note**: this APK is `x86_64` and points at local hosts. It proves the release build runs; the shelf APK with
production URLs is a different build, covered by the operator check in the quickstart.

## R10: Getting launch evidence out of CI

**Decision**: `scripts/publish-android-launch.mjs` posts one commit status, `app-ci / android-launch`, with a one-line
description such as `launch=ok login-screen=visible fatal=0`. It is modelled on `publish-sweep-verdict.mjs`, including
`github.token` and a mutation-tested mapping. It is not a required context: branch protection's globs do not match it
**[M]**, and the step's own exit code is what blocks.

The emulator step can't export outputs, so the launch check writes its result to `$HOME/android-launch-$GITHUB_RUN_ID.json`.
The run ID in the name means a persistent runner can't serve a stale result. The status step carries the same `if:` gate as
the emulator step, so **a PR that skips the emulator posts nothing**. If the gate is true and the file is absent, the emulator
never reached the check, and the status reads `launch=not-run` as `failure`.

**Rationale**: the task list must quote results with run numbers, and without a channel the only source on a pass is a human
reading a log page. A narrow status with the job's own token is measured to work, while the digest's status branch
needs a wider scope and 403s **[M, recorded in that script]**.

## R11: Upgrade mechanics (PR C)

**Decision**, following the spike's working order **[M]**:

1. `expo install expo@^58.0.0 --fix` in `frontend/mcm-app`.
2. Move together: `react`, `react-dom` in both manifests and the `react-dom` override; `@expo/dom-webview` override to
   `^58`; `react-native`, `jest`, `jest-expo`, `@types/jest`, `@types/react`, `eslint-config-expo`, `test-renderer` in the
   design system.
3. `pnpm dedupe`, then a frozen install, then the one-instance guard. A stale `react-native-safe-area-context` lock entry
   was the cause in the spike **[M]**.
4. Change `app.json` (R7). `expo-build-properties` arrives with US4's RED and GREEN, so that task repeats the frozen install
   and the one-instance guard, because any later lock change could bring the second copy back.
5. Fix type errors. The spike found six **[M]**: `no-autofill-input.tsx:86`, `AssistantPanel.tsx:313,316`,
   `SearchBar.tsx:115`, `TextField.tsx:216`, `AppBar.tsx:119`.

**Whole-board-red risk**: Renovate's 3-day cooldown does not cover what lock regeneration drags in, and a supply-chain
rejection there looks like six failures at once. Suspect the install first.

## R12: Renovate rules an SDK move triggers

| Rule (`renovate.json`) | Action at SDK 58 |
|---|---|
| `test-renderer` held below 1.3 (:866) | **Lift**: delete the rule; update its guard at the cause |
| `jest`, `babel-jest`, `@types/jest` major (:907) | **Lift**: jest-expo 58 depends on jest 30 **[M, recorded in the rule]** |
| JDK at 17 (:635) | Re-check against RN 0.88's gradle plugin. Run 6802 built on 17 **[M]**, so expect to keep it |
| Babel 8 (:938) | Re-read `babel-preset-expo`'s peers; lift only if they have moved |
| `async-storage` 3 (:973) | Re-read `bundledNativeModules.json`. 58.0.14 listed 2.2.0 **[M, recorded in the rule]**, so expect to keep it |

The re-checks are one-line evidence in `tasks.md`. Guards in `renovate-workflow.guard.test.mjs` move with their rules, and
are not deleted.

## R13: Android build settings

**Decision**:

- **Heap**: copy #933's user-level `gradle.properties` block into `app-ci.yml`'s `build-apk` step, and make
  `prod-apk-gradle-heap.guard.test.mjs` check both jobs. Only the `prod-apk` path has been measured with it **[M: run
  6802]**. The `app-e2e` path also sets `GRADLE_OPTS=-Dorg.gradle.daemon=false`, so PR C's run is its first proof.
- **R8 guard**: a new guard reads `app.json` and fails unless the opt-out is present and false, with synthetic inputs proving
  both failures. Its error points at item #937.
- **Gradle**: `toolchain.Dockerfile`'s `GRADLE_VERSION` moves to 9.4.1, along with the paths in `android-emulator.md`.
  Prebuild's wrapper asks for it **[M]**, so CI needs no change. Rebuilding the image is an operator step, and it does not
  block PR C, because the sandbox can't build the app either way.
- **Cleartext**: `with-dev-cleartext` works on SDK 58 prebuild unchanged **[M]**; PR C re-confirms the generated
  `network_security_config` lists only local hosts (FR-023).

## R14: Measuring SC-002

**Decision**: use `specs/087-expo-sdk-58/tools/measure-page-latency.mjs`, the spike's dependency-free tool with the shared
rejecting argument parser. Its defaults are the spike's: `/login`, 300 requests, concurrency 10. Run it on `main` before PR C
and on PR C's export, on the same machine and through real `server.js`. `nx test:load` is not used, because it measures auth and collection flows rather than a page.

**Rationale**: the figures are ratios from one process **[M]**, so only a same-machine comparison means anything. The
11.8 ms and 138 MB baselines in the spec are starting points, replaced by M1.

## R15: `expo-doctor`

**Decision**: PR C adds a non-blocking step to `app-ci.yml`'s `affected` job, running only when the app is affected.

**Rationale**: the constitution requires regular audits, yet no workflow or script runs it **[M]**, and it errored in the
spike's sandbox without a usable report. It depends on Expo's API, so a required step would let an outside service block
merges. If CI can't reach that API either, record it and ask the operator rather than treating it as a pass.

## Open item: the two Jest 30 failures

Both `server.js` suites fail under Jest 30 with `You are trying to require a file outside of the scope of the test code`,
thrown through a lazy global getter in `expo`'s runtime, between tests **[M]**. All 1,707 tests pass, but the suites
themselves report failed. The trigger has not been traced.

**Decision**: diagnose in PR C. These suites need nothing from the Expo preset, so the likely fix is to stop the lazy
getters being reached during their teardown. They are never skipped (FR-016). If moving them to another runner is the
cleanest fix, they stay in a required tier with their assertions unchanged.

## Stage-start measurements

| | When | What | Expected |
|---|---|---|---|
| M0 | PR C start | `git diff` of `pnpm-lock.yaml` since the spike's base; open `renovate/` PRs | No conflict with the alignment list |
| M1 | PR C start | R14 on `main` | Replaces the SC-002 baselines |
| M2 | PR C start | Latest `expo@58` and `expo-router@58`, age against the release-age policy | A version old enough to install |
| M3 | PR C start | Bundle gate on `main` after PR B | Cold-load figure for the before-and-after |

## Not resolved here

These stay unknown until something runs them, as the proposal recorded:

- Whether an SDK 58 APK launches (PR C, launch check).
- A streamed turn on the new adapter (PR A's gate tier).
- Real proxy behaviour (PR A, production check).
- `expo-doctor` (PR C, CI).
