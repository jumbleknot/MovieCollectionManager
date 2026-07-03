# Phase 0 Research: Production Public-Hostname Authentication

All unknowns from the Technical Context are resolved below. Each item: **Decision / Rationale / Alternatives**.

## R1 — Public issuer vs. internal back-channel (the central problem)

**Decision**: Set the production BFF env `KEYCLOAK_PUBLIC_URL=https://auth.${BASE_DOMAIN}` while `KEYCLOAK_URL=http://keycloak-service:8080` (internal). Set Keycloak `KC_HOSTNAME=https://auth.${BASE_DOMAIN}` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`.

**Rationale**: [token-service.ts](../../frontend/mcm-app/src/bff-server/token-service.ts) builds the accepted-issuer set from **both** `env.keycloakPublicUrl` and `env.keycloakUrl` (`…/realms/<realm>`), and [config/env.ts](../../frontend/mcm-app/src/config/env.ts) maps `keycloakPublicUrl: optionalEnv('KEYCLOAK_PUBLIC_URL') || keycloakUrl`. So the BFF already accepts a browser-facing issuer distinct from its connect URL. Keycloak pins the issuer to the public origin while still answering back-channel calls (token/JWKS) from `keycloak-service:8080`. This is the exact mechanism feature 007 used for the dev container (`localhost:8099` issuer vs `keycloak-service:8080` back-channel) — proven, no code change.

**Alternatives**: (a) Make the BFF reach Keycloak at the public URL too — rejected: forces egress→edge→back for every internal call, adds latency and a hard dependency on the tunnel for server-side validation. (b) Disable issuer validation — rejected: violates constitution Token Validation.

## R2 — Canonical realm name (`grumpyrobot` vs `jumbleknot`)

**Decision**: The realm is **`grumpyrobot`**. Use it in `prod-realm.json`, BFF `KEYCLOAK_REALM`, and all prod config.

**Rationale**: `frontend/mcm-app/.env.local` and `.env.docker` both set `KEYCLOAK_REALM=grumpyrobot` (the live dev values); the work order agrees. The only `jumbleknot` realm reference is in `frontend/mcm-app/.env.docker.example`, which is a **stale template** (the 2026-06-20 rebrand renamed the realm in place but missed this example file). The GitHub/Forgejo **org** stays `jumbleknot` — that is intentional and unrelated to the realm.

**Alternatives**: none — this is a fact-check, not a choice. Fixing the stale `.env.docker.example` is an adjacent cleanup task (low priority, outside the prod-login critical path).

## R3 — Where prod compose files live & how they deploy

**Decision**: One standalone prod compose per stack, beside its dev sibling: `infrastructure-as-code/docker/keycloak/compose.prod.yaml` (`name: prod-auth`) and `infrastructure-as-code/docker/bff/compose.prod.yaml` (`name: prod-app`). Each is its own Komodo Stack. The committed `docs/proposals/homelab-setup/keycloak-prod.compose.yaml` is the ready Keycloak draft to move in.

**Rationale**: Komodo deploys per-stack compose files and promotes by digest; standalone files match that and the existing draft. The dev feature-020 `include`/`profiles` layer is for the local multi-stack dev loop and is left untouched. Keeping prod files in the component dirs (not `stacks/`) avoids entangling prod with the dev aggregation.

**Alternatives**: (a) `stacks/*.compose.prod.yaml` include-wrappers — rejected as unnecessary indirection for single-instance prod. (b) One mega prod compose — rejected: couples Keycloak (deployable now) to the BFF (blocked on the image pipeline), defeating the work order's staged order.

## R4 — Secure cookie + production mode

**Decision**: Run the prod BFF with `NODE_ENV=production`.

**Rationale**: [auth.ts](../../frontend/mcm-app/src/bff-server/auth.ts) sets the cookie `Secure` flag as `!env.isDevelopment`, and [config/env.ts](../../frontend/mcm-app/src/config/env.ts) derives `isDevelopment = NODE_ENV === 'development'`. `NODE_ENV=production` therefore yields `Secure` cookies and (per [logger.ts](../../frontend/mcm-app/src/bff-server/logger.ts)) suppresses debug logs — satisfying both the Session and Logging constitution gates. Cookies are host-only (`Path=/`, no `Domain` attribute) and `SameSite=Strict`; since the web app and `bff-api` are same-origin on `mcm.${BASE_DOMAIN}`, host-only cookies are correct and need no `Domain`.

**Alternatives**: explicitly setting a cookie `Domain=mcm.${BASE_DOMAIN}` — rejected: unnecessary and would broaden scope to subdomains; host-only is tighter.

## R5 — CORS posture

**Decision**: No permissive CORS. The web client and BFF are **same-origin** (`mcm.${BASE_DOMAIN}` serves both the app and `bff-api/*`), so normal flows need no cross-origin grant; `SameSite=Strict` cookies plus same-origin satisfy FR-014/FR-018. Verify no wildcard/`*` CORS is configured anywhere in the BFF; if any allow-list exists it must be the app origin only.

**Rationale**: Same-origin architecture is the strongest CORS posture and matches the constitution's "no wildcard on authenticated endpoints." Mobile uses the native HTTP client (not browser CORS).

**Alternatives**: adding an explicit CORS allow-list env — only if a genuine cross-origin need appears; none today.

## R6 — Prod APK backend/issuer baking

**Decision**: The prod APK build runs `build-apk.mjs` with `APK_VARIANT=release` and the public-host `EXPO_PUBLIC_*` values: `EXPO_PUBLIC_BFF_BASE_URL` / `EXPO_PUBLIC_BFF_NATIVE_URL = https://mcm.${BASE_DOMAIN}` and `EXPO_PUBLIC_KEYCLOAK_NATIVE_URL = https://auth.${BASE_DOMAIN}`, sourced from CI variables (not hard-coded).

**Rationale**: [build-apk.mjs](../../frontend/mcm-app/scripts/build-apk.mjs) embeds `EXPO_PUBLIC_*` into the release bundle at build time; [config/keycloak.ts](../../frontend/mcm-app/src/config/keycloak.ts) and the client read exactly these vars. No script logic change — only the build-time env values differ for prod.

**Alternatives**: a dedicated prod entry point — rejected: the variant flag + env already covers it.

## R7 — `edge-network` and the naming gate

**Decision**: Name the shared ingress network `edge-network` and add it to `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs` (and `contracts/naming-convention.md` if present) **before** the prod compose enters the gated path (`infrastructure-as-code/docker/**/compose*.yaml`).

**Rationale**: The gate enforces `^[a-z0-9-]+-network$` **and** an allowlist. `edge` failed both; `edge-network` satisfies the regex and the allowlist edit closes the gate. cloudflared and the two public services join `edge-network` so cloudflared resolves them by name (direct edge-TLS).

**Alternatives**: weaken the gate regex — rejected (constitution/feature-019 convention is the standard). Reuse `backend-network` for ingress — rejected: keeps the public-facing path isolated from internal service traffic.

## R8 — Realm export sanitization & SMTP/registration posture

**Decision**: One-time export from dev (`kc.sh export --realm grumpyrobot --users realm_file`), then sanitize: strip dev redirect URIs (`localhost:8099`, `10.0.2.2`), strip real client secrets and SMTP creds, set `bruteForceProtected: true`, leave `smtpServer` empty/placeholder, and set `registrationAllowed: false` (self-registration deferred until real SMTP). Commit as `prod-realm.json`, wire `--import-realm` + a read-only mount. Keep separate from the CI throwaway realm.

**Rationale**: Registration/verification/reset email cannot send without SMTP, so opening registration would produce dead-end flows; the spec scopes this feature to login for existing users (Assumptions). Brute-force on is a constitution IdP-boundary requirement. The committed file must carry no secrets (secret-scan gate).

**Alternatives**: bake redirect URIs/secrets into the realm — rejected: redirect URIs yes (sanitized to prod values), secrets no (gate + constitution).

## R9 — Prod secret materialization (vs. dev `gen-dev-secrets.mjs`)

**Decision**: Prod secrets are **operator-managed**, injected at deploy (Komodo/Vault); the committed deliverable is `*.env.prod.example` (placeholders only). `gen-dev-secrets.mjs` stays **dev-only** (it writes `stacks/*.env`, including `KC_DB_PASSWORD`).

**Rationale**: Production values must not be minted into the repo tree; the fail-fast `${VAR:?}` refs in the prod compose force them to be supplied at deploy. **Single-source DB password** (feature-022 follow-up, supersedes the original file-secret approach): one `${KC_DB_PASSWORD}` is interpolated by BOTH the Postgres service (`POSTGRES_PASSWORD`) and keycloak-service (`KC_DB_PASSWORD`) — the `secrets/keycloak_db_password.txt` file-secret, `POSTGRES_PASSWORD_FILE`, and the `.env.local` dual-source were removed across dev+prod+CI. On a fresh DB volume any value works; an existing volume keeps its original password.

**Alternatives**: extend `gen-dev-secrets.mjs` to emit `.env.prod` — rejected: blurs the dev/prod secret boundary and risks a generated prod secret landing on disk in the repo.

## R10 — HSTS / TLS 1.3 ownership

**Decision**: TLS 1.3 and HSTS are owned at the **Cloudflare edge** (enable "Always Use HTTPS" + HSTS in the Cloudflare dashboard for the zone). Internal cloudflared→container is plain HTTP on `edge-network`.

**Rationale**: With edge termination the origin never serves TLS, so HSTS must be set where TLS lives (the edge). This keeps a single cert owner (R per runbook 10.C note). Documented as the justified deviation in plan Complexity Tracking.

**Alternatives**: set HSTS at the BFF — only meaningful if the BFF terminated TLS, which it does not in the direct edge-TLS model; revisit if switching to the optional Caddy path.

## R11 — Public hostnames: app→`mcm` rename, shared IdP, and domain parameterization

**Decision**: (a) The application host is **`mcm.${BASE_DOMAIN}`** (renamed from `app.`), keeping the IdP host **`auth.${BASE_DOMAIN}`** as a **shared** Keycloak that can serve future apps (one instance, realm/client per app). (b) The real domain is **not committed**: every committed reference uses the `${BASE_DOMAIN}` placeholder; the real value is supplied at deploy via env (gitignored `*.env.prod`, Komodo/operator-injected) and CI variables for the APK build. (c) The Keycloak realm export commits redirect URIs/webOrigins with `${BASE_DOMAIN}` placeholders and is rendered to a **gitignored concrete realm file at deploy** (`envsubst` from a committed `prod-realm.json` template), since Keycloak realm-import env substitution is version-dependent and the template+`envsubst` path is deterministic.

**Rationale**: A single label deep (`mcm.${BASE_DOMAIN}`, `auth.${BASE_DOMAIN}`) keeps Cloudflare **Universal SSL** (free `*.${BASE_DOMAIN}` wildcard) valid and scales to N apps without per-product cert cost; a shared Keycloak is Keycloak's native multi-realm/multi-client model and gives cross-app SSO for free. Parameterizing the domain is **hygiene, not secrecy** — the live host is exposed in public Certificate-Transparency logs regardless — so it is treated as a config value, not a gated secret (it is not credential-shaped and does not trip the secret-scan/inline-secret gates). `BASE_DOMAIN` is a single var; both public hosts derive from it.

**Alternatives**: (a) Nest two labels deep (`mcm.app.${BASE_DOMAIN}` / `app.mcm.${BASE_DOMAIN}`) — rejected: needs Cloudflare Advanced Certificate Manager (paid) for the two-level wildcard, with no benefit. (b) Per-product auth host (`auth.mcm.…`) — rejected: a second Keycloak + the same cert-depth cost; the shared IdP is simpler. (c) Leave the literal domain in the repo — rejected per the maintainer's privacy preference (paired with a history scrub, since the literal already exists in committed history).

## Open items deferred to implementation (not blocking)

- **Exact mobile OAuth callback value** (app-link vs custom scheme) for the client redirect URIs — read from the mobile app config during A4 implementation.
- **Komodo Stack definitions + Cloudflare published routes + real secret injection** — operator steps (documented in the runbook), out of repo scope.
- **Stale `.env.docker.example` realm fix** — adjacent cleanup, tracked as a low-priority task.
