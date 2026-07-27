---
type: Service
title: Expo/React Native universal app
description: The universal (web + Android) client for MovieCollectionManager, built on Expo Router and Tamagui. Ships as one codebase with its BFF (see BFF page) but this page covers the client-side app shape, design system, and client-facing test/build gotchas.
resource: frontend/mcm-app/README.md
tags: [expo, react-native, tamagui, frontend]
timestamp: 2026-06-20T21:57:08-04:00
---

# Expo/React Native universal app

`frontend/mcm-app` is a single Expo Router (Expo SDK 56, React Native 0.85) codebase targeting web
and Android from one source tree. `app.json` sets Metro's web output to `"server"`, not a static
export, because the same process also hosts the [BFF](/openwiki/projects/bff.md) via file-based
`+api.ts` routes. Client-side code lives in `src/screens/`, `src/components/`, `src/hooks/`,
`src/config/`, `src/utils/`, `src/types/`; routes (both UI screens and API handlers) live under
`src/app/`.

The [design system](/openwiki/projects/design-system.md) is Tamagui-based (`@mcm/design-system`), dark-first by default (theme choice is
persisted client-side only — no backend involvement), with a compliance test suite enforcing
design-token usage rules and tracked "sanctioned deviations." All client-side network calls go
through `src/bff-server/api-client.ts`, which never attaches an `Authorization` header — it relies on
the browser/RN cookie jar and `withCredentials: true` to carry the BFF's session cookies (see
[Auth chain](/openwiki/invariants/auth-chain.md)). Login itself uses OAuth2 + PKCE against Keycloak
directly from the client before handing the resulting code to the BFF.

## Gotchas

- **`import.meta.url` crashes the exported server bundle.** Metro rewrites `import.meta.url` to
  `globalThis.__ExpoImportMetaRegistry.url`. The Metro *dev* server populates that registry; the
  exported `@expo/server` runtime used in Docker does not. Any bundled dependency that calls
  `createRequire(import.meta.url)` (this has bitten the agent-chat adapter on the `/run` path)
  crashes with `"Cannot read properties of undefined (reading 'url')"` and the request just hangs.
  `frontend/mcm-app/server.js` pre-seeds the registry before loading the bundle as the workaround —
  don't remove it without understanding why it's there.
- **Tamagui is pinned to v1 on purpose.** `expo install tamagui` pulls a breaking v2 by default.
  The babel/metro compiler plugins are intentionally *not* installed — only the runtime — because
  migrating to the compiler is a separate, larger effort. Don't "helpfully" add the plugin.
- **Web E2E must run against a prebuilt BFF container, and a stale image lies to you.** Metro's dev
  web bundler OOMs building the app plus Tamagui locally, so web E2E always runs against the
  containerized BFF, not the dev server. That container serves a prebuilt bundle — if you change
  source and don't rebuild the image, the E2E suite silently tests old code and reports green.
  Always rebuild after a source change before trusting a web E2E result.
- **`pnpm nx e2e mcm-app` does not work inside the devcontainer.** Chromium cannot be installed there
  (the Playwright CDN and apt are outside the egress allowlist). Run Playwright via the
  `mcr.microsoft.com/playwright` image with `--network host` instead.
- **Password-manager autofill is deliberately suppressed almost everywhere.** Use
  `NoAutoFillInput` (not plain `TextInput`) for form fields, except the registration page, where
  autofill is wanted.

See [BFF](/openwiki/projects/bff.md) for the server-side half of this codebase, and
`frontend/mcm-app/README.md` for the design-system compliance rules and the full web-E2E procedure.
