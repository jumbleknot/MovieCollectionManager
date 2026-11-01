# Quickstart: validating 085

Run from the repository root, inside a worktree that has had its own `CI=true pnpm install
--frozen-lockfile` (CLAUDE.md, the worktree gate). Run heavy steps one at a time: `df -h /`
first, then `--parallel=1` and Jest `--maxWorkers=2`.

## Fast tier (no stack)

```bash
pnpm nx lint mcm-app
pnpm nx typecheck mcm-app
pnpm nx test mcm-app -- --maxWorkers=2
```

**Expect** 0 failures and 0 skips added. The unit suites that prove each FR are the ones named in
`tasks.md`.

## Integration tier (real Keycloak, Redis, mc-service, and the BFF container on :8082)

```bash
node scripts/gen-dev-env.mjs                      # supplies .env.local / .env.e2e.local if absent
pnpm nx docker-build mcm-app && pnpm nx docker-up mcm-app
MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app
```

**Expect** 0 skipped: `MCM_REQUIRE_LIVE_STACK=1` turns a missing dependency into a failure. Then:

```bash
grep -lE "Authorization: \`Bearer" frontend/mcm-app/tests/integration/*.test.ts | wc -l
```

**Expect** `0` (SC-010).

## Scenario checks (each is also an automated test; listed here so a reviewer can run one by hand)

| Check | How | Expect |
|---|---|---|
| A bearer alone is refused (US3) | `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(ropc token)" :8082/bff-api/collections` | `401` |
| No token cookie is ever set (SC-007) | log in through `helpers/bff-session.ts`, then inspect `set-cookie` on login, refresh and logout | only `mcm_session_id` is set; the retired names appear only with `Max-Age=0` |
| A Redis dump shows no readable token (SC-008) | `redis-cli -n 1 --scan --pattern 'session*' \| xargs -n1 redis-cli -n 1 get \| grep -cE 'eyJ[A-Za-z0-9_-]{10,}\.'` | `0` |
| Concurrent renewal happens once (US6 AS-5) | integration test `session-token-renewal.integration.test.ts` | one Keycloak refresh, both requests `200` |
| Absolute expiry is labelled correctly (SC-006) | integration test with `SESSION_ABSOLUTE_TIMEOUT_MS` shortened | `SESSION_ABSOLUTE_TIMEOUT` plus audit `reason: absolute` |

## E2E (web)

```bash
E2E_REQUIRE_AGENT_STACK=1 E2E_TIER=gate pnpm nx e2e:agents mcm-app     # gate tier, a skip fails
```

Run in Playwright's official image (`docs/runbooks/e2e-testing.md`). `bff-prod-lifecycle.spec.ts`
asserts:
- the only auth cookie is `mcm_session_id`;
- a server-side renewal after the access token's lifetime needs no added sign-in (SC-009);
- logout makes the session reference refuse (`401`).

## Android (PR (b) only)

Run the sign-in, assistant-turn and sign-out Maestro flows per
`openwiki/runbooks/android-emulator.md`: CI for the agent flows, the local emulator for the rest.
Afterwards, the cookie jar holds only `mcm_session_id`, which the flow's cookie dump step shows.

## SC-002 (post-merge, not runnable at merge time)

Count `No caller identity is available` in the gate-tier digests of the first 10 `main` runs after
PR (a) merges. **Expect** 0. The baseline is 4 occurrences in 3 days (runs 5618, 5748, 5757,
5820).
