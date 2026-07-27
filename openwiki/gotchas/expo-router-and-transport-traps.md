---
type: Gotcha
title: Expo Router server export and agent-transport traps
description: Two related but distinct runtime traps in the Expo/React Native app's server-side hosting and agent transport — the exported server bundle's missing import.meta.url registry, and the CopilotKit React Native streaming-fetch path that bypasses the normal token-refresh interceptor.
resource: frontend/mcm-app/server.js
tags: [expo-router, react-native, copilotkit, transport, frontend]
timestamp: 2026-07-10T06:27:57-04:00
---

# Expo Router server export and agent-transport traps

Two separate runtime traps live at the boundary between [the Expo/React Native
app](/openwiki/projects/expo-app.md)'s build tooling and its agent transport. Both were discovered
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

## CopilotKit's RN streaming-fetch bypasses the axios refresh interceptor

The agent chat's client-side network layer normally goes through an axios instance with a
token-refresh interceptor (`utils/token-refresh`). But CopilotKit's React Native runtime issues its
`/bff-api/agent/run` request through its own streaming-fetch polyfill (built on `XMLHttpRequest`),
which never passes through that interceptor. Cookie auth still works — RN's `XMLHttpRequest`
defaults `withCredentials` to `true`, so the `mcm_access_token` cookie rides along automatically —
but when that short-lived cookie expires (Keycloak's ~5 minute access-token lifespan) mid-session,
the run 401s with no refresh attempted.

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
- **Whether the retry actually recovers a real mid-session expiry (versus flakiness seen under an
  unstable Windows/Metro test harness) was, per the source comments, still an open verification
  item** at the time this was written — treat a related test failure as needing investigation, not
  an automatic false positive.

See [Expo/React Native app](/openwiki/projects/expo-app.md) for the broader client-side app shape
this hosting/transport layer sits in, and [BFF](/openwiki/projects/bff.md) for the server-side
`server.js` entrypoint these fixes live in.
