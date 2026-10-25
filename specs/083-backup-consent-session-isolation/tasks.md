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

### T008 — Production enablement as config-as-code (item #843, added 2026-10-25)

**File(s)**: `infrastructure-as-code/komodo/stacks.toml` (stack `prod-mcm-bff`), `docs/runbooks/backups.md`.

prod-mcm-bff's environment is owned by `stacks.toml` (ResourceSync), so a value typed into the Komodo
UI is overwritten by the next sync. Add `BACKUP_CONSENT_CLIENT_ID=mcm-backup-consent` (literal, not a
secret) and `BACKUP_CONSENT_CLIENT_SECRET=[[mcm_backup_consent_client_secret]]` (masked Komodo Variable,
ADR-0001).

The production realm's admins have 2FA, which `kcadm.sh`'s password login cannot satisfy
(`Invalid user credentials`; the bootstrap admin is retired per the server-setup runbook). So the client is
created in the admin console. The console cannot copy the login client's secret, so the new client keeps
its own, which is what `BACKUP_CONSENT_CLIENT_SECRET` exists for. The runbook gains the console path.

**Order**: the operator creates the client and the Variable BEFORE this merges. The merge deploys the
BFF with both values.

**Verify** (no RED: nothing becomes required): `node --test scripts/__tests__/komodo-stack-env.guard.test.mjs` stays green before and
after: both values are optional (`env.ts` falls back to the login client), so no `${VAR:?}` guard applies.
The real check is on the host after the deploy: `printenv` shows `id=mcm-backup-consent`, the secret length
is non-zero, and `backup_consent_shared_client` is logged 0 times. Then the #843 sign-in survival test.

### T009 — Turn scheduled backups on in production (item #843, added 2026-10-25)

**File(s)**: `infrastructure-as-code/komodo/stacks.toml` (stack `prod-mcm-bff`),
`infrastructure-as-code/docker/bff/.env.prod.example`, `docs/runbooks/backups.md`.

The #843 sign-in survival test could not run: saving a destination in prod failed with "That address
is not allowed". Feature 073 had never been enabled in production — prod-mcm-bff set none of
`BACKUP_CREDENTIAL_ENC_KEY`, `BACKUP_TICK_SECRET` or `BACKUP_ALLOWED_DESTINATION_HOSTS`, so every
private destination was refused, no destination secret could be sealed, and the boot log read
`backup scheduler disabled (BACKUP_TICK_SECRET is not set)`. Add all three: the two keys as masked
Komodo Variables (`mcm_backup_credential_enc_key`, `mcm_backup_tick_secret`; ADR-0001), the allow-list
as the plain Variable `mcm_backup_allowed_destination_hosts` holding the operator's LAN WebDAV NAS (exact
host match) — a LAN address is topology, which stays out of git. `BACKUP_TICK_ALLOW_TIME_OVERRIDE` stays
unset: it is dev/CI only.

**Order**: the operator creates all three Variables BEFORE this merges, then checks the sync and redeploys.

**Verify** (no RED: nothing becomes required): `node --test scripts/__tests__/komodo-stack-env.guard.test.mjs`
stays green before and after, because all three are optional in `env.ts`. The real check is on the host
after the redeploy: the boot log no longer says `backup scheduler disabled`, the enc key decodes to 32
bytes, the allow-list is non-empty, and a destination on the NAS saves and tests OK.
Then T008's sign-in survival test.

### T010 — The BFF must see the public scheme behind the TLS-terminating proxy (item #843, added 2026-10-25)

**File(s)**: `frontend/mcm-app/server.js`, `frontend/mcm-app/tests/unit/bff-server-trust-proxy.test.ts`,
`frontend/mcm-app/tests/unit/fixtures/expo-adapter-stub.cjs`.

Measured in production after T009: enabling a schedule sent the browser to Keycloak with
`redirect_uri=http%3A%2F%2Fmcm.grumpyrobot.co%2Fbff-api%2Fbackups%2Fconsent` and Keycloak refused it
("Invalid parameter: redirect_uri") — the client registers the `https://` URI. Cloudflare terminates
TLS and `cloudflared` reaches the BFF over plain HTTP; `@expo/server`'s express adapter builds every
request URL as `` `${req.protocol}://${req.get('host')}${req.url}` ``, and `server.js` never enabled
express's `trust proxy`, so `req.protocol` ignored `X-Forwarded-Proto` and read `http`. Every route
that derives a callback from `new URL(req.url).origin` is affected: the backup consent route and the
account-deletion re-authentication route (feature 076). CI and dev never saw it: there the BFF serves
HTTPS itself on `:8443`.

Fix: when `TRUSTED_PROXY=true` (already set in prod for the same proxy), `app.set('trust proxy', 1)` —
trust exactly the immediate hop. The host stays the raw `Host` header (the adapter reads
`req.get('host')`, which `trust proxy` does not change), so `X-Forwarded-Host` cannot move the origin.
Without `TRUSTED_PROXY` nothing changes, so a directly exposed BFF cannot be talked into `https` by a
client-supplied header.

**Verify RED** (measured: 2 failed, 2 passed): `bff-server-trust-proxy.test.ts` fails on `TRUSTED_PROXY=true` + `X-Forwarded-Proto: https`
→ origin `http://…` (expected `https://…`), with and without `X-Forwarded-Host`. The two that keep `http` pass already.
**Verify GREEN**: all cases pass, and `bff-server-adapter.test.ts` stays green. After the deploy, enabling a
schedule in prod reaches the Keycloak consent screen, then T008's sign-in survival test.

### T011 — Switching scheduled backups off must clear the schedule and give the permission up (item #843, added 2026-10-25)

**File(s)**: `frontend/mcm-app/src/screens/settings/backups-settings-screen.tsx`,
`frontend/mcm-app/src/hooks/use-backup-jobs.ts`, `frontend/mcm-app/src/app/bff-api/backups/jobs/[jobId]/index+api.ts`,
`frontend/mcm-app/src/app/bff-api/backups/consent+api.ts`, `frontend/mcm-app/src/bff-server/backup-job-store.ts`,
`frontend/mcm-app/src/bff-server/unit-tests/backup-schedule-off-routes.test.ts`,
`frontend/mcm-app/src/screens/settings/backups-settings-screen.test.tsx`.

Measured in production after T010, three defects against feature 073 FR-023/SC-012:

1. **The switch never turned off.** The screen sent `{ schedule: schedule ?? undefined }`; JSON drops an
   `undefined` field, so the PATCH body was `{}`, which the route reads as "leave the schedule alone".
   Only an explicit `schedule: null` clears it. Fix: send the value through unchanged, and type the
   hook's patch so `null` is expressible.
2. **Nothing revoked on disable or delete.** FR-023 requires disabling a schedule or deleting the job to
   revoke the standing permission at the identity provider. `revokeIfNoScheduleRemains` existed and was
   integration-tested, but no route called it — the screen's comment "the server decides" described
   code that did not exist. Fix: PATCH (schedule cleared or job disabled) and job DELETE call it after
   the store change; an identity-provider refusal answers 502, as the consent DELETE already does.
3. **"Withdraw permission" left the schedules on**, so the screen said "Scheduled backups are switched
   off" over a switch reading On, and the next due run would fail (fail-closed, FR-024, but every
   night). Fix: after a SUCCESSFUL revocation, clear every schedule the user has. A refused revocation
   keeps them, so nothing is claimed that did not happen.

**Verify RED**: `backup-schedule-off-routes.test.ts` fails on the PATCH-null, PATCH-disable, PATCH-502,
job-DELETE and withdraw-clears cases; the screen test fails with the PATCH body `{}`.
**Verify GREEN**: both pass, the mcm-app unit suite and lint stay green. After the deploy, in prod: turning
the switch off leaves it Off after a reload, logs `backup_schedule_disabled` then
`backup_schedule_consent_revoked`, and the next-run line disappears.
