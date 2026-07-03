# Phase 1 Data Model: Production Public-Hostname Authentication

This feature has **no application data model** (no entities, schemas, or migrations). The "entities" here are **configuration artifacts** — their fields are config keys, and their "validation rules" are the constraints that must hold for production login to work and for the CI gates to pass.

## Entity: Production Keycloak deployment config

The production identity-provider compose (`infrastructure-as-code/docker/keycloak/compose.prod.yaml`, `name: prod-auth`).

| Field | Production value | Constraint |
|---|---|---|
| `command` | `start` | Must be production mode (not `start-dev`). |
| `KC_HOSTNAME` | `https://auth.${BASE_DOMAIN}` | Public issuer origin; must be HTTPS public host. |
| `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` | `"true"` | Keeps issuer fixed while back-channel resolves internally. |
| `KC_HTTP_ENABLED` | `"true"` | Edge terminates TLS → container serves HTTP. |
| `KC_PROXY_HEADERS` | `xforwarded` | Trust forwarded proto/host from the tunnel. |
| `KC_HOSTNAME_ADMIN` | tailnet admin URL (`http://server.tailnet.ts.net:8099`) | Admin console off the public host. |
| admin port binding | `<tailscale-ip>:8099:8080` | Bound to the tailnet IP only — never public. |
| `KC_HEALTH_ENABLED` | `"true"` | Health endpoint for the deploy probe. |
| `KC_BOOTSTRAP_ADMIN_USERNAME` | `admin` | First-run bootstrap only. |
| `KC_BOOTSTRAP_ADMIN_PASSWORD` | `${KC_BOOTSTRAP_ADMIN_PASSWORD:?set in .env.prod}` | Fail-fast ref; no literal. Retire after named-admin+2FA created. |
| DB password | `POSTGRES_PASSWORD` + `KC_DB_PASSWORD` both `${KC_DB_PASSWORD:?…}` | Single source of truth (feature-022 follow-up); no `secrets/*.txt` file-secret. |
| published DB port | none | Postgres must not be published. |
| realm import | `--import-realm` + read-only mount of `prod-realm.json` | Realm provisioned on start. |
| mailpit service | absent | Dev-only; removed in prod. |
| networks | `keycloak-network`, `backend-network`, `edge-network` | `edge-network` must be approved by the naming gate. |

## Entity: Production realm export (`prod-realm.json`)

| Field | Production value | Constraint |
|---|---|---|
| realm | `grumpyrobot` | Canonical realm (R2). |
| client | `movie-collection-manager` | The web+mobile OAuth client. |
| client roles | `mc-admin`, `mc-user` | Must be present; `mc-user` is the self-registration default. |
| `bruteForceProtected` | `true` | Constitution IdP-boundary requirement. |
| `registrationAllowed` | `false` | Deferred until real SMTP (Assumptions). |
| `smtpServer` | empty/placeholder | No real mail creds committed. |
| redirect URIs | prod web + mobile only | No `localhost:8099` / `10.0.2.2`; see client entity. |
| client secrets | **absent/redacted** | Secret-scan gate must pass. |

## Entity: OAuth application client (within the realm)

| Field | Production value | Constraint |
|---|---|---|
| valid redirect URIs | `https://mcm.${BASE_DOMAIN}/*` **and** the mobile callback (app-link / custom scheme) | Both required, or one client type fails after the IdP redirect. |
| web origins | `https://mcm.${BASE_DOMAIN}` | CORS allow for the web origin; no wildcard. |

## Entity: Production BFF deployment config

The production BFF compose (`infrastructure-as-code/docker/bff/compose.prod.yaml`) + its env. Authoritative env names from [config/env.ts](../../frontend/mcm-app/src/config/env.ts) and [.env.docker.example](../../frontend/mcm-app/.env.docker.example).

| Field (env var) | Production value | Constraint |
|---|---|---|
| `NODE_ENV` | `production` | Enables `Secure` cookies + suppresses debug logs. |
| `KEYCLOAK_PUBLIC_URL` | `https://auth.${BASE_DOMAIN}` | Browser-facing issuer the BFF accepts (R1). |
| `KEYCLOAK_URL` | `http://keycloak-service:8080` | Internal back-channel (token/JWKS/admin). |
| `KEYCLOAK_REALM` | `grumpyrobot` | Must match realm export. |
| `KEYCLOAK_CLIENT_ID` | `movie-collection-manager` | — |
| `KEYCLOAK_CLIENT_SECRET` | `${...:?}` (operator/Komodo) | Fail-fast; never committed. |
| `KEYCLOAK_SERVICE_CLIENT_ID` | `mcm-bff-service` | Service account for Admin API. |
| `KEYCLOAK_SERVICE_CLIENT_SECRET` | `${...:?}` (operator/Komodo) | Fail-fast; never committed. |
| `REDIS_URL` | `redis://mcm-bff-cache-redis:6379` | Session store; without it `/login` 500s. |
| `COOKIE_SECRET` | `${...:?}` (operator/Komodo, ≥32 chars) | Fail-fast; never committed. |
| `MC_SERVICE_URL` | `http://mc-service:3001` | Internal upstream. |
| session timeouts | `SESSION_IDLE_TIMEOUT_MS` / `SESSION_ABSOLUTE_TIMEOUT_MS` / `MAX_CONCURRENT_SESSIONS` | Carry prod values. |
| networks | `backend-network`, `edge-network` | `edge-network` so cloudflared reaches it by name. |
| published port | none | Reached only via the tunnel. |

## Entity: Production secret templates

| Artifact | Tracked? | Constraint |
|---|---|---|
| `keycloak/.env.prod.example` | ✅ committed | Placeholders only; keys `KC_DB_PASSWORD`, `KC_BOOTSTRAP_ADMIN_PASSWORD`. |
| `bff/.env.prod.example` | ✅ committed | Placeholders only; BFF prod server vars. |
| `keycloak/.env.prod`, `bff/.env.prod` | ❌ gitignored | Real values, operator-supplied / Komodo-injected (incl. `KC_DB_PASSWORD`). |

## Entity: Production mobile build artifact

| Field (build-time env) | Production value | Constraint |
|---|---|---|
| `APK_VARIANT` | `release` | Embedded bundle (not Metro). |
| `EXPO_PUBLIC_BFF_BASE_URL` / `EXPO_PUBLIC_BFF_NATIVE_URL` | `https://mcm.${BASE_DOMAIN}` | HTTPS public host — not IP, not `:8082`. |
| `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL` | `https://auth.${BASE_DOMAIN}` | Public auth host. |
| source of values | CI variables | Not hard-coded in the script. |

## Cross-entity invariants

- `KEYCLOAK_REALM` (BFF) == realm in `prod-realm.json` == `grumpyrobot`.
- `KC_DB_PASSWORD` is one var interpolated by BOTH the Postgres service (`POSTGRES_PASSWORD`) and keycloak-service — no file-secret (feature-022 follow-up).
- `KEYCLOAK_PUBLIC_URL` (BFF) host == `KC_HOSTNAME` (Keycloak) host == `auth.${BASE_DOMAIN}`.
- The client's redirect URIs include both `https://mcm.${BASE_DOMAIN}/*` and the mobile callback baked into the release APK.
- Every `${VAR}` in a committed prod compose is the fail-fast `${VAR:?…}` form — no inline literal, no `:-`/`??` default.
