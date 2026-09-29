---
type: Gotcha
title: Expo Router server export and agent-transport traps
description: Two related but distinct runtime traps in the Expo/React Native app's server-side hosting and agent transport — the exported server bundle's missing import.meta.url registry, and the CopilotKit React Native streaming-fetch path that bypasses the normal token-refresh interceptor.
resource: frontend/mcm-app/server.js
tags: [expo-router, react-native, copilotkit, transport, frontend]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-29T10:29:14.990Z
sources:
  - id: openwiki-source-75c613635390ab18cc167ec1
    resource: repo://frontend/mcm-app/README.md
  - id: openwiki-source-dbfd6ac37b4380e1b9ca4daa
    resource: repo://frontend/mcm-app/server.js
  - id: openwiki-source-6a3e5dbad8bc4145f0341cf9
    resource: repo://frontend/mcm-app/src/app/_layout.tsx
  - id: openwiki-source-66fbf00ecfdc8552ac5fa0fd
    resource: repo://frontend/mcm-app/src/app/bff-api/agent/run%2Bapi.ts
  - id: openwiki-source-cd9c9ac84bbb2c845f70e90d
    resource: repo://frontend/mcm-app/src/assistant-polyfills.native.ts
  - id: openwiki-source-ef52217f9f29eb3b427148ac
    resource: repo://frontend/mcm-app/src/assistant-polyfills.ts
  - id: openwiki-source-0b95b2665c338088eef0db7e
    resource: repo://frontend/mcm-app/src/utils/agent-fetch-refresh.ts
  - id: openwiki-source-503103081c79db2ef99e2b27
    resource: repo://frontend/mcm-app/src/utils/token-refresh.ts
  - id: openwiki-source-19609c73bc9a3a34e47ab18d
    resource: repo://frontend/mcm-app/src/utils/unit-tests/agent-fetch-refresh.test.ts
  - id: openwiki-source-a731aae9de44717e94595aed
    resource: repo://frontend/mcm-app/tests/e2e/mobile/agent-navigate-movie.yaml
  - id: openwiki-source-b95aa0cad6a90f846312a9a6
    resource: repo://frontend/mcm-app/tests/e2e/web/agent-session-refresh.spec.ts
  - id: openwiki-source-4afc03401961c543ccdef7be
    resource: repo://scripts/prune-bff-runtime-modules.mjs
  - id: openwiki-source-35c70deaea135103268df2d8
    resource: repo://specs/012-multi-agent-mvp/HANDOFF.md
  - id: openwiki-source-471820815aded91734143333
    resource: repo://specs/013-post-agent-enhancements/diagnosis-mobile-agent-no-token.md
generated: { by: "openwiki/0.6.0", at: "2026-09-29T10:29:14.990Z" }
---

# Expo Router server export and agent-transport traps

Two separate runtime traps live at the boundary between [the Expo/React Native
app](../projects/expo-app.md)'s build tooling and its agent transport. Both were discovered
the hard way (a crash and a silent auth failure, respectively) and both have narrow, load-bearing
fixes that look removable if you don't know why they're there.

## `import.meta.url` crashes the exported server bundle

Metro rewrites `import.meta.url` in bundled dependencies to
`globalThis.__ExpoImportMetaRegistry.url`. The Metro *dev* server populates that registry
automatically; the exported `@expo/server` runtime used in the Docker/production build does not.
Any bundled dependency that internally calls `createRequire(import.meta.url)` — this has bitten
`@copilotkit/runtime`'s lazily-required adapter on the `/bff-api/agent/run` path — crashes with
`TypeError: Cannot read properties of undefined (reading 'url')`, and the request simply hangs.

`frontend/mcm-app/server.js` pre-seeds `globalThis.__ExpoImportMetaRegistry = { url:
pathToFileURL(__filename).href }` before `createRequestHandler` loads the bundle. Metro uses one
shared registry object for every module, so pointing it at the server module itself is enough for
`createRequire` to resolve correctly against the deployed `node_modules`.

- **Do not remove this without understanding why it's there** — it looks like dead defensive code
  until a dependency that uses `import.meta.url` is bundled in, at which point removing it
  reintroduces a silent hang (not an obvious error) on a specific agent route in production only.

- **The throw is invisible to the route's own error handling.** It happens asynchronously inside
  the streaming `respond` pipeline, so the `/bff-api/agent/run` handler's `try`/`catch` never sees
  it — the client just hangs, with no 500 and no log line pointing at the cause. That is why
  "the agent route never answers, in the container only" is the symptom to pattern-match, not an
  ordinary server error.

- **The dependency is named as a bare string, which is a second, build-time consequence of the
  same mechanism.** Because `@copilotkit/runtime` reaches its provider adapters through
  `createRequire(globalThis.__ExpoImportMetaRegistry.url)`, a static closure walk cannot see the
  string. The BFF image build compensates with a bundle check that re-derives those specifiers
  from the freshly exported `dist/server` and fails if one is not accounted for — see
  [BFF](../projects/bff.md) for the image shape this sits in.

- **The `if (!globalThis.__ExpoImportMetaRegistry)` guard is intentional.** If a future
  `@expo/server` version populates the registry itself, this becomes a harmless no-op rather than
  clobbering the real value.

## CopilotKit's RN streaming-fetch bypasses the axios refresh interceptor

The agent chat's client-side network layer normally goes through an axios instance with a
token-refresh interceptor (`utils/token-refresh`). But CopilotKit's React Native runtime issues its
`/bff-api/agent/run` request through its own streaming-fetch polyfill (built on
`XMLHttpRequest`), which never passes through that interceptor. Cookie auth still works — RN's
`XMLHttpRequest` defaults `withCredentials` to `true`, so the `mcm_access_token` cookie rides along
automatically — but when that short-lived cookie expires (Keycloak's ~5 minute access-token
lifespan) mid-session, the run 401s with no refresh attempted.

`frontend/mcm-app/src/utils/agent-fetch-refresh.ts` wraps `globalThis.fetch` (installed by
`assistant-polyfills.ts`, the very first import in `app/_layout.tsx`, after the crypto/streaming
polyfills but before CopilotKit issues any run) to detect a 401 on the agent run route specifically,
call `silentRefresh()`, and retry the run once after a short settle delay.

- **The cookie is carried by RN's *default* behavior, not an explicit flag.** CopilotKit's polyfill
  itself does not set `init.credentials`; if a future React Native or CopilotKit upgrade changes
  that default, the cookie stops riding along automatically and this breaks silently — there is no
  compile-time or type-level signal that would catch it. The Android E2E flow is the intended
  regression net for this.

- **Install order matters.** The refresh wrapper must be installed after the streaming-fetch
  polyfill but before any CopilotKit run — `assistant-polyfills.ts` is structured specifically to
  guarantee that ordering; don't reorder its `require()` calls.

- **A *second*, distinct recovery lives in the same wrapper: the transport-drop retry.** A dropped
  connection mid-stream (a reset adb-reverse tunnel; server-side it surfaces as `Cannot pipe to a
  closed or destroyed stream`) rejects RN's XHR streaming polyfill as a **thrown** fetch error, not
  a 4xx. Without handling it the run silently produces no `render_selection` /
  `render_disambiguation` tool call and the dock panel never renders. `createRefreshingFetch` now
  catches a throw on the agent route only, waits `RUN_RETRY_DELAY_MS` (250 ms) for the tunnel to
  re-establish, and retries **exactly once**. The retry is safe because a dropped connection aborts
  the upstream gateway turn via `@expo/server`'s `AbortController`, making the cut turn
  idempotent-on-failure. Non-agent throws propagate unchanged, and a real 4xx returns a `Response`
  (never throws), so it is never retried. This is the one behavior on this page whose trigger is a
  *thrown* error rather than a status code — do not "simplify" it into the 401 branch.

- **Neither recovery loops.** A still-401 response after a successful refresh is returned as-is
  (one retry maximum), and a second consecutive throw is propagated. `createRefreshingFetch` is a
  pure factory taking an injected `baseFetch` + `refresh`, so both paths are unit-tested without any
  global in `src/utils/unit-tests/agent-fetch-refresh.test.ts`.

- **Whether the retry actually recovers a real mid-session expiry (versus flakiness seen under an
  unstable Windows/Metro test harness) was, per the source comments, still an open verification
  item** at the time this was written — treat a related test failure as needing investigation, not
  an automatic false positive. What *has* since been proven is the server half of the chain: the
  web E2E `tests/e2e/web/agent-session-refresh.spec.ts` drops only the access cookie, observes the
  `no_token` 401 the agent route sees, and shows `/bff-api/auth/refresh` rotating the cookie so the
  retry succeeds. The client-side orchestration over that chain, and the RN-default cookie
  delivery, still rest on the Android harness.

- **The web and native loaders are deliberately split, and the split is load-bearing for bundle
  size.** `assistant-polyfills.ts` (the default/web variant) installs *only* the refresh wrapper —
  on web the crypto/streaming globals are native. `assistant-polyfills.native.ts` loads the
  CopilotKit crypto and streaming polyfills and *then* the wrapper. Static `require`s meant the
  polyfill libraries landed in the entry chunk for every web user even though they could never
  execute there, so the platform boundary is where they are dropped. See
  [Expo/React Native app](../projects/expo-app.md) for the surrounding app shape.

See [Expo/React Native app](../projects/expo-app.md) for the broader client-side app shape
this hosting/transport layer sits in, and [BFF](../projects/bff.md) for the server-side
`server.js` entrypoint these fixes live in. This page is about the *build and transport* surfaces;
for the router-shape gotcha (`collections/[collectionId]/` as a directory route rather than a file
route) see [Directory-based collection routing in Expo Router](expo-router-collection-routing.md),
and for the auth chain the cookie on this transport ultimately satisfies see
[Authentication and authorization chain](../invariants/auth-chain.md).
