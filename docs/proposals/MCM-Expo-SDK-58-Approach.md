# Moving MCM to Expo SDK 58: recommended approach

**Status:** option chosen 2026-11-05: `static` + `apiRoutes`, as recommended below. Specified in [`specs/087-expo-sdk-58/`](../../specs/087-expo-sdk-58/spec.md).
**Measured:** 2026-11-05, against `main` at `29f15101`, in a throwaway worktree that has since been removed.
**Evidence labels:** **[M]** measured here · **[D]** stated in Expo or React Native documentation · **[I]** inferred.

## 1. Recommendation

**Move to SDK 58 using `web.output: "static"` with `apiRoutes: true`, keep the BFF inside Expo, and turn R8
and web async routes off for the first release. Land the Express adapter change and three new gates on
SDK 57 first.**

The reason is that this mode reproduces what production does today, and the numbers show it:

| On the real app, real `server.js` adapter layer | SDK 57 today | 58 `server` | 58 `static` + `apiRoutes` |
|---|---|---|---|
| HTML generated | at export | per request | at export |
| `/login` p50 at concurrency 10 **[M]** | 11.8 ms | 50–54 ms | 9.4 ms |
| Throughput **[M]** | 700 req/s | 175–196 req/s | 957 req/s |
| Server memory after load **[M]** | 138 MB | 469 MB (plateau) | 145 MB |
| Inline scripts / CSP change needed **[M]** | 1 / none | 1 / none | 1 / none |
| A render error surfaces **[M, source]** | at export | at request time, logged | at export, fails the build |

MCM's auth is client-side, so a server render knows nothing about the member. Per-request rendering would
spend four to five times the latency and three times the memory to produce the same signed-out shell, on an
endpoint anyone can hit without logging in.

The BFF split is viable and cheaper than expected (section 3.2), but SDK 58 does not need it. It is worth
keeping as a separate decision.

**One thing is not proven: no SDK 58 APK has been launched.** A release APK with R8 off does build in CI
(section 6). Launch behaviour, including the new gesture-handler and React Native event path, is untested.

### What would change my mind

- **Toward the split:** a future SDK breaks `static` + `apiRoutes`, or `server.js` breaks a third time on an
  SDK move. This round found two silent breakages there (section 2).
- **Toward `server` output:** a concrete need for per-request data in the HTML, such as route loaders. None
  exists today.
- **Toward waiting:** the first CI APK fails in a way that needs an upstream fix, or the authenticated agent
  turn (section 6) fails on the new adapter.
- **Toward R8 now:** a move to Play Store distribution, where its warnings matter.

## 2. What the spikes found that the brief did not anticipate

These change the plan more than the three named risks do.

1. **The adapter change breaks production sign-in flows silently. [M]** `expo-server`'s adapter builds the
   request URL from `req.socket.encrypted` and ignores `req.protocol`. With `TRUSTED_PROXY=true` and
   `X-Forwarded-Proto: https`, the URL stays `http://`. Backup consent and account-deletion would again send
   Keycloak an unregistered `http://` redirect URI: item #843, back again.
   `tests/unit/bff-server-trust-proxy.test.ts` would stay green, because it boots against a stub adapter that
   echoes `req.protocol`.
   **Tested fix:** set `req.url` to `` `${req.protocol}://${req.get('host')}${req.url}` `` before calling the
   handler. Measured results: the scheme is restored, `X-Forwarded-Host` has no effect, the scheme stays
   `http` without a trusted proxy, and pages and API routes still route correctly.
2. **The old adapter fails in a way the container healthcheck cannot see. [M]** On 58 `server` output,
   `@expo/server@0.5.3` serves API routes with 200 and **every page with 404**. The compose healthcheck
   requests `/bff-api/auth/init`, so it passes. `scripts/cd/health-probe.sh` requests `/` and would catch it.
3. **A duplicate Tamagui instance produces a blank page. [M]** `expo install` upgrades only the app. The
   design system's devDependencies and a stale `react-native-safe-area-context@5.7.0` lock entry gave it a
   different peer hash, so two `@tamagui/web` instances loaded (`main` has one). Every page rendered zero
   nodes with `Missing theme`. The export and the API routes both still succeeded, and
   `tamagui-version-lockstep.guard.test.mjs` checks versions rather than instances. `pnpm dedupe` fixed it.
   React must also be aligned by hand in the design system, the `react-dom` override and the
   `@expo/dom-webview: ^57` override, or the export dies with React error #527.
4. **The bundle budget gate goes blind under async routes. [M]** It reports 56% because it measures only the
   `entry` chunk. Real cold-load bytes on `/login` are 1,810,020 across 5 scripts, against 1,891,928 in one
   script today. The app did not shrink by 40%; the gate stopped seeing most of it.
5. **`app-ci` has no Gradle heap override. [M]** Item #933's `-Xmx4g` fix is in `cd-deploy.yml` only.
   `app-e2e` still builds at the template's `-Xmx2048m`, the setting that hung `prod-apk` for 60 minutes.
   R8 adds memory on top of that. **[I]**

Good news from the same runs **[M]**: typecheck shows only 6 errors (R4 predicted 15 press-event errors, which
did not appear). Jest 30 passes 160 of 162 suites and all 1,707 tests, plus 131 of 131 in the design system.
ESLint has 0 errors and 49 warnings. `decode-uri-component` leaves the lockfile (0 entries, 3 on `main`).

## 3. Options for each risk

### 3.1 Risk 1: per-request rendering

SDK 57 already renders every route in Node, at export. **[M]** It wrote 17 HTML files, with React Native Web
and Tamagui running on the server. So "RNW and Tamagui would render on the server" is already true today. What
changes in `server` mode is when a failure appears, and the cost per request.

| Option | Works on the real app? | Effort **[I]** | What it rules out |
|---|---|---|---|
| **A. `server`** | Yes **[M]**, with new adapter and one Tamagui instance | Low | Export-time failure of render errors; low memory; cheap unauthenticated pages |
| **B. `static` + `apiRoutes`** (recommended) | Yes **[M]**, including dynamic routes without `generateStaticParams` | Low | Per-request data in HTML, such as route loaders |
| **C. `single`** | Yes **[M]**, only with the BFF moved out. `single` + `apiRoutes` is refused: *"requires `web.output` to be set to `static` or `server`"* | High | Any pre-rendered shell; real 404 status (`/no-such-page` returns 200) |

**Browser-only code (question 4).** If `server` were ever kept, the code needs little restructuring. The app
already passed 20 routes over 5 cold rounds with no render errors **[M]**: the 12 files using browser globals
are either guarded or touch them only in event handlers and effects. Convention would not be enough, so these
gates would go in:

- An ESLint `no-restricted-globals` rule for `window`, `document`, `localStorage` and `sessionStorage` at
  module scope and in render paths under `src/`, with `.web.tsx` and effect bodies allowed.
- A required server-render sweep of every route in the routes manifest, failing on any 500 or
  `SSR streaming render error` log line.
- The `pageerror` assertion from section 3.3.

Under option B the first gate is optional: `renderStreamingContent` rethrows any render error during a static
export, so the build itself fails. **[M, source; not executed]**

### 3.2 Should the BFF leave the Expo Router server? (question 2)

The spike bundled the real 38 routes with esbuild and hosted them on plain Express with no Expo code, serving
the `single` output from the same process.

- **Coupling is minimal. [M]** `src/bff-server/` and `src/app/bff-api/` import nothing from `expo*`. One file
  reaches `react-native`, `src/config/keycloak.ts`, for `Platform`. The bundle took 57 ms and is 273 KB.
- **Behaviour matches on what could be tested. [M]** 110 of 112 unauthenticated requests matched Expo-hosted
  responses in status, body and security headers, across 56 handlers. The 2 differences came from my naive
  route ordering (`/destinations/test` vs `/destinations/:id`), a real trap for any hand-written router.
- **Deployment need not change. [I]** One process, one image, same `cd-deploy` flow. "Split" means leaving
  Expo's server, not adding a container.

| Concern | Stays in Expo | Own server, Expo builds the client |
|---|---|---|
| Routing | File routes, 38 `+api.ts` | Own table and ranking; `route-coverage` gate must be rewritten |
| Auth and session | Unchanged | Unchanged in code; re-proven through an adapter we then own |
| Local dev | Metro serves the BFF on 8081 | A second process; native dev and E2E modes change |
| Security headers | `server.js` plus adapter | Simpler, and `script-src 'self'` needs no hash **[M]** |
| CD pipeline | No change | Dockerfile, prune script and bundle gate change **[I]** |
| Future Expo upgrades | `server.js` keeps absorbing them | Exposure drops to the client build |
| `import.meta` shim, `--check-bundle` | Still needed | Removable; real `node_modules` imports **[I]** |
| Risks 1 and 2 | Managed | **Removed outright** with `single`: no SSR, 0 inline scripts **[M]** |
| New costs | None | No pre-rendered shell, HTML 1.4 KB vs 42 KB, no 404 status, ~1–2 weeks **[I]** |

**Verdict:** a sound option, but not a prerequisite. Option B already reduces risks 1 and 2 to a gate and a
constant hash. Revisit it on the triggers in section 1.

### 3.3 Risk 2: Content Security Policy (question 3)

**The script did not change. [M]** The same `globalThis.__EXPO_ROUTER_HYDRATE__=true;` body gives the same
`sha256-67fhrP0+…` hash on SDK 57, 58 `server` and 58 `static`. Only its attributes changed
(`type="module"` became `id="_R_"`), and a hash covers the body only. A full cold sweep of 20 routes found one
distinct inline script and no React streaming markers. The authenticated walk had 0 violations. A negative
control with the hash removed did report the violation, so the probe can see one.

**The failure mode is milder than feared. [M]** With the script blocked, `/login` and `/home` still rendered
and became interactive, with `__EXPO_ROUTER_HYDRATE__` false. A wrong hash would mean a logged violation and a
client-side render, not a blank page. That is a safety margin only, not a reason to drop the hash.

| Approach | `server` | `static` + `apiRoutes` | `single` |
|---|---|---|---|
| **Hash** | Works today. Could break if Suspense streams late (`allReady` is not awaited) **[I]** | **Works, recommended.** HTML is fixed at export, so the gate can check it offline | Not needed |
| **Nonce** | **Blocked:** no `nonce` anywhere in `expo-router`, `@expo/router-server` or `expo-server` **[M]**, so it needs a patched renderer or stream rewriting | **Blocked:** a static file cannot carry a per-request nonce without rewriting it | Not needed |
| **External only** | Not possible: React emits the bootstrap script | Not possible, same reason | **Automatic:** 0 inline scripts **[M]** |
| `'unsafe-inline'` | Rejected | Rejected | Rejected |

**One condition to keep:** `getBootstrapContents` embeds `loadedData` in that script. **[M, source]** Adopting
data loaders would make its content, and so its hash, vary per route. That is a reason to treat "no loaders" as
a gated assumption.

**Gate:** extend `bundle-budget` to hash every inline `<script>` in `dist/server/**/*.html` and fail on anything
not allow-listed. Add a `@gate` spec that fails on any `securitypolicyviolation` or `pageerror` during an
authenticated walk. Today's `security-headers.spec.ts` checks that headers exist, not that the page obeys them.

### 3.4 Risk 3: Android release build (question 5)

| Option | For | Against |
|---|---|---|
| **R8 off first** (recommended) | One variable at a time; `expo-build-properties` flips it **[M: prebuild gives `android.enableMinifyInReleaseBuilds=false`]** | New dependency, and one to remove later |
| R8 on from the start | Template default **[D]** | A launch failure would be indistinguishable from an AGP 9, Kotlin or gesture-handler 3 failure; more Gradle memory |
| R8 never | Simple | Goes against the template's direction; Expo may stop optimising for it **[I]** |

**Does R8 help this app enough? Not yet. [I]** The APK is side-loaded through `publish-apk`, not sold through a
store, and R8 only shrinks Java and Kotlin code, not the JS bundle or the `.so` files. Adopt it separately, with
the before-and-after size measured, once a mapping file is kept for crash traces.

**Static audit of reflection risk [M]:** `reanimated`, `screens`, `svg`, `worklets`, `expo` and
`expo-modules-core` (26 keep rules, uses `kotlin-reflect`) ship consumer rules, and React Native ships 22 keeps.
**`react-native-gesture-handler` and `async-storage` use `Class.forName`/`getMethod` and ship no consumer
rules.** Those two are what the R8 test must exercise.

**Smallest proof of a working release APK.** Build it with `pnpm nx run mcm-app:build-apk` and
`APK_VARIANT=release` in CI, then on an emulator:

1. `adb install`, then `am start -W`. Launch completes.
2. `logcat` shows no `FATAL EXCEPTION`, `ClassNotFoundException` or `NoSuchMethodException`.
3. The login screen's `testID` appears in a `uiautomator dump`.
4. Maestro's existing login flow completes through Chrome Custom Tabs.

For the R8 change, add the agent flows too, which is what `app-e2e` already runs with label `mobile-e2e`. Note
that 081's T028, this same check for SDK 57, was never ticked. **A required evidence line belongs in the tasks.**

**Should `ANDROID_API=34` move? No, not for this. [M]** The dev container cannot build APKs at all (section 6),
so `compileSdk` 37 is never needed there, and CI's emulator is separately set to `api-level: 34`. A targetSdk 36
APK runs on API 34. Two things must move: **baked Gradle goes from 9.3.1 to 9.4.1**, because prebuild's wrapper
asks for 9.4.1 **[M]**, and `app-ci` needs the #933 heap setting. Testing on a newer API image is worth its own
item: nothing here exercises API 35+ behaviour today, on SDK 57 either.

**Plugin status [M]:** `with-dev-cleartext` works on SDK 58 prebuild unchanged. Prebuild also generates AGP 9's
`android.builtInKotlin=false` and `android.newDsl=false` opt-outs, which React Native says AGP 10 removes **[D]**.

## 4. Sequence

Each change lands and reverts alone. Changes 1–3 are useful even if SDK 58 never happens.

| # | Change | SDK | If it breaks prod |
|---|---|---|---|
| 1 | **Adapter:** move to `expo-server/adapter/express` with the scheme fix; add a trust-proxy test using the **real** adapter; update prune roots and stub | 57 **[M: works on the SDK 57 export]** | Revert; image rollback via `cd-deploy` |
| 2 | **Gates, keyless:** one `@tamagui/web` instance; inline-script allowlist; cold-load budget from the entry HTML's script list; compose healthcheck also requests a page | 57 | Revert; no runtime effect |
| 3 | **Runtime gate:** `@gate` CSP and `pageerror` walk through sign-in, deep link and client navigation | 57 | Revert; no runtime effect |
| 4 | **SDK 58 itself:** `static` + `apiRoutes`, `asyncRoutes: { web: false }`, R8 off, workspace-wide React and override alignment, `pnpm dedupe`, 6 type fixes, Jest 30 (lifts #792), `test-renderer` 1.3, baked Gradle, `app-ci` heap, **constitution amendment** | 58 | Revert the promotion for web (no data migration **[I]**); previous APK for Android |
| 5 | **R8 on**, with size measured and mapping file retained | 58 | Revert to the opt-out; previous APK |
| 6 | **Async routes on**, if the cold-load gate from change 2 shows a gain | 58 | One config line |

**Why change 4 cannot be split further. [M]** `apiRoutes` exists only from SDK 58, so the rendering-mode change
cannot land first, and React, Tamagui peers and companions move as one lockfile. Per the repo's PR-batching rule,
that one PR needs the same quiet-lock protocol US4 used.

**Why async routes start off. [M]** Off, the app ships a single 1,925,703-byte entry. That matches today's shape,
and the walk passed. It sits at **96.3% of budget, with 74 KB spare**, so the budget may need a deliberate raise.
On, cold load is about 115 KB smaller, but there are five scripts on first paint, and a tab left open across a
deploy could request a chunk that no longer exists. **[I]**

## 5. Cost of waiting (question 7), and "stay on 57"

| Factor | Finding |
|---|---|
| Security | Does not force timing. Renewing the `decode-uri-component` entry before 2026-12-01 is cheap |
| Expo support window | **No fixed policy found**, in the docs, the FAQ or a search. Patch history **[M]**: SDKs 54–57 all last patched 2026-10-21; SDK 53 stopped 2026-02-10, about two weeks before SDK 55 |
| SDK 59 | Three SDKs a year **[D]**; recent releases Feb, May, Jun and Sep 2026 suggest early 2027 **[I]**. Skipping 58 would mean two SDKs of change at once |
| React Native | 0.85 went unsupported when 0.88 shipped **[D]**, so 0.86 follows when 0.89 does. Last gap was 69 days, suggesting late December **[I]** |
| RN 0.89 | Legacy TS opt-out ends after 0.88; removal of the legacy event path is "expected with the follow-up"; SwiftPM becomes default (no iOS release here) **[D]** |
| Expo Go | New version supports only SDK 58 **[D]**. Not relevant: MCM uses release APKs |
| Maturity | 23 `expo` patches in 35 days. `expo-router` went from 58.0.17 to 58.0.30 between R4 and now **[M]** |
| Holds | Jest 30 (#792), `test-renderer` stay held while on 57 |

**"Stay on 57" is a legitimate short-term position.** It costs little for a month or two, and changes 1–3 land
either way. Its limit is RN 0.86 leaving support, plausibly around year-end. I recommend starting change 4 once
1–3 are merged rather than on a date, since all the web evidence is already favourable.

### Secondary risks under this approach

| Risk | Effect |
|---|---|
| Jest 30 | Becomes required, and is much smaller than feared. The 2 failing suites are both `server.js` tests hitting a Jest 30 scope error from Expo's lazy globals **[M]**; worth fixing properly, since they guard that file |
| Gesture-handler 3 | App source imports it nowhere. It arrives through `@gorhom/bottom-sheet` and CopilotKit, whose peer ranges admit it **[M]**. Native behaviour is **unverified**, and it is also an R8 risk |
| RN event dispatch | Native only, with no public opt-out **[D]**. Nothing in `src/` reaches event internals **[M]**, but only Maestro can prove it |
| Async routes vs budget | Deferred to change 6; the gate gets fixed first |
| Safe-area insets on web | 4 files use the library. All walks rendered without errors **[M]**, but nothing checked notched layouts. CSS `env()` is the documented route **[D]** |
| SDK 58 maturity | Reduced by exact pinning and by keeping changes 5 and 6 separate |

## 6. What was measured, how, and what is still unknown

**Method.** Worktree on `origin/main`, full install, `expo install expo@^58.0.0 --fix`, then manual workspace
alignment. `expo export` for each mode, booted with the real `server.js` and `web-security-headers.js`. Chromium
1.63 from the official Playwright image, on the host network. The SDK 57 export went through the same probe first,
as a control.

**Authenticated walk [M], on `server` and on `static` with async routes on and off:** real Keycloak sign-in →
`/home` → hard reload → created a temporary collection and loaded its dynamic deep link → deleted it (204) →
`/settings/backups` → client navigation to `/settings/assistant`. Result: 0 CSP violations, 0 page errors, no 5xx.
The only cookie was `mcm_session_id`, `HttpOnly`, `SameSite=Strict`. The agent route answered without hanging
(`400 Missing method field` from the CopilotKit runtime).

**Instrument errors caught along the way:** a stale server answering on a reused port produced 49 false differences
in the split test, and a broken `watchman` made Jest exit without running anything. Both results were discarded and
rerun. The blank-page finding was traced to my own partial alignment, then kept because the real PR can make the same
mistake.

**CI APK build [M]:** on throwaway branch `spike/expo-sdk58-apk` (`100f3077`), `cd-deploy` `prod-apk` run 6802
succeeded in about 12.7 minutes, with SDK 58, AGP 9.2.1, Kotlin 2.2, compileSdk 37, R8 off and the `-Xmx4g` heap.
`upload-artifact` uses `if-no-files-found: error`, so success means an APK file existed. The APK's size and contents
were not inspected: this forge has no artifact API. For this run only, the branch removed the publish step, so nothing
reached the `mcm-app-android` shelf, and hard-disabled `build-deploy`. Note that `ci-status` lists that skipped job as
`build-deploy (dispatched) passed`; the task list shows it as skipped.

**Still unknown:**

| Unknown | Why | How to close it |
|---|---|---|
| **Does an SDK 58 APK launch, with or without R8? Does one build with R8 on?** | The sandbox cannot build or emulate: `dl.google.com`, Maven and Gradle do not resolve, and there is no `/dev/kvm` **[M]**. I did not widen egress | The section 3.4 test on a KVM emulator; a separate CI build with R8 on |
| Runtime behaviour of AGP 9, Kotlin 2.2 and third-party native libraries | They compile (below), but nothing has executed | Same test, then Maestro |
| A streamed agent turn on the new adapter | No gateway running, and the test user's assistant is unconfigured, so the dock and its deferred chunk never loaded. The lazy provider adapters behind `createRequire` were not reached | `nx e2e:agents`, gate tier |
| The built BFF image | Not built. `expo-server` must become a direct dependency for the prune closure **[I]** | Image build plus web E2E in change 1 |
| Full web E2E suite | Spike ran a focused walk only | CI on change 4 |
| Real proxy behaviour | Scheme fix tested with a header at the adapter, not through Cloudflare | Post-deploy backup-consent check in change 1 |
| Whether the split survives authenticated and streaming traffic | Differential was unauthenticated only | Only if that option is chosen |
| `expo-doctor` | It errored here without a usable report | Run in CI on change 4 |
| Load numbers in production | One unconstrained sandbox process | Treat as ratios, not capacity |

## 7. Acceptance criteria to seed `specs/NNN-*/`

**Adapter and hosting**
- AC-1: `server.js` uses `expo-server/adapter/express`; `@expo/server` is gone from manifests and prune roots.
- AC-2: A test using the **real** adapter proves: `TRUSTED_PROXY=true` with `X-Forwarded-Proto: https` gives an
  `https` request URL; unset gives `http`; `X-Forwarded-Host` never changes the origin. Removing the fix turns it red.
- AC-3: Backup-consent and account-deletion round trips complete in production after deploy, with evidence recorded.
- AC-4: The compose healthcheck fails if pages fail while API routes still answer.

**Rendering and CSP**
- AC-5: `app.json` has `web.output: "static"` and `apiRoutes: true`; `dist/server` contains HTML for all 16 page
  routes and 38 API routes.
- AC-6: Export fails if any inline script is not allow-listed; a selftest proves this gate can fail.
- AC-7: A `@gate` spec covers sign-in, deep link and client navigation with zero `securitypolicyviolation`
  and zero `pageerror`. Skip count is zero.
- AC-8: `script-src` contains no `'unsafe-inline'` or `'unsafe-eval'`.

**Dependency integrity**
- AC-9: A guard fails on more than one resolved `@tamagui/web` instance across the workspace.
- AC-10: The budget gate measures all scripts referenced by the entry HTML, and a selftest covers split chunks.
- AC-11: `react`, `react-dom`, `react-native` and the `@expo/dom-webview` override match SDK 58 across the workspace.

**Android**
- AC-12: Release APK builds in `app-ci` and `cd-deploy` with the raised heap, on Gradle 9.4.1.
- AC-13: The section 3.4 launch test passes on a CI-built APK, with the evidence quoted in `tasks.md`.
- AC-14: Agent flows pass on Maestro. The R8 opt-out is present and asserted until the separate R8 change.

**Tests and governance**
- AC-15: Typecheck is at 0 errors. Unit tiers have 0 failures and 0 skips, including both `server.js` suites.
- AC-16: `nx e2e:agents` gate tier passes, including one streamed turn.
- AC-17: The constitution is amended in the same PR with human approval, and SAST confirms the
  `decode-uri-component` allowlist entry is deleted, not renewed.
- AC-18: Web and APK rollback steps are in the PR, per the US4 precedent.

### Constitution amendment (2.7.0 → 2.8.0, stack guidance only)

| Line | From | To |
|---|---|---|
| 348 | Expo SDK 57, `default@sdk-57`, React Native 0.86, React 19.2 | Expo SDK 58, `default@sdk-58`, React Native 0.88, React 19.3 |
| 352 | `app.json` web output set to server, `"output": "server"` | `"output": "static"` with `apiRoutes: true` on the `expo-router` plugin |
| Changelog | none | v2.8.0 entry: baseline advanced; BFF output mode changed to keep prerendering; no principle redefined |

Line 352 is easy to miss: under SDK 58 its literal text would mean per-request rendering. If the split is chosen
instead, lines 352–353 and the architecture diagrams at 708, 717 and 811 also change, and that amendment is larger.

## 8. Sources

- Expo: [SDK 58 changelog](https://expo.dev/changelog/sdk-58), [upgrade guide](https://expo.dev/blog/how-to-upgrade-to-sdk-58.md),
  [Router 57→58 migration](https://docs.expo.dev/router/migrate/sdk-57-to-58/),
  [server rendering](https://docs.expo.dev/router/web/server-rendering.md), [API routes](https://docs.expo.dev/router/web/api-routes.md),
  [build properties](https://docs.expo.dev/versions/latest/sdk/build-properties), [SDK reference](https://docs.expo.dev/versions/latest/)
- React Native: [0.87](https://reactnative.dev/blog/2026/08/11/react-native-0.87), [0.88](https://reactnative.dev/blog/2026/10/19/react-native-0.88)
- Published packages inspected: `expo-server` 57.0.3 and 58.0.6, `@expo/server` 0.5.3, `@expo/router-server` 58.0.21, `expo-router` 58.0.30
- Repo: `frontend/mcm-app/server.js`, `web-security-headers.js`, `specs/081-major-dependency-upgrades/` (R4, US4), item #254, `docs/runbooks/android-emulator.md`
