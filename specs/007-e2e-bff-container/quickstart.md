# Quickstart: E2E Against the BFF Docker Container — Runbook

Operator runbook. PowerShell shell; Bash also available. RTK active. Assumes the full backend stack is up (`pnpm nx up-all infrastructure-as-code`) and the feature-006 issuer fix is on `main`.

> **Prerequisite — stable Keycloak issuer (feature 007).** The container BFF refreshes tokens over the internal Docker network, so Keycloak's issuer must be pinned or the `refresh_token` grant is rejected (`invalid_grant: Invalid token issuer`). `infrastructure-as-code/docker/keycloak/compose.yaml` sets `KC_HOSTNAME=http://localhost:8099` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`. If Keycloak was already running from before this change, recreate it once: `docker compose --profile keycloak up -d keycloak-service`. Also ensure the `movie-collection-manager` client allows the container redirect URIs (`infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs`).

> **This is the FINAL E2E validation only.** All other test phases (unit, integration, iterative E2E) stay on Metro. Build/deploy the container only for this final run.

## 0. Build the BFF image (once per code change)

```powershell
pnpm nx docker-build mcm-app        # builds mcm-bff:latest (expo export + image)
```

## 1. US1 — Dev container (HTTP, non-Secure cookies)

```powershell
# Stop Metro so it cannot serve a false-green
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
# Start the dev-config BFF container (NODE_ENV=development, BFF_SOURCE=dev-container, :8082)
docker compose --profile bff-dev up -d
```

**Web** (container serves client + BFF):
```powershell
$env:E2E_BFF_TARGET='dev-container'   # baseURL -> container; disables Metro webServer; global-setup asserts X-BFF-Source
pnpm nx e2e mcm-app
```

**Mobile** (Metro serves JS on :8081; container serves /bff-api on :8082):
```powershell
# Emulator ritual (see CLAUDE.md), then reverse THREE ports:
#   8081 = Metro JS, 8082 = container BFF, 8099 = Keycloak (issuer must match the pinned localhost:8099)
adb reverse tcp:8081 tcp:8081 ; adb reverse tcp:8082 tcp:8082 ; adb reverse tcp:8099 tcp:8099

# Set the native URLs in frontend/mcm-app/.env.local (NOT inline — inline `$env:` does NOT reach
# the JS bundle; the values are inlined into the bundle from .env.local):
#   EXPO_PUBLIC_BFF_NATIVE_URL=http://localhost:8082
#   EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099   # must match pinned issuer, not 10.0.2.2
# Restart Metro with --reset-cache so the new values are re-inlined:
cd frontend/mcm-app ; pnpm exec expo start --port 8081 --reset-cache
pnpm nx e2e:mobile mcm-app
# AFTER the run: revert those two .env.local lines to their 10.0.2.2 defaults.
```

**Pass (SC-001)**: both suites green (verified 20/20 Maestro flows); confirm the app hit the container by watching `docker logs mcm-mcm-bff-dev-1` for `audit:login` / `mc_service_request` (not by Metro bundling `init+api.ts`, which is a harmless relative warm-up).

## 2. US3 — Prod container (HTTPS, Secure cookies)

```powershell
# Generate/trust the local TLS CA (mkcert or Caddy local CA), then start prod BFF + TLS proxy
docker compose --profile bff-prod up -d        # mcm-bff NODE_ENV=production behind Caddy on https://localhost:8443
```

**Web** — ✅ verified 93/93, 0 flaky, ~70s:
```powershell
$env:E2E_BFF_TARGET='prod-container'   # https baseURL + ignoreHTTPSErrors; X-BFF-Source: prod-container
pnpm nx e2e mcm-app
# Includes bff-prod-lifecycle.spec.ts (runs LAST as a dependent project): login -> delete the
# access cookie (= TTL expiry; a fake clock can't expire a server-validated JWT) -> transparent
# refresh recovers -> real logout -> tokens cleared + /auth/user 401 (BFF session + Keycloak SSO).
```

**Mobile — ⚠️ CA-trust-limited (research R3); deferred.** The app rejects Caddy's internal CA: the
debug APK allows cleartext (so the dev container on HTTP :8082 works) but has no
`network_security_config` trusting user CAs, and Android API 24+ ignores user CAs by default.
Enabling it needs a debug `network_security_config.xml` (`trust-anchors` → user+system) **plus an
APK rebuild** (Windows short-path recipe or the CI `android-apk` workflow), then install Caddy's CA
(`/data/caddy/pki/authorities/local/root.crt` from the `caddy-data` volume) and:
```powershell
adb reverse tcp:8081 tcp:8081 ; adb reverse tcp:8443 tcp:8443 ; adb reverse tcp:8099 tcp:8099
# .env.local (NOT inline): EXPO_PUBLIC_BFF_NATIVE_URL=https://localhost:8443 + EXPO_PUBLIC_KEYCLOAK_NATIVE_URL=http://localhost:8099
cd frontend/mcm-app ; pnpm exec expo start --port 8081 --reset-cache
pnpm nx e2e:mobile mcm-app
```

The app is already proven in-container (US1 mobile, 20/20 on dev HTTP) and the prod BFF over HTTPS by US3 web — the only unexercised delta is the emulator trusting the CA.

**Pass (SC-004/SC-005)**: both suites green incl. the lifecycle test; `Secure` cookies sent over HTTPS (not disabled); security review confirms hardening intact; `X-BFF-Source: prod-container`.

## 3. US4 — Return to local dev + cleanup

```powershell
docker compose --profile bff-dev down        # remove dev BFF container
docker compose --profile bff-prod down       # remove prod BFF + Caddy proxy
# Persistent external volumes + shared stack (Keycloak/Mongo/Redis/mc-service) untouched
# If you ran the mobile container suite, ensure the two .env.local native URLs are back to their
# 10.0.2.2 defaults (EXPO_PUBLIC_BFF_NATIVE_URL / EXPO_PUBLIC_KEYCLOAK_NATIVE_URL), then:
cd frontend/mcm-app ; pnpm exec expo start --port 8081
```

**Pass (SC-007)**: no orphaned BFF/proxy containers; normal Metro dev runs unchanged.

## 4. Regression (FR-011 / SC-006)

```powershell
pnpm nx test mcm-app ; pnpm nx test:integration mcm-app ; pnpm nx test mc-service ; pnpm nx test:integration mc-service
```

## Definition of Done (maps to Success Criteria)

- [ ] Dev container: web + mobile E2E green; `X-BFF-Source: dev-container` recorded (SC-001)
- [ ] Testing instructions updated: container for the final local E2E, Metro for all else (SC-002, SC-003)
- [ ] Prod container: web + mobile E2E green incl. login→expiry-refresh→logout; over HTTPS (SC-004)
- [ ] Security review: 0 unresolved High/Critical; `Secure`/TLS/token-validation hardening confirmed intact, not disabled for tests (SC-005)
- [ ] Zero end-user behavior change; pre-existing unit/integration/mc-service suites green (SC-006)
- [ ] Cleanup: no orphaned BFF/proxy containers; persistent stack intact; Metro dev works (SC-007)
- [ ] `rtk gain` per-test-run >80%
