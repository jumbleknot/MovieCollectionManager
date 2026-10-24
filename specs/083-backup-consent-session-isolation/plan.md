# Implementation Plan: Revoking backup consent must not end the user's sign-in session

**Branch**: `fix/702-backup-consent-session` | **Date**: 2026-10-24 | **Spec**: [spec.md](./spec.md)

## Summary

Move the backup consent round trip onto a **dedicated Keycloak client**, `mcm-backup-consent`.
Revoking a grant then detaches only that client from the member's Keycloak session, and the
login client's session survives. This was measured: it is the only variant of five that keeps
the online session alive (spec, Measured Baseline). Mint and revoke authenticate as whichever
client the stored grant was issued to, read from its `azp` claim. Grants made before this change
keep working, and no stored data changes shape.

## Technical Context

- **Language/runtime**: TypeScript, the BFF inside the Expo Router server (`frontend/mcm-app`).
- **Identity provider**: Keycloak 26.8.0; realms `dev-realm.json`, `ci-realm.json` and
  `prod-realm.json` under `infrastructure-as-code/docker/keycloak/`.
- **Tests**: Jest unit (`src/bff-server/unit-tests`) and Jest integration against a live Keycloak
  and Mongo (`tests/integration`, `nx test:integration mcm-app`).
- **Constraints**: no new secret anywhere (no new Forgejo Actions secret, no new Komodo variable);
  production must keep working before the operator creates the client.

## Design

### 1. Configuration (`src/config/env.ts`)

```ts
backupConsentClientId: optionalEnv('BACKUP_CONSENT_CLIENT_ID') || <keycloakClientId>,
backupConsentClientSecret: optionalEnv('BACKUP_CONSENT_CLIENT_SECRET') || <keycloakClientSecret>,
```

When unset, both fall back to the login client: today's behaviour (FR-003, US3-AC1).

**Why the dedicated client shares the login client's secret in dev and CI.** The secret's only
custodian is the BFF, which already holds the login secret. A second value would add no separation,
but it would need a new Forgejo Actions secret before CI could pass, and a new Komodo variable before
prod could use it. Both are operator-only. The realm entries therefore use
`${KEYCLOAK_CLIENT_SECRET}`. `BACKUP_CONSENT_CLIENT_SECRET` exists so production can choose a
separate value later without a code change.

### 2. `src/bff-server/backup-offline-token.ts`

- `buildConsentRequest` uses `env.backupConsentClientId`. When that equals the login client, it
  logs one warning per process naming #702.
- `completeConsent` exchanges the code as the consent client.
- `credentialsFor(refreshToken)` decodes the stored token's `azp`, unverified. The token is our own,
  sealed at rest, and Keycloak re-verifies it on use. It returns the matching client id and secret.
  An unknown `azp` is not possible for a grant this BFF stored, so it gets the login client's id
  with the login secret; Keycloak then refuses the mismatch, and the grant fails as unusable, which
  is the FR-024 posture. An unreadable token is unusable.
- `mintUserAccessToken` and `revokeOfflineTokenAtIdp` use `credentialsFor(token)`.

### 3. Redirect registration (`keycloak.ts`, `app/bff-api/auth/init+api.ts`)

`ensureClientRedirectUris(uris, clientId = env.keycloakClientId)` gains the client parameter and a
once-per-client flag (it is once-per-process today). The init route keeps its six URIs on the login
client unchanged; the fallback path still needs the consent URI there. When a distinct consent
client is configured, it also registers the consent URI on that client.

### 4. Realms

`mcm-backup-consent` in `dev-realm.json` and `ci-realm.json`:

- confidential, `secret: ${KEYCLOAK_CLIENT_SECRET}`;
- standard flow only: direct grants, implicit flow and service accounts off;
- `pkce.code.challenge.method: S256`;
- redirect URIs: the three consent callbacks (`:8081`, `:8082`, `:8443`);
- default client scopes as the login client; optional scopes include `offline_access`;
- the `mc-service-audience` mapper (`included.client.audience: movie-collection-manager`).
  mc-service's `expected_audiences` is the login client id, and unattended runs call mc-service
  with the minted token (US2-AC1).

`prod-realm.json` gets the same client with no secret (Keycloak generates one) and redirect URI
`https://mcm.${BASE_DOMAIN}/bff-api/backups/consent`. `export-ci-realm.mjs` maps the client to
`${KEYCLOAK_CLIENT_SECRET}`, so a re-export keeps the placeholder.
`check-realm-consistency.mjs` needs no change: the client set changes identically in dev and CI.

### 5. Environments

- `scripts/gen-ci-env.mjs` writes `BACKUP_CONSENT_CLIENT_ID=mcm-backup-consent` (FR-005). CI's
  integration tier reads the same generated `.env.docker`, so the fixed path is what both tiers
  exercise.
- **Dev is opt-in, not defaulted.** A dev box's realm volume is imported `IGNORE_EXISTING`, so an
  established box lacks the client, and defaulting the variable in `gen-dev-env.mjs` would break
  consent there.
- Production: no change in this PR. The operator creates the client in the live realm and then
  sets `BACKUP_CONSENT_CLIENT_ID`. The step is a `kcadm.sh` block run inside the Keycloak container,
  which needs no typed secret and is idempotent; it is validated against Keycloak 26.8.0 on a realm
  imported without the client. It lives in `docs/runbooks/backups.md`, with a backlog item to run it.
  The BFF does NOT create the client itself: that would be a broader runtime privilege than this fix
  needs, and the prod service account's rights are not recorded in the repo.

## Tests

| Tier | File | What it pins |
|---|---|---|
| Integration (live KC + Mongo) | `tests/integration/backup-consent-session.integration.test.ts` (new) | US1-AC1..3, US2-AC1: browser login, then consent **in the same cookie jar** through `buildConsentRequest`/`completeConsent`, then `revokeOfflineToken`; the online token still exchanges (`mintSubjectToken`) and refreshes; the offline token is refused |
| Integration | `backup-offline-token.integration.test.ts` (existing) | US2-AC2: grants minted by the login client still mint and revoke |
| Unit | `src/bff-server/unit-tests/backup-consent-client.test.ts` (new) | consent URL client id; fallback when unset; `credentialsFor` picks by `azp`; unreadable token is unusable |
| Guard | `node scripts/check-realm-consistency.mjs` | dev and CI client sets still match |
| E2E (CI) | app-e2e gate tier | SC-003: no exchange failures |

**RED** is the new integration test on unchanged code: the exchange returns 400 after the revoke.
It runs locally against a throwaway Keycloak 26.8.0 (the CI digest), imported from the committed
`ci-realm.json`, plus a throwaway Mongo. Both are created and removed by the session. They are not
the shared dev stacks, which other sessions may be using.

## Risks

- **Prod realm drift**: a deploy before the operator step is safe (US3). The operator step is
  additive (a new client), and reverting means unsetting one env var.
- **Existing prod grants** keep the login client. Revoking one of those still ends that member's
  session once, the last time this can happen to them. Re-granting moves them to the new client.
  This is recorded in the runbook.
