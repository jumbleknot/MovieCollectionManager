# Baselines and evidence (085)

Measured 2026-11-01 on `origin/main` `ebf11f23`.

| What | Value | Command |
|---|---|---|
| Integration files that send a bearer to the BFF | **25** | `grep -lE "Authorization: \`Bearer" frontend/mcm-app/tests/integration/*.test.ts \| wc -l` |
| Source files using `extractRawToken` | **13** | `grep -rln "extractRawToken" frontend/mcm-app/src \| wc -l` |
| `TRUSTED_PROXY` on the integration/dev BFF (:8082) | **unset**, so `extractClientIp` returns `null` and the login rate limit is skipped (research R2, first branch). It is set to `true` only in `infrastructure-as-code/docker/bff/compose.prod.yaml:45`. | `grep -n TRUSTED_PROXY .forgejo/workflows/*.yml infrastructure-as-code/docker/bff/*.yaml` |
| SC-002 baseline: the "No caller identity is available" signature in gate-tier E2E | **≥ 4 in 3 days**: runs 5618 (main), 5748, 5757, 5820 | item #844 / #702 history |

## Evidence log

The task outputs are appended below as each task completes.

### T010: Keycloak's real token-exchange answer (2026-11-01)

- **What Keycloak returns.** Ending a member's Keycloak sessions (Admin `POST /users/{id}/logout`)
  and then exchanging their still signature-valid access token gives **`400`, `error:
  invalid_request`, `error_description: "Invalid token"`**. A malformed token gives the same
  answer.
- **Classifier gap.** The RFC-based classifier (`invalid_token`/`invalid_grant`) called this
  transient. The integration test went RED against the new code, so it caught the gap. The
  classifier now includes the measured pair.
- **RED against `origin/main`'s mint:** the test fails with `Expected constructor:
  AgentIdentityError / Received constructor: AuthError`: 1 failed, 2 passed, 0 skipped.
- **GREEN:** 3 passed, 0 skipped.

### Unit REDs for PR (a) (before implementation)

- **Test REDs:** 27 failed across 6 suites, every one a new case. The cases that pin existing
  behaviour passed: the unconfigured-exchange run and the same-member refresh.
- **Mutation REDs:**

  | Area | Mutation | Result |
  |---|---|---|
  | `mc-api-error` (T004) | header append reverted | 2 failed |
  | redirect registration (T016) | `updateRes.ok` check removed | 3 failed |
  | session reason (T018) | idle checked before absolute | 1 failed |
  | agent-fetch-refresh (C4) | 503 also refreshes | 1 failed |

- **GREEN:** full unit suite, 161 suites / 1678 tests passed.

### T020: integration suite, PR (a), local (2026-11-01)

| BFF image | Suites | Tests |
|---|---|---|
| New (`085a`) | 54/59 passed, 5 failed | 383 passed, **25 failed, 1 skipped** |
| Pre-change (`pre085`, built 2026-10-19) | the same 5 backup suites fail | the **same 25** fail |

The local failures predate this diff and come from the local environment:

- `backup-consent-session` fails because `BACKUP_CONSENT_CLIENT_ID` is empty in the local
  `.env.docker`/`.env.local`. CI's `gen-ci-env.mjs` sets `mcm-backup-consent`. With consent on the
  login client, revoking it ends the session: the #702 behaviour.
- The other four backup suites end with `backup_run_failed` / `auth_failed` on this realm.

CI's `app-e2e` runs this suite against the CI realm and is the authoritative result for those five
suites.

Five tests pass locally by returning early, so they report green without running:

- the gateway is not host-published locally;
- OpenSearch is down (2 tests);
- Ollama is unreachable (2 tests).

None of them covers code this diff changes. They run in CI's `app-e2e`, which has the full stack.

### T011: what a member sees for a refused turn

- **Before:** nothing. CopilotKit reports a failed `/run` through `onError`, never as a rejected
  promise, and the dock rendered no errors.
- **Now:** `useAssistantRunFailureNotice` shows an assistant-side bubble, testID
  `assistant-run-failure`, chosen by the BFF error `code` in the response body:
  - "The assistant is temporarily unavailable. Please try again." for a 503;
  - "Your session has expired. Please sign in again." for a 401.
- **Unit test:** `src/components/agent/assistant-run-failure.test.ts`, RED (module missing), then
  GREEN.

## PR (b): US3, US6, FR-023

### Unit
- **REDs first**:
  - `auth.test` and `session-tokens.test` could not load (the module did not exist);
  - `cache-service` had 6 new failures;
  - `keycloak` refresh classification had 5 failures;
  - `session-manager` had 5 failures;
  - the login and refresh routes had 11 failures;
  - the logout route had 3 failures.
- **GREEN**: full suite 162 suites / 1730 tests; typecheck clean; lint 0 errors.
- **Guards updated at the cause:**
  - `cache-service` `deleteSession` now asserts that BOTH keys are deleted.
  - `auth-session-side-effects` (009 #9) now asserts the new premise. The session id is the credential and is read from the cookie only, so a victim's id in an `X-Session-Id` header changes nothing.

### Integration (real Keycloak + Redis + mc-service + BFF `085b`)
- **REDs on the PR (a) image:**
  - `bff-bearer-refused`: the bearer-only routes answered `200`. Member B's bearer **overrode** member A's session cookie (`Expected: <A's id>`, `Received: <B's id>`). That is the US3 defect.
  - `session-token-custody`: every case failed (token cookies set, JWTs readable in the store).
- **GREEN on `085b`:**
  - 55 of 61 suites passed, 394 tests. The 25 failures are the SAME 25, by name, in the SAME 5 backup suites as the pre-change baseline (local `BACKUP_CONSENT_CLIENT_ID` is empty).
  - 1 skipped, identical to the pre-change run.
  - `backup-audit` was fixed by `inProcessSessionCookie`.
- **SC-010:** no integration test sends a bearer to the BFF. The one remaining `Authorization: Bearer` (`backup-consent-redirect-uri`) is the Keycloak **Admin API**. In-process mc-service calls keep a real access token, which is a bearer to mc-service, not the BFF.

### Web E2E (Playwright official image v1.63.0, dev container :8082)

| Spec | PR (a) image (`085a`) | PR (b) image (`085b`) |
|---|---|---|
| `agent-session-refresh` (`@gate`) | RED: `mcm_access_token must not be held` | 1 passed |
| `bff-prod-lifecycle` (`lifecycle`, `--no-deps`) | RED: `mcm_access_token must not be held by the client` | 1 passed |

### Scripts
`node --test scripts/__tests__/*.test.mjs` passes 1948 of 1948, 0 skipped. That covers the DAST helpers and the redaction fixtures.

### Android
This sandbox has no `/dev/kvm`. Per `openwiki/runbooks/android-emulator.md`, the flows run in CI's `app-e2e` on the KVM host, and PR (b) carries the `mobile-e2e-full` label so the sign-in and sign-out flows run as well as the agent flows.

### Follow-ups filed
- **#905:** a dedicated `SESSION_TOKEN_ENC_KEY`.
- **#906:** drop the retired-cookie clears 24 h after deploy.
