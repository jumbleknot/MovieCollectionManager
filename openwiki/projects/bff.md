---
type: Service
title: BFF (Backend-for-Frontend)
description: The Node.js server-side layer embedded in the mcm-app Expo Router process. Owns session/auth handling, proxies domain calls to mc-service and the Agent Gateway, and now also owns its own MongoDB/Redis-backed state for per-user agent config and scheduled collection backups.
resource: frontend/mcm-app/README.md
tags: [bff, expo-router, auth, proxy, nodejs, mongodb, backups]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-26T05:36:02.343Z
sources:
  - id: openwiki-source-95a7ed7500d24b0881fc3468
    resource: repo://docs/runbooks/backups.md
  - id: openwiki-source-75c613635390ab18cc167ec1
    resource: repo://frontend/mcm-app/README.md
  - id: openwiki-source-dbfd6ac37b4380e1b9ca4daa
    resource: repo://frontend/mcm-app/server.js
  - id: openwiki-source-66fbf00ecfdc8552ac5fa0fd
    resource: repo://frontend/mcm-app/src/app/bff-api/agent/run%2Bapi.ts
  - id: openwiki-source-1f97e5240572ea9ecae44ac5
    resource: repo://frontend/mcm-app/src/app/bff-api/backups/tick%2Bapi.ts
  - id: openwiki-source-e6a53b75d3e6241fef647e04
    resource: repo://frontend/mcm-app/src/bff-server/agent-config-ssrf.ts
  - id: openwiki-source-c22d81a0331031d61ad2c7e3
    resource: repo://frontend/mcm-app/src/bff-server/backup-destination-url-guard.ts
  - id: openwiki-source-e37e5da5fa7401fdb7992219
    resource: repo://frontend/mcm-app/src/bff-server/backup-job-store.ts
  - id: openwiki-source-0476c5058778e33745a9b2c2
    resource: repo://frontend/mcm-app/src/bff-server/backup-route-support.ts
  - id: openwiki-source-284b2b399a6eebffc24d3e93
    resource: repo://frontend/mcm-app/src/bff-server/backup-runner.ts
  - id: openwiki-source-2dee841e6c78f22b5fdaa6fb
    resource: repo://frontend/mcm-app/src/bff-server/mc-api-error.ts
  - id: openwiki-source-6129cd750694ad94a5d9cb3f
    resource: repo://frontend/mcm-app/src/bff-server/mc-service-client.ts
  - id: openwiki-source-1c2acc0a72ab64fd663510a9
    resource: repo://frontend/mcm-app/src/bff-server/mongo-client.ts
  - id: openwiki-source-a0956a8d887958011704f33b
    resource: repo://frontend/mcm-app/src/bff-server/pinned-agent.ts
  - id: openwiki-source-3bf0ad96857ee228607b018c
    resource: repo://frontend/mcm-app/src/bff-server/redis-lock.ts
  - id: openwiki-source-e69fe30016fa84209ae5e815
    resource: repo://frontend/mcm-app/src/config/env.ts
generated: { by: "openwiki/0.5.2", at: "2026-09-26T05:36:02.343Z" }
---

# BFF (Backend-for-Frontend)

The BFF is server-side code that lives *inside* the same Expo Router codebase as the client app (see
[Expo/React Native app](./expo-app.md)) but runs only on the server: business
logic in `frontend/mcm-app/src/bff-server/`, HTTP surface as Expo Router `+api.ts` handlers under
`frontend/mcm-app/src/app/bff-api/`. In production/Docker it is served by `frontend/mcm-app/server.js`
(an Express adapter around `@expo/server`). This split exists so the client never holds a raw
credential — see [Auth chain](../invariants/auth-chain.md), which the BFF is the primary
enforcement point for.

Route groups: `bff-api/auth/*` (login, refresh, logout, registration, email verification),
`bff-api/collections/*` and `.../movies/*` (proxy CRUD to [mc-service](./mc-service.md)),
`bff-api/agent/*` (forwards agent turns to the [Agent Gateway](./agent-gateway.md) over AG-UI,
plus `agent/config` for the user's own provider/TMDB credentials), `bff-api/backups/*`
(destinations, jobs, and the internal scheduling tick), `bff-api/admin/settings`. Every proxy
route follows the same shape: `requireAuth()` → `requireMcUser()`/`requireMcAdmin()` RBAC check
→ a per-request `mc-service-client.ts` Axios instance carrying the caller's JWT as
`Authorization: Bearer` → `handleMcApiError()` translates mc-service's RFC 9457 problem+json on
failure. The client never calls mc-service directly.

## The BFF's own state: MongoDB and Redis

Unlike a pure proxy, the BFF owns two features' worth of durable state directly, in a MongoDB
instance dedicated to the BFF (separate from mc-service's own database — the BFF never reaches
across a service boundary into a backend service's store):

- **Per-user agent config** (feature 018, `agent-config-service.ts` / `agent-config-store.ts`):
  each user's chosen LLM provider, encrypted API keys/Ollama URL, and TMDB key, so the assistant
  can run with the user's own credentials rather than a shared one. Secrets are AES-256-GCM
  sealed with `AGENT_CONFIG_ENC_KEY`, decrypted only transiently per run, and never returned to
  the client or logged. A user-supplied Ollama URL is validated against an SSRF guard
  (`agent-config-ssrf.ts`) before it is ever saved or probed: by policy it allows private/LAN
  addresses ("bring your own Ollama" is the point), always blocks link-local and cloud-metadata
  addresses, and — since item #542 — narrows loopback to only the ports Ollama itself uses
  (`AGENT_OLLAMA_LOOPBACK_PORTS`, default `11434`), because inside a container loopback is this
  server, not the user's own machine. See
  [SSRF guard: canonicalized IP, not hostname string](../gotchas/agent-config-ssrf-guard.md)
  for the mechanism shared with the backups guard below (do not re-derive it here).
- **Scheduled collection backups** (feature 073, `backup-*.ts`): per-user destinations
  (S3-compatible or WebDAV, credential sealed with a *separate* `BACKUP_CREDENTIAL_ENC_KEY`),
  jobs (what/where/how often/how many to keep), and run history. An unattended scheduled run
  acts as the user via a Keycloak **offline token** they explicitly granted — there is no
  service account and no privileged fallback; if the grant is gone, the run fails rather than
  finding another way in. Destination addresses go through a *different*, inverse-default SSRF
  guard (`backup-destination-url-guard.ts`; private/loopback/link-local denied unless the host is
  on `BACKUP_ALLOWED_DESTINATION_HOSTS`). The two guards keep opposite **policies** by design (an
  Ollama endpoint is expected to be on the LAN, a backup destination is expected to be remote),
  but as of item #542 they no longer differ in **mechanism**: both resolve the hostname, check
  every DNS answer (not just the first), and pin the outbound connection to that vetted address
  set via `createPinnedAgent` (`pinned-agent.ts`, extracted so both guards can share it) — closing
  the TOCTOU window a name-only check would leave, where the resolver could hand back a different
  answer to the HTTP stack than the one just checked. Also owned by
  [the SSRF guard page](../gotchas/agent-config-ssrf-guard.md), which documents both guards
  side by side.

Both collections' Mongo instance is a **standalone `mongod`, not a replica set** — there is no
multi-document transaction available anywhere in the BFF's own store. That single fact shapes
the backup job-claim design below and is the first thing to know before extending either
feature. Full operating detail: `docs/runbooks/backups.md` and
`frontend/mcm-app/README.md`'s "Two standing constraints" section (not reproduced here).

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
- **A silently empty Mongo client-metadata document means Jest, not a driver/server mismatch.**
  `mongodb` driver ≥7.6.0 resolves its OS adapter via a dynamic `import('os')`
  (`lib/runtime_adapters.js`); Jest's CJS runtime can't execute that without
  `--experimental-vm-modules`, so the promise rejects — and the driver deliberately swallows the
  rejection (`squashError`), collapsing the client metadata to `{}`. MongoDB then refuses the
  handshake ("Missing required sub-document 'driver'"), which looks exactly like a driver/server
  incompatibility and is not one: the same driver version connects fine from plain Node against
  the same server. `mongo-client.ts` works around it by passing `runtimeAdapters: { os }` (a
  static `import * as os from 'node:os'`) so the dynamic import branch never runs, keeping tests
  and production on one code path. Do not "fix" this instead by setting
  `NODE_OPTIONS=--experimental-vm-modules` repo-wide — that flips on experimental module handling
  for every integration suite to work around two lines in one file.
- **The Redis leader lock around the backup scheduling tick is an optimisation, not the
  exactly-once guarantee.** `redis-lock.ts` lets only one BFF instance scan for due jobs per
  tick when several are running, but its safety rests on a TTL — a guess at how long a run can
  take — so an overrunning run legitimately loses the lock to another instance while still live.
  The actual exactly-once guarantee is a single-document atomic `findOneAndUpdate` claim on the
  job itself (`backup-job-store.ts`), which carries no timing assumption at all and is what
  survives the BFF's Mongo having no replica set (and therefore no multi-document transactions)
  to tie a claim to a run record. A passing lock test proves nothing about double-firing; only
  the job-store claim does.

See [Auth chain](../invariants/auth-chain.md) for the full login-to-request-validation
sequence, and [Secrets management](../invariants/secrets-management.md) for how the BFF's own
credentials (client secret, cookie/encryption keys, the two backup/agent-config master keys) are
sourced. Full setup and env-var reference: `frontend/mcm-app/README.md` and
`docs/runbooks/local-dev.md`; scheduled-backups operations: `docs/runbooks/backups.md`.
