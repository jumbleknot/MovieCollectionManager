# Tasks: Revoking backup consent must not end the user's sign-in session

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

**Tests**: Mandatory (TDD), per `docs/templates/feature-test-tasks-template.md`.

## Path Conventions

- BFF source: `frontend/mcm-app/src/bff-server/`, `frontend/mcm-app/src/config/env.ts`
- Integration: `frontend/mcm-app/tests/integration/`
- Realms: `infrastructure-as-code/docker/keycloak/{dev,ci,prod}-realm.json`

### Running the integration tier locally against throwaway services

The shared dev stacks may belong to another session, so this feature runs against its own
containers: a Keycloak 26.8.0 at the CI digest with `ci-realm.json` copied into
`/opt/keycloak/data/import/grumpyrobot-realm.json` (a bind mount is not visible to this
sandbox's daemon), and a `mongo` on a spare port. Point the tier at them with environment
variables. Every value set in the shell wins over the `.env*` loaders.

```bash
KEYCLOAK_URL=http://127.0.0.1:18099 KEYCLOAK_CLIENT_SECRET=… KEYCLOAK_SERVICE_CLIENT_SECRET=… \
AGENT_SUBJECT_TOKEN_CLIENT_SECRET=… E2E_TEST_PASSWORD=… MONGO_URL=mongodb://127.0.0.1:27119 \
BACKUP_CREDENTIAL_ENC_KEY=… BACKUP_CONSENT_CLIENT_ID=mcm-backup-consent MCM_REQUIRE_LIVE_STACK=1 \
  npx jest --config jest.integration.config.js tests/integration/backup-consent-session
```

Read the skip count: a skipped suite reads as a pass.

---

## Phase 1: User Story 1, US2-AC1 — the session survives a revoke (P1)

### T001 — Pin the defect against a live Keycloak

**Type**: Test | **Spec reference**: US1-AC1..3, US2-AC1, SC-001

**File(s)**: `tests/integration/helpers/offline-token-flow.ts`,
`tests/integration/backup-consent-session.integration.test.ts`

Add `browserLogin()` (the authorization-code login as the browser does it, which returns its cookie
jar and tokens) and `followAuthorize(jar, url)` (an SSO hop that returns the code) to the helper.
The new test signs a fresh user in, runs `buildConsentRequest` and `completeConsent` in the SAME jar,
revokes with `revokeOfflineToken`, then asserts all of these:

- `mintSubjectToken(online access token)` resolves;
- the online refresh token still refreshes;
- the captured offline token is refused by Keycloak;
- before the revoke, a token minted with `mintUserAccessToken` has `sub` = the user and `aud` that
  contains `movie-collection-manager`.

**Verify RED** (unchanged source; the realm has no dedicated client yet, so leave
`BACKUP_CONSENT_CLIENT_ID` unset):
**Expected RED**: `mintSubjectToken` rejects (`subject-token exchange failed (HTTP 400)`).

### T002 — Dedicated client in the realms

**Type**: Config | **Spec reference**: FR-004

**File(s)**: `dev-realm.json`, `ci-realm.json`, `prod-realm.json`, `scripts/export-ci-realm.mjs`

**Verify**: `node scripts/check-realm-consistency.mjs` passes, and so does `--selftest`.

### T003 — Consent, mint and revoke use the right client

**Type**: Implementation | **Spec reference**: FR-001..003, US2-AC2, US3

**File(s)**: `src/config/env.ts`, `src/bff-server/backup-offline-token.ts`,
`src/bff-server/keycloak.ts`, `src/app/bff-api/auth/init+api.ts`,
`src/bff-server/unit-tests/backup-consent-client.test.ts` (new)

Write the unit test first: client id in the consent URL; fallback when unset; `credentialsFor` by
`azp`; an unreadable token is unusable. Watch it fail, then implement.

**Verify GREEN**: the unit test passes. T001 passes with `BACKUP_CONSENT_CLIENT_ID=mcm-backup-consent`
against a Keycloak re-imported from the new `ci-realm.json`. `backup-offline-token`,
`backup-consent-routes`, `backup-consent-redirect-uri` and `backup-account-deletion` integration
suites pass with 0 skipped.

### T004 — CI runs the fixed path

**Type**: Config | **Spec reference**: FR-005

**File(s)**: `scripts/gen-ci-env.mjs`. `gen-dev-env.mjs` is deliberately left alone: dev is opt-in,
see plan §5.

**Verify**: run the generator with dummy secrets and read `BACKUP_CONSENT_CLIENT_ID` in the output.
Then delete the generated files.

## Phase 2: Polish

### T005 — Operator runbook and docs

**File(s)**: `docs/runbooks/backups.md`, `infrastructure-as-code/docker/bff/.env.prod.example`.
Cover why consent has its own client, the enable steps (the `kcadm.sh` block, then
`BACKUP_CONSENT_CLIENT_ID`), and what happens to existing grants.

**Verify**: run the `kcadm.sh` block twice against a Keycloak whose realm lacks the client. Expect
`created` the first time and `already present` the second. Then T001 passes against that realm
once `/auth/init`'s registration has run (the redirect-URI suite).

### T006 — Lint, unit suite, typecheck

```bash
pnpm nx lint mcm-app && pnpm nx test mcm-app
```

### T007 — CI

Open the PR and watch app-e2e. **SC-003**: grep the run's BFF log for `Agent subject-token exchange
failed`; expected 0. Record the result on #702.
