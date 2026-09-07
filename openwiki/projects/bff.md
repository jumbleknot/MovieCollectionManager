---
type: Service
title: BFF (Backend-for-Frontend)
description: The Node.js server-side layer embedded in the mcm-app Expo Router process. Owns session/auth handling, proxies every domain call to mc-service, and forwards agent requests to the Agent Gateway. The only component the browser/mobile client is allowed to talk to.
resource: frontend/mcm-app/README.md
tags: [bff, expo-router, auth, proxy, nodejs]
timestamp: 2026-09-07T00:00:00+00:00
---

# BFF (Backend-for-Frontend)

The BFF is server-side code that lives *inside* the same Expo Router codebase as the client app (see
[Expo/React Native app](/openwiki/projects/expo-app.md)) but runs only on the server: business
logic in `frontend/mcm-app/src/bff-server/`, HTTP surface as Expo Router `+api.ts` handlers under
`frontend/mcm-app/src/app/bff-api/`. In production/Docker it is served by `frontend/mcm-app/server.js`
(an Express adapter around `@expo/server`). This split exists so the client never holds a raw
credential — see [Auth chain](/openwiki/invariants/auth-chain.md), which the BFF is the primary
enforcement point for.

Route groups: `bff-api/auth/*` (login, refresh, logout, registration, email verification),
`bff-api/collections/*` and `.../movies/*` (proxy CRUD to [mc-service](/openwiki/projects/mc-service.md)),
`bff-api/agent/*` (forwards to the [Agent Gateway](/openwiki/projects/agent-gateway.md) over AG-UI),
`bff-api/admin/settings`. Every proxy route follows the same shape: `requireAuth()` →
`requireMcUser()`/`requireMcAdmin()` RBAC check → a per-request `mc-service-client.ts` Axios instance
carrying the caller's JWT as `Authorization: Bearer` → `handleMcApiError()` translates mc-service's
RFC 9457 problem+json on failure. The client never calls mc-service directly.

## Gotchas

- **No Redis, no login.** `session-manager.ts` and the login rate-limiter both need Redis. If Redis
  is down, `/bff-api/auth/login` returns a bare 500 "Authentication failed" — the rate-limiter's
  first Redis call fails before a typed error is produced, so this reads as a generic crash rather
  than an infra problem. Check Redis first.
- **`.env` inline comments corrupt secrets.** dotenv-style loaders (and the Expo CLI) treat
  everything after `=` as the literal value. `KEY=val # note` yields `val # note`. This has actually
  broken login (`invalid_client` from Keycloak) when a client secret captured its trailing comment.
  Put comments on their own line.
- **Internal vs. public Keycloak URL split is load-bearing.** The BFF's OIDC discovery call must hit
  the *internal, runtime* Keycloak origin, not a public URL that may have been frozen into the client
  bundle at `expo export` time — the public origin is not reachable from inside the container network.
  Confusing the two produces cryptic OIDC failures that look like a Keycloak misconfiguration.
- **`TRUSTED_PROXY` defaults to `false`.** Below a trusted reverse proxy, IP-based rate limiting is
  silently skipped (with a warning) rather than trusting a spoofable client-supplied header. Any
  non-loopback deployment must set `TRUSTED_PROXY=true` explicitly, which then trusts only the
  right-most `X-Forwarded-For` hop.
- **Cookies, not tokens, cross the wire to the client.** The BFF sets three `HttpOnly`,
  `SameSite=Strict` cookies (access token, refresh token — scoped to the refresh path only — and
  session id); client code never sees a raw JWT. The client Axios instance sends no `Authorization`
  header at all and relies on `withCredentials: true`.
- **The shipped image carries only 76 of 1513 production packages — and the build gate enforces it.**
  `pnpm deploy --prod` materializes ~1600 packages because they are genuine `dependencies` of
  `mcm-app`, but they are dependencies of the web bundle, which Metro already compiled into `dist/`
  at build time. `scripts/prune-bff-runtime-modules.mjs` walks the pnpm symlink graph from three
  roots (`express`, `@expo/server`, `openai`) and deletes everything outside that closure, shrinking
  the image from 1.73 GB to 335 MB (measured 2026-09-07). The 76 packages retained are exactly what
  a traced full-E2E run plus a route-sweep ever touched. **Do not delete the script or remove it from
  the Dockerfile deps stage** — removing it silently re-bloats the image without any failing check.
- **A bare-specifier build failure means a CopilotKit/LangChain upgrade added a lazy provider.**
  The builder stage also runs `prune-bff-runtime-modules.mjs --check-bundle dist/server` to detect
  packages the exported bundle names by string (e.g., `@copilotkit/runtime` reaches its adapters via
  `createRequire(globalThis.__ExpoImportMetaRegistry.url)`) that a closure walk cannot see. If the
  build goes red with *"the exported server bundle reaches for … bare specifier(s)"*, check whether
  the new specifier resolves from `/app/runtime` (add it to `DYNAMIC_ROOTS` in the script) or is
  already unresolvable (record it as `'unresolvable'` in `KNOWN_DYNAMIC_SPECIFIERS`). Do not delete
  the check — its purpose is to turn a future production 500 into a red build here.

See [Auth chain](/openwiki/invariants/auth-chain.md) for the full login-to-request-validation
sequence, and [Secrets management](/openwiki/invariants/secrets-management.md) for how the BFF's own
credentials (client secret, cookie/encryption keys) are sourced. Full setup and env-var reference:
`frontend/mcm-app/README.md` and `docs/runbooks/local-dev.md`.
