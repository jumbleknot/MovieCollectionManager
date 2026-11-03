---
type: Gotcha
title: Service account vs admin credentials — Keycloak Admin API calls
description: Keycloak Admin API calls (user lookup, creation, role assignment, forced logout, email verification, redirect-URI registration) authenticate as a dedicated service account via the client-credentials grant, never the realm admin password — with a per-call admin token, a duplicated minter in email-service.ts, and several failure paths the BFF re-maps, warns about, or swallows outright instead of passing through.
resource: frontend/mcm-app/src/bff-server/keycloak.ts
tags: [auth, keycloak, bff, security]
sources:
  - id: openwiki-source-dc9c673c8dc973e1e621fa45
    resource: repo://frontend/mcm-app/src/app/bff-api/auth/init%2Bapi.ts
  - id: openwiki-source-3962f527ba083cef06c1e6a6
    resource: repo://frontend/mcm-app/src/app/bff-api/auth/register%2Bapi.ts
  - id: openwiki-source-990dbb7c25cfde4ba1d8330a
    resource: repo://frontend/mcm-app/src/app/bff-api/auth/resend-verification%2Bapi.ts
  - id: openwiki-source-8b28b8f7ca849a6400dddf6f
    resource: repo://frontend/mcm-app/src/bff-server/account-deletion.ts
  - id: openwiki-source-28b3de7a863c75f0b1b6b62c
    resource: repo://frontend/mcm-app/src/bff-server/backup-offline-token.ts
  - id: openwiki-source-0ff64644c3a9837917af5e5d
    resource: repo://frontend/mcm-app/src/bff-server/email-service.ts
  - id: openwiki-source-d58b64a5afcc9df80ea92152
    resource: repo://frontend/mcm-app/src/bff-server/keycloak.ts
  - id: openwiki-source-7ee24640f6ecf841a7ce2b17
    resource: repo://frontend/mcm-app/src/bff-server/unit-tests/email-service.test.ts
  - id: openwiki-source-7f78c834443744c0dcf8d134
    resource: repo://frontend/mcm-app/src/bff-server/unit-tests/keycloak-delete-user.test.ts
  - id: openwiki-source-a5bf09947adc24a8d59ab587
    resource: repo://frontend/mcm-app/src/bff-server/unit-tests/redirect-uri-registration.test.ts
  - id: openwiki-source-e69fe30016fa84209ae5e815
    resource: repo://frontend/mcm-app/src/config/env.ts
  - id: openwiki-source-b84c2ebda1fa9702c5fd6055
    resource: repo://frontend/mcm-app/tests/integration/backup-consent-redirect-uri.integration.test.ts
  - id: openwiki-source-60cf9a830f0ca275ffed94d7
    resource: repo://infrastructure-as-code/docker/keycloak/ci-realm.json
  - id: openwiki-source-16f23fb13b0e88082b534458
    resource: repo://infrastructure-as-code/docker/keycloak/compose.dev.yaml
  - id: openwiki-source-3574b605c1922bedacc8f2fa
    resource: repo://infrastructure-as-code/docker/keycloak/dev-realm.json
  - id: openwiki-source-f6b7a61bf48156b2722b6a7f
    resource: repo://infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs
  - id: openwiki-source-d332b78944bf7820230a82f2
    resource: repo://scripts/export-ci-realm.mjs
  - id: openwiki-source-d046d2ddea9d1d430ec2c0d2
    resource: repo://scripts/gen-dev-env.mjs
generated: { by: "openwiki/0.7.1", at: "2026-11-03T01:23:06.490Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-11-03T01:23:06.490Z
---

# Service account vs admin credentials — Keycloak Admin API calls

Every BFF call into Keycloak's Admin REST API (`keycloakAdminApiBase`, derived from the *internal*
`keycloakUrl` — see [Docker internal DNS](docker-internal-dns.md)) — user lookup, user creation,
role assignment, forced session logout, email verification, redirect-URI registration —
authenticates as a dedicated Keycloak service account via the OAuth2 client-credentials grant, not
the realm admin password. `getAdminToken()` in `keycloak.ts` posts `grant_type=client_credentials`
with `keycloakServiceClientId` / `keycloakServiceClientSecret` to the realm's token endpoint and
returns the resulting `access_token`; every Admin API caller (`keycloak.ts`, `email-service.ts`)
goes through this helper. See [the auth chain](../invariants/auth-chain.md) for how this fits
alongside the user-facing authorization-code flow.

```mermaid
sequenceDiagram
  participant Caller as BFF Admin API caller
  participant Tok as Keycloak token endpoint
  participant Admin as Keycloak Admin REST API
  Caller->>Tok: POST grant_type=client_credentials
  alt token refused
    Tok-->>Caller: non-OK
    Note over Caller: KEYCLOAK_UNAVAILABLE 503, or a warn on the redirect-URI path
  else token minted
    Tok-->>Caller: access_token
    Caller->>Admin: Bearer token on the admin path
    Admin-->>Caller: 2xx, or 403 without realm-management roles
  end
```

One Admin API call: a freshly minted client-credentials token, and the two failure shapes the BFF
never passes through unchanged — except on the redirect-URI path, which converts every one of them
into a warning instead.

## Failure-mode mapping

What each Admin API caller does with what Keycloak answers. Nothing here surfaces as a Keycloak
status code — `403` in particular is never propagated.

| Caller | Keycloak answers | BFF behaviour |
|---|---|---|
| `getAdminToken()` | token request non-OK | `AuthError` `KEYCLOAK_UNAVAILABLE`, **503** |
| `deleteUser` | 404 | treated as success (a retry after a partial delete must not fail) |
| `deleteUser` | anything else non-OK | `KEYCLOAK_UNAVAILABLE`, **502** |
| `countUsersInClientRole` | client lookup or role-members non-OK | `KEYCLOAK_UNAVAILABLE`, **502** — never `0` |
| `createUser` | 409 | `DUPLICATE_USERNAME` or `DUPLICATE_EMAIL`, **409** |
| `createUser` | other non-OK (a 403 included) | `INVALID_INPUT`, **400** |
| `sendVerificationEmail` (both copies) | non-OK | `KEYCLOAK_UNAVAILABLE`, **502** |
| `getUserById`, `isEmailVerified` | non-OK | `UNAUTHORIZED`, **404** |
| `getUserIdByEmail` | non-OK | returns `null` — indistinguishable from "no such user" |
| `assignMcUserRole` | client lookup non-OK | nothing is checked — `KEYCLOAK_UNAVAILABLE`, **500** when the error body still parses (there is no `[0].id`), a generic **500** when it does not |
| `assignMcUserRole` | role lookup or role-mapping POST non-OK | ignored — neither response is inspected |
| `logoutUserSessions`, `revokeToken` | any | ignored |
| `ensureClientRedirectUris` | any | warns `redirect_uri_registration_failed` with a `step` and `status`, and stays unrecorded; the caller still gets `{ok: true}` |

The `step` on that last row is one of `client_lookup`, `client_fetch`, `update` or `error`, so a
403 from a service account without `manage-clients` lands in the logs as an `update` (or
`client_lookup`) warning rather than in any BFF response.

## Gotchas

- **Service account vs admin credentials**: Keycloak Admin API calls use a dedicated service account
  (client credentials grant), not the admin password.
- **The service account client is distinct from the user-facing app client.** `keycloakServiceClientId`
  (`KEYCLOAK_SERVICE_CLIENT_ID`, default `mcm-bff-service`) and its secret are separate credentials
  from `keycloakClientId` (`KEYCLOAK_CLIENT_ID`, the app's OAuth2/PKCE client used for
  `exchangeCodeForTokens`/`refreshTokens`). The realm files keep the two apart by capability, not just
  by name: `mcm-bff-service` is a confidential client with `serviceAccountsEnabled: true` and
  `standardFlowEnabled: false`, while `movie-collection-manager` has `standardFlowEnabled: true` and
  `serviceAccountsEnabled: false`. Do not reuse one client's credentials for the other's grant type.
- **`email-service.ts` duplicates its own `getAdminToken()`** rather than importing `keycloak.ts`'s,
  specifically to avoid a circular dependency. If the admin-token logic changes (grant params, error
  handling, endpoint), both copies need the same fix.
- **The two copies are not otherwise identical, so "fix both" is not a copy-paste.** `keycloak.ts`'s
  copy goes through its local `keycloakFetch()` wrapper, which attaches the request's `X-Request-Id`
  header; `email-service.ts`'s copy calls bare `fetch`, so its token request is untraceable in the
  request-scoped logs. `sendVerificationEmail` also reads the client id from a different source in
  each copy (`env.keycloakClientId` in `keycloak.ts`, `keycloakConfig.clientId` in
  `email-service.ts`) — same value in practice, two places to keep in step.
- **A missing or wrong service-account secret fails as a 503 `KEYCLOAK_UNAVAILABLE`**, not a 401 —
  `getAdminToken()` maps any non-OK token response to that error code, so an admin-token failure looks
  the same as Keycloak being down. Check the service-account secret first when Admin-API-backed routes
  (registration, forced logout, role assignment) start failing.
- **A service account whose `realm-management` roles are missing fails differently — not 503.**
  The committed dev and CI realm files seed `service-account-mcm-bff-service` with `view-users`,
  `manage-clients` and `manage-users` from the `realm-management` client; without them the client
  still authenticates (the 503 path above never triggers) and Keycloak rejects each Admin API call
  with 403 — which the BFF never passes through. Each function re-maps it: `deleteUser`,
  `countUsersInClientRole` and `sendVerificationEmail` answer 502 `KEYCLOAK_UNAVAILABLE`, `createUser`
  answers 400 `INVALID_INPUT`, `ensureClientRedirectUris` logs a warning and retries, and
  `logoutUserSessions` ignores the failure entirely. Do not look for a 403 in BFF responses. A realm
  export does not carry service-account role mappings, so the export script has to reconstruct them
  explicitly — a partial import can therefore produce a service account that mints tokens and
  authorizes nothing.
  The reconstruction lives in [`scripts/export-ci-realm.mjs`](../../scripts/export-ci-realm.mjs),
  which writes `service-account-<clientId>` users carrying each service account's realm and client
  roles; [the Keycloak project page](../projects/keycloak.md) covers how the committed realm variants
  are derived from it.
- **`ensureClientRedirectUris()` is a second Admin API path, and it never fails the request — it
  warns and stays unrecorded.** Called from the app-mount route `GET /bff-api/auth/init` with the
  complete list of redirect URIs this client needs (see [the BFF project page](../projects/bff.md)),
  it mints an admin token, looks up the named client, fetches its full representation, and PUTs that
  representation back with `redirectUris: [...existing, ...missing]`. Feature 083 gave it a
  `keycloakClientId` parameter defaulting to the login client, so the backup-consent client's own
  callback can be registered on *that* client — on the login client alone, Keycloak refuses the
  consent authorization request — and `init` makes a second call with
  `env.backupConsentClientId` only when that differs from the login client. Its whole body sits
  inside a `try`, and no path rethrows: `GET /bff-api/auth/init` always answers `{ok: true}`.
  Every failure path instead goes through a local `unrecorded(step, status)` helper that logs
  `logger.warn('redirect_uri_registration_failed', { action: 'ensure_redirect_uris', step, status })`
  with `step` one of `client_lookup`, `client_fetch`, `update` or `error` (feature 085, item #753) —
  never the admin token, the client representation or the URI list. So a service account without
  `manage-clients`, or a Keycloak outage, still leaves the redirect URI unregistered and still tells
  the caller nothing; what changed is that the failure is no longer silent. The symptom still arrives
  later and elsewhere — Keycloak rejects the authorize request for the flow whose URI went missing —
  but the warning now names the registration step and status that should have prevented it, instead
  of an operator having to add the entry by hand with nothing to go on.
- **The per-process "done" mark is set only when Keycloak confirmed the work.**
  `ensureClientRedirectUris` is one-shot per client id per process lifetime, tracked in a module-level
  `Set`, and the client id is added to that `Set` only when nothing was missing or the `PUT` answered
  2xx. A rejected update, a failed lookup or a thrown error leaves the id absent, so the next
  `GET /bff-api/auth/init` retries it rather than skipping it permanently. Before feature 085 a
  rejected `PUT` still latched the mark, so an address that was never registered stayed that way
  until a restart — with nothing logged.
  `unit-tests/redirect-uri-registration.test.ts` pins each case, one client id per case because the
  mark is per client per process: a rejected update (`403`/`400`/`500`) is warned and retried, a
  successful update is not repeated, nothing-missing is not repeated, and a failed client lookup stays
  unrecorded and is retried. It also asserts the warning carries no admin token, client secret or URI
  value.
- **The service-account secret is shared three ways, and the BFF is only one of its readers.** The
  committed dev/CI realm files declare `mcm-bff-service`'s secret as the placeholder
  `${KEYCLOAK_SERVICE_CLIENT_SECRET}`, which Keycloak resolves from the keycloak container's env at
  `--import-realm`; `scripts/gen-dev-env.mjs` projects the *same* value into the BFF env files, so
  realm-secret equals BFF-secret by construction (in CI both come from one Forgejo secret). That script
  also verifies the equality rather than assuming it: it runs a real `client_credentials` grant against
  the running realm and refuses to write the files if the realm rejects the credentials. Outside the
  BFF the same credentials are used by
  [`add-container-redirect-uris.mjs`](../../infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs),
  which reads `KEYCLOAK_SERVICE_CLIENT_SECRET` from the environment and falls back to
  `frontend/mcm-app/.env.docker`, and by
  [`backup-consent-redirect-uri.integration.test.ts`](../../frontend/mcm-app/tests/integration/backup-consent-redirect-uri.integration.test.ts),
  which mints its own client-credentials token and skips itself unless that variable is set (it throws
  when `MCM_REQUIRE_LIVE_STACK=1`). A realm re-import that resolves the placeholder to a different
  value, or a rotation applied on only one side, leaves every one of them failing with the same
  503 `KEYCLOAK_UNAVAILABLE`.
- **A missing service-account secret is not a startup failure.** `keycloakServiceClientSecret` is read
  with an empty-string fallback (`requireEnv('KEYCLOAK_SERVICE_CLIENT_SECRET', '')`), so an unset
  variable produces an empty `client_secret` on the token request rather than a boot error — the
  failure only appears when an Admin-API-backed route is exercised, as the 503 described above. The
  login client's secret is loaded the same way, for the same reason: both are optional for a public
  client and required for a confidential one.
- **A swallowed 403 can read as a successful no-op.** `getUserIdByEmail` returns `null` for *any*
  non-OK Admin response, and `/bff-api/auth/resend-verification` deliberately answers success for an
  unknown email (it must not be a user-enumeration oracle) — so a service account that lost
  `view-users` produces "if that email is registered and unverified, a link has been sent" rather
  than an error. `assignMcUserRole` never inspects the response to its role-mapping POST (and does
  not check the role-lookup GET either), so a registration can report success while the `mc-user`
  role assignment failed; the user then authenticates and is refused by the role gate. One path is
  *not* silent: a 403 on that function's client lookup leaves an unchecked body with no `[0].id`, so
  it throws `KEYCLOAK_UNAVAILABLE` with status **500** — a third signature, distinct from the 502 and
  503 above.
- **The admin token is minted per call, never cached.** Each Admin API function in `keycloak.ts`
  calls `getAdminToken()` itself (unlike the discovery document, which is cached), so one user-facing
  operation can make several token requests — registration mints for `createUser`,
  `assignMcUserRole` and `sendVerificationEmail`, and the resend route mints for the lookup and again
  for the send — and a rotated/mistyped secret takes every Admin API call down at once rather than
  degrading it.
- **The swallowed paths are not uniform, and the differences are deliberate.** `deleteUser` counts a
  404 as success because a retry after a partial failure re-issues the delete against an account the
  first attempt already removed; treating that as an error would break the retry that rescues a
  half-finished deletion. `logoutUserSessions` and `revokeToken` ignore failures because the BFF
  session and token are already gone and the token expires anyway. Contrast the offline-token
  revocation in `backup-offline-token.ts`, which deliberately does *not* reuse `revokeToken` and
  instead reports whether the revocation worked: an offline token never expires, so "revocation
  failed" has to be a fact the caller can see.
- **Both credential sets are used on the account-deletion path, deliberately.** `account-deletion.ts`
  calls `deleteUser` and `logoutUserSessions` (service-account Admin API) alongside `revokeToken` (the
  app client's `revoke` endpoint) in one ordered run — only the Admin API steps depend on the
  service-account secret, so a 503 there says nothing about the token revocation step. The identity
  deletion runs last, and its 404-as-success rule above is what makes a retry of that pipeline
  completable.
