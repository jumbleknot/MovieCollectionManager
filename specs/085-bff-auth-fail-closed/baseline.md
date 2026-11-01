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
