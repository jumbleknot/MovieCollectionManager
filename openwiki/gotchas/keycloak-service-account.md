---
type: Gotcha
title: Service account vs admin credentials — Keycloak Admin API calls
description: Keycloak Admin API calls (user lookup, creation, role assignment, forced logout) use a dedicated service account authenticated via the client-credentials grant, never the realm admin password — keycloak.ts's getAdminToken() is the sole path that mints this token.
resource: frontend/mcm-app/src/bff-server/keycloak.ts
tags: [auth, keycloak, bff, security]
timestamp: 2026-07-30T11:50:53-04:00
---

# Service account vs admin credentials — Keycloak Admin API calls

Every BFF call into Keycloak's Admin REST API (`keycloakAdminApiBase`) — user lookup, user creation,
role assignment, forced session logout, email verification — authenticates as a dedicated Keycloak
service account via the OAuth2 client-credentials grant, not the realm admin password. `getAdminToken()`
in `keycloak.ts` posts `grant_type=client_credentials` with `keycloakServiceClientId` /
`keycloakServiceClientSecret` to the realm's token endpoint and returns the resulting `access_token`;
every Admin API caller (`keycloak.ts`, `email-service.ts`) goes through this helper. See
[the auth chain](/openwiki/invariants/auth-chain.md) for how this fits alongside the user-facing
authorization-code flow.

## Gotchas

- **Service account vs admin credentials**: Keycloak Admin API calls use a dedicated service account
  (client credentials grant), not the admin password.
- **The service account client is distinct from the user-facing app client.** `keycloakServiceClientId`
  (`KEYCLOAK_SERVICE_CLIENT_ID`, default `mcm-bff-service`) and its secret are separate credentials
  from `keycloakClientId` (`KEYCLOAK_CLIENT_ID`, the app's OAuth2/PKCE client used for
  `exchangeCodeForTokens`/`refreshTokens`). Do not reuse one client's credentials for the other's
  grant type.
- **`email-service.ts` duplicates its own `getAdminToken()`** rather than importing `keycloak.ts`'s,
  specifically to avoid a circular dependency. If the admin-token logic changes (grant params, error
  handling, endpoint), both copies need the same fix.
- **A missing or wrong service-account secret fails as a 503 `KEYCLOAK_UNAVAILABLE`**, not a 401 —
  `getAdminToken()` maps any non-OK token response to that error code, so an admin-token failure looks
  the same as Keycloak being down. Check the service-account secret first when Admin-API-backed routes
  (registration, forced logout, role assignment) start failing.
