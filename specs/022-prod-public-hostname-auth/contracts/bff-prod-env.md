# Contract: Production BFF configuration

**Artifact**: `infrastructure-as-code/docker/bff/compose.prod.yaml` + `.env.prod` (env names per [config/env.ts](../../../frontend/mcm-app/src/config/env.ts)).

## MUST hold (verifiable)

1. `NODE_ENV=production` → cookies carry `Secure` and debug logs are suppressed.
2. `KEYCLOAK_PUBLIC_URL=https://auth.${BASE_DOMAIN}` (browser-facing issuer the BFF accepts).
3. `KEYCLOAK_URL=http://keycloak-service:8080` (internal back-channel) and `KEYCLOAK_REALM=grumpyrobot`.
4. `REDIS_URL` points at the prod Redis (`redis://mcm-bff-cache-redis:6379`); session store is reachable (without it `/login` returns 500).
5. Secrets (`KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `COOKIE_SECRET`) are fail-fast `${VAR:?…}` references — no literals.
6. The BFF service joins `backend-network` + `edge-network` and publishes **no** host port (reached only via the tunnel).
7. Session cookies are `HttpOnly; SameSite=Strict; Secure`, host-only on `mcm.${BASE_DOMAIN}` (no `Domain` attribute) — unchanged from code, asserted by existing unit tests.
8. No wildcard CORS is configured; web app and `bff-api` are same-origin.

## Verify

- `docker compose -f compose.prod.yaml config` fail-fasts on any unset required var (SC-006).
- Both secret gates pass for the file (SC-005).
- Existing BFF cookie unit tests (`auth.test.ts`) still assert `Secure`+`SameSite=Strict` under production env.
- Post-deploy: a login from a public-network browser establishes a `Secure` session and reaches a protected screen (SC-001); an expired access token is refreshed against the public `auth.` origin without re-login (SC-007).
