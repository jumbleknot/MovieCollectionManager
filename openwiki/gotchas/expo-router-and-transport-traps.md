---
type: Gotcha
title: Expo Router server export and agent-transport traps
description: Four related runtime traps in the Expo/React Native app's server-side hosting and agent transport — the exported server bundle's missing import.meta.url registry, the express 5 catch-all and static-serving changes in server.js, the TRUSTED_PROXY-gated trust proxy setting the adapter needs to see the public scheme behind the TLS-terminating proxy, and the CopilotKit React Native streaming-fetch path that bypasses the normal token-refresh interceptor.
resource: frontend/mcm-app/server.js
tags: [expo-router, react-native, copilotkit, express, transport, frontend]
sources:
  - id: openwiki-source-6af9a79d18f77a9b86839849
    resource: repo://frontend/mcm-app/Dockerfile
  - id: openwiki-source-75c613635390ab18cc167ec1
    resource: repo://frontend/mcm-app/README.md
  - id: openwiki-source-dbfd6ac37b4380e1b9ca4daa
    resource: repo://frontend/mcm-app/server.js
  - id: openwiki-source-6a3e5dbad8bc4145f0341cf9
    resource: repo://frontend/mcm-app/src/app/_layout.tsx
  - id: openwiki-source-66fbf00ecfdc8552ac5fa0fd
    resource: repo://frontend/mcm-app/src/app/bff-api/agent/run%2Bapi.ts
  - id: openwiki-source-a344c8ab57b1d157819a0fd2
    resource: repo://frontend/mcm-app/src/app/bff-api/backups/consent%2Bapi.ts
  - id: openwiki-source-cd9c9ac84bbb2c845f70e90d
    resource: repo://frontend/mcm-app/src/assistant-polyfills.native.ts
  - id: openwiki-source-ef52217f9f29eb3b427148ac
    resource: repo://frontend/mcm-app/src/assistant-polyfills.ts
  - id: openwiki-source-74f39153b978241c50c7addd
    resource: repo://frontend/mcm-app/src/bff-server/account-route-support.ts
  - id: openwiki-source-abe552d5bae5c5ce75a9c776
    resource: repo://frontend/mcm-app/src/bff-server/rate-limiter.ts
  - id: openwiki-source-e69fe30016fa84209ae5e815
    resource: repo://frontend/mcm-app/src/config/env.ts
  - id: openwiki-source-0b95b2665c338088eef0db7e
    resource: repo://frontend/mcm-app/src/utils/agent-fetch-refresh.ts
  - id: openwiki-source-503103081c79db2ef99e2b27
    resource: repo://frontend/mcm-app/src/utils/token-refresh.ts
  - id: openwiki-source-19609c73bc9a3a34e47ab18d
    resource: repo://frontend/mcm-app/src/utils/unit-tests/agent-fetch-refresh.test.ts
  - id: openwiki-source-b95aa0cad6a90f846312a9a6
    resource: repo://frontend/mcm-app/tests/e2e/web/agent-session-refresh.spec.ts
  - id: openwiki-source-d61b9a5c48e21c0856d75a2d
    resource: repo://frontend/mcm-app/tests/e2e/web/font-fallback.spec.ts
  - id: openwiki-source-5ee35374d6ab0e61934498cd
    resource: repo://frontend/mcm-app/tests/unit/bff-server-adapter.test.ts
  - id: openwiki-source-6815e02bc96aebf5b9adb612
    resource: repo://frontend/mcm-app/tests/unit/bff-server-trust-proxy.test.ts
  - id: openwiki-source-0df6a785e730381b7aee77a1
    resource: repo://frontend/mcm-app/tests/unit/fixtures/expo-adapter-stub.cjs
  - id: openwiki-source-4afc03401961c543ccdef7be
    resource: repo://scripts/prune-bff-runtime-modules.mjs
  - id: openwiki-source-83771c9aeecb9de0bd4deaf4
    resource: repo://specs/083-backup-consent-session-isolation/tasks.md
generated: { by: "openwiki/0.7.1", at: "2026-10-25T18:33:06.357Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-10-25T18:33:06.357Z
---

# Expo Router server export and agent-transport traps

`frontend/mcm-app/server.js` is the BFF's production entrypoint and the seam this page is about: a
small CommonJS Express adapter that `require`s `@expo/server/adapter/express`, hands the exported
`dist/server` bundle to `createRequestHandler`, and serves `dist/client` as static assets. It runs
*outside* the Metro bundle, so it cannot import anything from `src/` — every trap below follows from
that boundary.

Four of them live here, discovered the hard way (a hang, a silent 404 regression, a Keycloak
`redirect_uri` refusal, and a silent auth failure on the agent route) and each with a narrow,
load-bearing fix that looks removable if you don't know why it is there: the exported bundle's
missing `import.meta.url` registry, the express 5 behaviours that changed under the hosting layer,
the `TRUSTED_PROXY`-gated `trust proxy` setting that lets the adapter see the public scheme behind
the TLS-terminating proxy, and the CopilotKit React Native streaming-fetch path that bypasses the
app's token-refresh interceptor.

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

## express 5 hosting traps in the same `server.js`

The express 4 → 5 major bump (path-to-regexp v8, serve-static 2, router 2) changed exactly the
behaviours `server.js` depends on, and none of the three is visible from the code alone — each
reads like a stylistic choice rather than a compatibility fix.

- **The catch-all must be the named, braced `'/{*splat}'`, not `'*'`.** path-to-regexp v8 rejects a
  bare wildcard at BOOT: `app.all('*', …)` throws `Missing parameter name at index 1: *` while the
  routes are being registered, so the process never reaches `app.listen` and the container will not
  start. The wildcard is therefore NAMED, and the braces make it optional so `/` itself still
  matches the Expo handler.

- **`app.all` rather than `app.use` is load-bearing, and so is the route form.** A route decodes its
  params, so a malformed percent-encoded path (`/bff-api/%E0%A4%A`) is answered `400` by express
  before the Expo handler ever sees it; a `app.use` mount would forward the raw path through. The
  same registration forwards every method (GET/POST/PUT/DELETE/PATCH) and the raw query string —
  bracket syntax included — which is what the `/bff-api/*` API surface and the SSR pages both need
  from one catch-all.

- **serve-static 2 changed the `dotfiles` default, and the fix is two `express.static` instances.**
  `expo export` writes every asset a dependency ships — the Outfit brand fonts, expo-router's icons,
  45 files — under `dist/client/assets/node_modules/.pnpm/…`, which is a DOT-DIRECTORY. express 4
  (serve-static 1) ignored only a path whose LAST segment is a dotfile and served files inside
  dot-directories; express 5 (serve-static 2) ignores both, which silently 404s all 45 assets. So
  `server.js` selects between a default (`ignore`) instance and an `allow` one on the last DECODED
  segment of the request path — decoded, because `/%2Eenv` must count as a dotfile (send decodes
  before it checks), and an undecodable path falls to the strict instance, which rejects it exactly
  as express 4 did. The regression is silent in the worst way: the page still renders, just in the
  fallback font.

- **`tests/unit/bff-server-adapter.test.ts` is the pin for all three, and one of only two suites
  that exercise this layer at all.** It copies the real `server.js` and `web-security-headers.js`
  into a temp directory next to a fixture `dist/client`, then boots it in a child process with only
  `@expo/server/adapter/express` replaced by a `node -r` preload
  (`tests/unit/fixtures/expo-adapter-stub.cjs`) that echoes what express delivered to the handler —
  and, since spec 083 T010, the origin exactly as the real adapter builds it, via an `X-Test-Origin`
  response header (see the scheme trap below for why that is needed).
  `tests/unit/bff-server-trust-proxy.test.ts` boots the same real `server.js` through the same
  preload. express itself resolves from the package's own `node_modules` via `NODE_PATH`, so the
  version under test is the declared one. The unit tier imports TS modules and the integration tier
  calls route handlers, and both bypass `server.js` — which is why the font case needs this test. No
  other test would catch it either: `tests/e2e/web/font-fallback.spec.ts` aborts every font request
  on purpose and asserts the app still renders on the system fallback, so it passes whether or not
  the real fonts are servable.

## The `trust proxy` hosting trap in the same `server.js`

This one is a *hosting* trap that lives in the same file, not an express 5 regression: the major
bump did not touch `req.protocol`, and the line exists because of where the process is deployed.
It also reads the same env var that already meant something else, which is part of why it looks
removable.

- **The adapter builds every request URL from `req.protocol` and the raw `Host` header.** The
  `@expo/server` express adapter constructs each `Request` as
  `` `${req.protocol}://${req.get('host')}${req.url}` ``. In production TLS terminates at the edge
  proxy and a tunnel reaches this process over plain HTTP, so `req.protocol` read `http` — and every
  route that derives a callback from `new URL(req.url).origin` then sent Keycloak an unregistered
  `http://` redirect_uri. Keycloak refused the authorization request outright with
  `Invalid parameter: redirect_uri` (measured in production 2026-10-25, item 843). Two routes are
  affected: the backup consent callback and the account-deletion re-authentication callback
  (feature 076). CI and dev never saw it, because there the BFF serves HTTPS itself on `:8443` —
  which is why this is pinned by a suite that boots the real `server.js` rather than by the web E2E
  run. The measured record is
  [spec 083 T010](../../specs/083-backup-consent-session-isolation/tasks.md#t010--the-bff-must-see-the-public-scheme-behind-the-tls-terminating-proxy-item-843-added-2026-10-25).

- **`app.set('trust proxy', 1)` — the number is the point, not a shorthand.** It is set only when
  `TRUSTED_PROXY === 'true'`, at boot and above the routes. A numeric value compiles to a hop-count
  predicate over the socket hop index (`i < val`), so `1` means "the immediate peer is the proxy I
  chose" and nothing wider — which is exactly the topology: one hop (the tunnel) in front of this
  process. `true` would trust *any* peer, including a client connecting directly, and an address
  list or CIDR would have to be kept accurate forever; the hop count is the narrowest form that
  still describes the deployment. It is deliberately gated rather than unconditional so the setting
  can never be stronger than the deployment actually is.

- **Only the SCHEME moves, which is what makes this safe to enable.** `trust proxy` changes
  `req.protocol`; it does not change `req.get('host')`, which is a raw header read
  (`this.headers['host']`) with no proxy logic in it at all. That distinction is the whole reason
  the trap is contained: express's *own* `req.host`/`req.hostname` getters do consult
  `X-Forwarded-Host` once the socket address is trusted, but the adapter does not use them — it calls
  `req.get('host')`. So `X-Forwarded-Host` cannot move the origin a callback is derived from, and a
  forged `Host` cannot either — it would only produce a redirect_uri that is not registered on the
  client, which Keycloak refuses instead of honouring. The suite pins this explicitly: adding
  `X-Forwarded-Host` to an otherwise-valid request leaves the origin unchanged.

- **Unset must stay unset, and unset is the default.** `TRUSTED_PROXY` defaults to `false`
  (`src/config/env.ts`), so a directly exposed BFF keeps ignoring a client-supplied
  `X-Forwarded-Proto`: otherwise any client could talk the process into believing it serves `https`
  and emit callback URLs for a scheme it is not on. The same variable is also the BFF's rate-limit
  client-identity flag (feature 009, finding #4), read *inside the bundle* by `extractClientIp` for
  the right-most `X-Forwarded-For` hop — see [BFF](../projects/bff.md). The two consumers are
  independent: setting `trust proxy` here does not change rate-limit identity, and `extractClientIp`
  does not change the scheme.

- **Pinned by `tests/unit/bff-server-trust-proxy.test.ts`, which boots the real `server.js` twice
  through the same `node -r` preload the express-layer suite uses** — once as production runs it
  (`TRUSTED_PROXY=true`), once without. The preload's `X-Test-Origin` header echoes
  `` `${req.protocol}://${req.get('host')}` `` exactly as the real adapter builds it, which is what
  makes the origin a route would compute observable from outside the child process; nothing else in
  the harness would reveal it. Measured RED before the fix: 2 failed, 2 passed — the two
  `TRUSTED_PROXY=true` cases asserting `https` failed with `http://…`, while the two that assert
  `http` (the proxy saying nothing, and no trusted proxy at all) passed already.

## CopilotKit's RN streaming-fetch bypasses the axios refresh interceptor

The agent chat's client-side network layer normally goes through an axios instance with a
token-refresh interceptor (`utils/token-refresh`). But CopilotKit's React Native runtime issues its
`/bff-api/agent/run` request through its own streaming-fetch polyfill (built on
`XMLHttpRequest`), which never passes through that interceptor. Cookie auth still works — RN's
`XMLHttpRequest` defaults `withCredentials` to `true`, so the `mcm_access_token` cookie rides along
automatically — but when that short-lived cookie expires (Keycloak's ~5 minute access-token
lifespan) mid-session, the run 401s with no refresh attempted.

`frontend/mcm-app/src/utils/agent-fetch-refresh.ts` wraps `globalThis.fetch` (installed by the
assistant polyfill loader, the very first import in `app/_layout.tsx` — on native
`assistant-polyfills.native.ts`, after the crypto/streaming polyfills; on web
`assistant-polyfills.ts`, which installs only the wrapper — and before CopilotKit issues any run) to
detect a 401 on the agent run route specifically, call `silentRefresh()`, and retry the run once. The
401 retry is immediate; the 250 ms settle delay applies only to a *thrown* transport error.

```mermaid
flowchart TD
    Call["wrapped fetch(input, init)"] --> IsAgent{"URL contains /bff-api/agent/run?"}
    IsAgent -->|no| Plain["baseFetch once, errors propagate unchanged"]
    IsAgent -->|yes| Attempt["baseFetch"]
    Attempt -->|throws| Drop["wait RUN_RETRY_DELAY_MS, retry exactly once"]
    Attempt -->|401| Refresh["silentRefresh()"]
    Attempt -->|any other status| Pass["return the response unchanged"]
    Refresh -->|refreshed| Retry["retry exactly once"]
    Refresh -->|not refreshed| Original["return the original 401"]
```

*The two bounded recoveries in `createRefreshingFetch` — a status-code path and a thrown-transport
path — both scoped to the agent route and both capped at one retry.*

- **The cookie is carried by RN's *default* behavior, not an explicit flag.** CopilotKit's polyfill
  itself does not set `init.credentials`; if a future React Native or CopilotKit upgrade changes
  that default, the cookie stops riding along automatically and this breaks silently — there is no
  compile-time or type-level signal that would catch it. The Android E2E flow is the intended
  regression net for this.

- **Install order matters.** The refresh wrapper must be installed after the streaming-fetch
  polyfill but before any CopilotKit run — `assistant-polyfills.native.ts` is structured specifically
  to guarantee that ordering (crypto, then the polyfills, then the wrapper); don't reorder its
  `require()` calls. (`app/_layout.tsx`'s comment still points at `assistant-polyfills.ts`, which since
  feature 077 is the web variant.)

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
this hosting/transport layer sits in, [BFF](../projects/bff.md) for the server-side surface
`server.js` serves, and [AI Agents layer architecture](../architecture/agent-layer.md) for the
call chain the agent transport feeds. This page is about the *build and transport* surfaces;
for the router-shape gotcha (`collections/[collectionId]/` as a directory route rather than a file
route) see [Directory-based collection routing in Expo Router](expo-router-collection-routing.md),
and for the auth chain the cookie on this transport ultimately satisfies see
[Authentication and authorization chain](../invariants/auth-chain.md). The harnesses the
verification split above rests on are described in the
[E2E testing runbook](../../docs/runbooks/e2e-testing.md).
