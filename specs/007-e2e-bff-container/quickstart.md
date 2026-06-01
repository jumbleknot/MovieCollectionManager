# Quickstart: E2E Against the BFF Docker Container — Runbook

Operator runbook. PowerShell shell; Bash also available. RTK active. Assumes the full backend stack is up (`pnpm nx up-all infrastructure-as-code`) and the feature-006 issuer fix is on `main`.

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
# Emulator ritual + reverse BOTH ports; Metro started with the container BFF URL
adb reverse tcp:8081 tcp:8081 ; adb reverse tcp:8082 tcp:8082
cd frontend/mcm-app ; $env:EXPO_PUBLIC_BFF_NATIVE_URL='http://localhost:8082' ; pnpm exec expo start --port 8081
pnpm nx e2e:mobile mcm-app
```

**Pass (SC-001)**: both suites green; the run recorded `X-BFF-Source: dev-container` (not Metro).

## 2. US3 — Prod container (HTTPS, Secure cookies)

```powershell
# Generate/trust the local TLS CA (mkcert or Caddy local CA), then start prod BFF + TLS proxy
docker compose --profile bff-prod up -d        # mcm-bff NODE_ENV=production behind Caddy on https://localhost:<tls-port>
```

**Web**:
```powershell
$env:E2E_BFF_TARGET='prod-container'   # https baseURL + ignoreHTTPSErrors; X-BFF-Source: prod-container
pnpm nx e2e mcm-app
# Includes the new lifecycle test: login -> access-token expiry (fake clock) -> transparent refresh -> logout (incl. SSO)
```

**Mobile** (requires the emulator to trust the test CA — see research R3):
```powershell
# Install the local root CA on the emulator, then point the app at the HTTPS BFF
adb reverse tcp:8081 tcp:8081 ; adb reverse tcp:<tls-port> tcp:<tls-port>
cd frontend/mcm-app ; $env:EXPO_PUBLIC_BFF_NATIVE_URL='https://localhost:<tls-port>' ; pnpm exec expo start --port 8081
pnpm nx e2e:mobile mcm-app
```

**Pass (SC-004/SC-005)**: both suites green incl. the lifecycle test; `Secure` cookies sent over HTTPS (not disabled); security review confirms hardening intact; `X-BFF-Source: prod-container`.

## 3. US4 — Return to local dev + cleanup

```powershell
docker compose --profile bff-dev down        # remove dev BFF container
docker compose --profile bff-prod down       # remove prod BFF + Caddy proxy
# Persistent external volumes + shared stack (Keycloak/Mongo/Redis/mc-service) untouched
cd frontend/mcm-app ; Remove-Item Env:EXPO_PUBLIC_BFF_NATIVE_URL -ErrorAction SilentlyContinue ; pnpm exec expo start --port 8081
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
