# Quickstart: Full-Repo Review Remediation — Verification Runbook

All commands run from repo root via Nx (per the Test Run Protocol). RTK must be active (`rtk gain` > 80%). Each finding is delivered test-first: confirm the test is **RED** on current code, implement, confirm **GREEN**, then run the regression gate.

## Prerequisites

```powershell
pnpm nx up-keycloak infrastructure-as-code   # Keycloak + Redis + Mongo (+ rs-init)
pnpm nx up-app infrastructure-as-code         # mc-service (needs Keycloak healthy)
```

## Per-finding verification

| # | Area | Isolated test command | Pass condition |
|---|---|---|---|
| #1 XSS (server) | mc-service | `pnpm nx test mc-service -- external_id` | non-`http(s)` url + empty/duplicate external-id rejected |
| #1 XSS (client) | mcm-app | `pnpm nx test mcm-app -- --testNamePattern "openUrl"` | `javascript:`/`data:` never opened; `https:` opens |
| #3 session TTL | mcm-app integration | `pnpm nx test:integration mcm-app -- --testNamePattern "session TTL"` | Redis TTL ≥ remaining absolute lifetime (asserted on real Redis) |
| #4 rate-limit identity | mcm-app integration | `pnpm nx test:integration mcm-app -- --testNamePattern "rate limit"` | rotating forwarding header still trips limit; no shared bucket |
| #5 createdAt | mc-service integration | `pnpm nx test:integration mc-service -- --test movie_update` | `createdAt` unchanged after edit; `updatedAt` advances |
| #6 set-default atomic | mc-service integration | `pnpm nx test:integration mc-service -- --test set_default` | failed/foreign target leaves prior default intact |
| #7 verify-email | mcm-app integration | `pnpm nx test:integration mcm-app -- --testNamePattern "verify-email"` | invalid/expired/used ⇒ failure; valid ⇒ success |
| #8 register throttle | mcm-app integration | `pnpm nx test:integration mcm-app -- --testNamePattern "register rate"` | unique-email spam from one source ⇒ 429 |
| #9 session auth | mcm-app integration | `pnpm nx test:integration mcm-app -- --testNamePattern "unauthenticated session"` | victim sessions untouched; self-logout works |
| #10 id validation | mcm-app | `pnpm nx test mcm-app -- --testNamePattern "identifier validation"` | malformed id ⇒ 400 at edge, no upstream call |

### Hardening batch (US6)

| Item | Command | Pass condition |
|---|---|---|
| Eviction cap (FR-018) | `pnpm nx test:integration mcm-app -- --testNamePattern "concurrent session"` | count never exceeds max under concurrent logins |
| Cursor 400 (FR-019) | `pnpm nx test mc-service -- list_movies_cursor` | malformed cursor ⇒ 400 (not page-1 restart) |
| Password score (FR-020) | `pnpm nx test mcm-app -- --testNamePattern "evaluatePassword"` | all-criteria password ⇒ score ≤ 4 |
| Parse safety (FR-021) | `pnpm nx test:integration mcm-app -- --testNamePattern "corrupt session"` | corrupt value ⇒ treated as no session |
| Required fields (FR-022) | `pnpm nx test mc-service -- required_fields` | empty title/language rejected |

## Regression gate (final validation — FR-024)

```powershell
pnpm nx test mc-service
pnpm nx test:integration mc-service
pnpm nx test mcm-app
pnpm nx test:integration mcm-app
pnpm nx lint mcm-app
pnpm nx e2e mcm-app
pnpm nx e2e:mobile mcm-app
rtk gain   # confirm > 80% compression
```

Affected user-story E2E suites for iterative runs (per Feature Branch Test Scope): `auth.spec.ts` (US2/US3 session, US3 abuse), `movies.spec.ts` (#1 external-id links, #5 createdAt, #10 id validation), `collections.spec.ts` (#6 default), `session-timeout.spec.ts` (#3). Mirror each web scenario in the corresponding Maestro flow (Platform Parity Table in tasks.md).
