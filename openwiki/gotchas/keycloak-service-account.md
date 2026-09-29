---
type: Gotcha
title: Service account vs admin credentials — Keycloak Admin API calls
description: Keycloak Admin API calls (user lookup, creation, role assignment, forced logout) use a dedicated service account authenticated via the client-credentials grant, never the realm admin password — keycloak.ts's getAdminToken() is that token's minter, duplicated once in email-service.ts to avoid a circular import.
resource: frontend/mcm-app/src/bff-server/keycloak.ts
tags: [auth, keycloak, bff, security]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-29T10:29:14.990Z
sources:
  - id: openwiki-source-8b28b8f7ca849a6400dddf6f
    resource: repo://frontend/mcm-app/src/bff-server/account-deletion.ts
  - id: openwiki-source-0ff64644c3a9837917af5e5d
    resource: repo://frontend/mcm-app/src/bff-server/email-service.ts
  - id: openwiki-source-d58b64a5afcc9df80ea92152
    resource: repo://frontend/mcm-app/src/bff-server/keycloak.ts
  - id: openwiki-source-7ee24640f6ecf841a7ce2b17
    resource: repo://frontend/mcm-app/src/bff-server/unit-tests/email-service.test.ts
  - id: openwiki-source-e69fe30016fa84209ae5e815
    resource: repo://frontend/mcm-app/src/config/env.ts
  - id: openwiki-source-60cf9a830f0ca275ffed94d7
    resource: repo://infrastructure-as-code/docker/keycloak/ci-realm.json
  - id: openwiki-source-3574b605c1922bedacc8f2fa
    resource: repo://infrastructure-as-code/docker/keycloak/dev-realm.json
  - id: openwiki-source-d332b78944bf7820230a82f2
    resource: repo://scripts/export-ci-realm.mjs
generated: { by: "openwiki/0.6.0", at: "2026-09-29T10:29:14.990Z" }
---

# Service account vs admin credentials — Keycloak Admin API calls

Every BFF call into Keycloak's Admin REST API (`keycloakAdminApiBase`) — user lookup, user creation,
role assignment, forced session logout, email verification — authenticates as a dedicated Keycloak
service account via the OAuth2 client-credentials grant, not the realm admin password. `getAdminToken()`
in `keycloak.ts` posts `grant_type=client_credentials` with `keycloakServiceClientId` /
`keycloakServiceClientSecret` to the realm's token endpoint and returns the resulting `access_token`;
every Admin API caller (`keycloak.ts`, `email-service.ts`) goes through this helper. See
[the auth chain](../invariants/auth-chain.md) for how this fits alongside the user-facing
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
- **A service account whose `realm-management` roles are missing fails differently — 403, not 503.**
  The realm seeds `service-account-mcm-bff-service` with `view-users`, `manage-clients` and
  `manage-users` from the `realm-management` client; without them the client still authenticates (the
  503 path above never triggers) and each Admin API call is rejected instead. A realm export does not
  carry service-account role mappings, so the export script has to reconstruct them explicitly — a
  partial import can therefore produce a service account that mints tokens and authorizes nothing.
- **The admin token is minted per call, never cached.** Each Admin API function in `keycloak.ts`
  calls `getAdminToken()` itself (unlike the discovery document, which is cached), so one user-facing
  operation can make several token requests and a rotated/mistyped secret takes every Admin API call
  down at once rather than degrading it.
- **Both credential sets are used on the account-deletion path, deliberately.** `account-deletion.ts`
  calls `deleteUser` and `logoutUserSessions` (service-account Admin API) alongside `revokeToken` (the
  app client's `revoke` endpoint) in one ordered run — only the Admin API steps depend on the
  service-account secret, so a 503 there says nothing about the token revocation step.
