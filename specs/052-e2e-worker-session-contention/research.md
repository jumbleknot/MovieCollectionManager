# Phase 0 research — what the shared E2E identity is actually contended over

**Feature**: 052-e2e-worker-session-contention · **Date**: 2026-08-09

Everything below is either **measured** (from the two CI runs recorded in
[PRD §1](../../docs/proposals/PRD-E2EWorkerSessionContention.md)) or **read from the code in this
working copy**, with the file and line named. Nothing here is inferred from an error string. Where a
claim is a hypothesis it says so in the same sentence.

---

## R1 — The inherited framing, restated exactly

PRD §1.2 gives the mechanism as: *eight parallel Playwright workers share one `E2E_TEST_USER` against
a `MAX_CONCURRENT_SESSIONS` cap of 10, and `session-manager.ts` evicts the oldest session when the cap
is reached; 8 against 10 sits right at the edge.*

PRD §6 Q1 then states, correctly, that **no eviction has ever been observed** — the BFF log showed zero
hits for `evict`, `concurrent` or `session`, and `session-manager.ts` logs nothing when it evicts. So
the mechanism is a reading of the configuration, not a measurement.

This research re-read that configuration. Four of its five components hold. The fifth does not.

## R2 — Confirmed by reading the config (four of five)

| Claim | Verdict | Source |
| --- | --- | --- |
| No `workers` setting → Playwright default (~half the cores) → 8 | **Holds** | [playwright.config.ts](../../frontend/mcm-app/playwright.config.ts) has no `workers` key |
| `fullyParallel: false` serialises within a file, parallelises across files | **Holds** | [playwright.config.ts:22](../../frontend/mcm-app/playwright.config.ts#L22) |
| All workers share one `storageState` | **Holds** | [playwright.config.ts:36](../../frontend/mcm-app/playwright.config.ts#L36) |
| `MAX_CONCURRENT_SESSIONS` defaults to 10; eviction is by oldest `lastActivityAt` | **Holds** | [env.ts:53](../../frontend/mcm-app/src/config/env.ts#L53), [session-manager.ts:115-131](../../frontend/mcm-app/src/bff-server/session-manager.ts#L115-L131) |
| `retries: 1`, whose own comment names an SSO race between parallel workers | **Holds** | [playwright.config.ts:24](../../frontend/mcm-app/playwright.config.ts#L24) |

## R3 — The one that does not hold: eight workers are not eight sessions

`MAX_CONCURRENT_SESSIONS` is a **per-user session count**, and the eight workers do not create eight
sessions. They present the **same** `sessionId` cookie, loaded from the single `storageState` file
global setup writes.

- Every spec inherits that one session except the four that deliberately opt out — `auth.spec.ts` and
  `security-headers.spec.ts` (`test.use({ storageState: { cookies: [], origins: [] } })`),
  `bff-prod-lifecycle.spec.ts` (isolated identity), and `admin-registration.spec.ts` /
  `admin-card.spec.ts` (which mint their own **admin** user via `browser.newContext`). None of those
  adds a session for `E2E_TEST_USER`.
- `auth.spec.ts` drives auth state through its own route mocks and registers throwaway users
  (`pw<ts>@example.com`), so it does not log in as `E2E_TEST_USER` either.
- Refreshing does not mint a session:
  [refresh+api.ts](../../frontend/mcm-app/src/app/bff-api/auth/refresh+api.ts) calls `touchSession`,
  reusing the incoming `sessionId`. It never calls `createSession`.

So `E2E_TEST_USER` holds on the order of **one** session for the entire run, against a cap of 10.

**Consequence**: the concurrent-session cap is very unlikely to be approached, eviction is very
unlikely to fire, and PRD §3.2 (raise the cap for the CI BFF) would be a no-op. That is a *prediction*,
not a result — which is precisely why FR-001 instruments the evict path rather than deleting the
candidate. A cheap counter settles a question that has now been argued twice from config alone.

## R4 — A second candidate that fits the evidence, and is far tighter

There is another per-session resource, and its capacity is 2, not 10.

[rate-limiter.ts:61-66](../../frontend/mcm-app/src/bff-server/rate-limiter.ts#L61-L66):

```ts
refresh: { endpoint: 'refresh', limit: 2, windowSeconds: 30, retryAfterSeconds: 30 },
```

`checkRefreshRateLimit(sessionId)` is keyed on the **session**, and runs *before* the session is even
validated ([refresh+api.ts](../../frontend/mcm-app/src/app/bff-api/auth/refresh+api.ts), immediately
after `extractSessionId`). Eight workers sharing one `sessionId` therefore share one bucket with room
for two requests per 30 seconds.

The refresh cadence is set by the token lifetime, not by the tests:
[ci-realm.json:7](../../infrastructure-as-code/docker/keycloak/ci-realm.json#L7) sets
`accessTokenLifespan: 300` — a **five-minute** access token. And the client-side de-duplication in
[token-refresh.ts:39-42](../../frontend/mcm-app/src/utils/token-refresh.ts#L39-L42) is a module-level
`isRefreshing` flag, so it collapses concurrent refreshes **within one JS context only**. Eight
independent worker browsers de-duplicate eight times, against one server-side bucket.

On rejection, `doRefresh` swallows the 429 and returns `false`
([token-refresh.ts](../../frontend/mcm-app/src/utils/token-refresh.ts)), whose documented contract is
"clear session and redirect to login". The client then shows the login screen; `gotoHome` waits 60 s
for `home-screen-create-button`, never sees it, and prints its guess about the global-setup session.

**This is a hypothesis.** It has not been observed either. It is recorded here because it fits the
constraints PRD §1.1 imposes, which R1's mechanism does not:

| Constraint from PRD §1.1 | Refresh-bucket hypothesis |
| --- | --- |
| a reproducible core **and** a large load-dependent component | a 17.9 min run crosses ~3 five-minute expiry boundaries; a 1.1 h run crosses ~13 |
| appeared only once the agent specs occupied workers for minutes | workers must be alive *across* an expiry boundary to contend; the old skip-in-milliseconds path never was |
| worker-count-dependent | eight contenders for two slots; at two workers the contention is gone by construction |
| the error message names a cause it never tested | a 429-driven login redirect is indistinguishable from a dead session at the selector level |

## R5 — What was considered and rejected

- **Keycloak refresh-token rotation racing across workers.** Rejected on evidence:
  [ci-realm.json:5-6](../../infrastructure-as-code/docker/keycloak/ci-realm.json#L5-L6) sets
  `revokeRefreshToken: false` and `refreshTokenMaxReuse: 0`, so Keycloak does not invalidate the old
  refresh token and stale copies in `storageState` keep working.
- **Session idle timeout expiring the shared session.** Unlikely: `SESSION_IDLE_TIMEOUT_MS` defaults to
  30 minutes ([env.ts:51](../../frontend/mcm-app/src/config/env.ts#L51)) and eight workers touch the
  session continuously. Not excluded, but it would require a >30 min suite-wide stall.
- **Session absolute timeout.** Excluded: 24 hours
  ([env.ts:52](../../frontend/mcm-app/src/config/env.ts#L52)), far beyond the 75-minute job budget.
- **Raising the refresh rate limit for CI.** Rejected on principle, not on evidence: 2-per-30s is an
  anti-abuse control on a production authentication endpoint. Loosening it to suit a test harness
  trades a security property for test convenience, and FR-011 forbids it. If the bucket is the
  mechanism, the test topology changes.

## R6 — Getting the answer back is a design problem, not a logging problem

A counter that only exists on the CI host is not a result. Three independent obstacles:

1. **Collection is failure-gated.** `Collect container logs on failure` runs under `if: failure()`
   ([app-ci.yml](../../.forgejo/workflows/app-ci.yml)), so a *passing* run — which is exactly what
   Story 4 must measure — collects nothing.
2. **The artifact is unreadable from a session.** `agent-e2e-container-logs` is an
   `actions/upload-artifact` upload, and the forge API exposes no artifact endpoint (the premise of
   feature 042). The durable copy at `~/mcm-ci-last-failure` needs host SSH.
3. **The digest is tail-biased.** [ci-failure-digest.mjs](../../scripts/ci-failure-digest.mjs) takes
   tails of at most `DIGEST_MAX_SOURCES = 3` sources; a line early in a multi-thousand-line BFF log
   would be dropped.

**Resolution**: emit the tally through `scripts/ci-log-step.sh`, whose output lands in
`$HOME/mcm-ci-step-logs/$GITHUB_RUN_ID/<name>.log` and is collected as a `step:` source —
[selectSources](../../scripts/ci-failure-digest.mjs) ranks `step:` **0**, above `_ps.txt`, above
unhealthy-container logs, above everything. It is the highest-priority readable channel that exists,
and it is feature 051's own instrumentation carrying feature 052's measurement.

**Trap to avoid in the tally step**: `grep -c` exits **1** when the count is zero. Under
`ci-log-step.sh` (which re-raises the wrapped command's exit code, by design) a zero count would fail
the step and therefore the job — a diagnostic that fails the build when it has good news to report.
The counting must not propagate that status.

**Second trap**: the tally must run **before** `Tear down CI stacks (always)`, which removes the
containers the counts are read from. A step ordered after it would report zeros for a structural
reason and look like a clean result.

## R7 — Measurement locality

A devcontainer reproduction against the local Ollama surface is worth attempting first: it is minutes
rather than 75, costs no Anthropic spend, and R3/R4 are both about BFF internals that do not care which
model answers. But it is **not authoritative**. Worker count follows the host's core count, and agent
latency drives how many expiry boundaries a run crosses — the two variables the hypothesis turns on. A
local null result refutes nothing; a local positive is a strong lead that CI must still confirm.

## R8 — Decision rule for Phase 2

Fixed in advance so the remedy is selected by the number rather than by whichever story is most
appealing after the fact:

| Measurement | Remedy |
| --- | --- |
| `refresh_429 > 0` | Break the shared-`sessionId` coupling: PRD §3.3 (a separate Playwright project with its own identity and `storageState` for `agent-*.spec.ts`). PRD §3.1 (`workers`) may land alongside as the immediate unblock. |
| `session_evicted > 0` | R1's mechanism stands after all; PRD §3.2 becomes live and R3's prediction is recorded as wrong. |
| both `> 0` | §3.3 addresses both, since both are keyed on the shared identity. |
| both `== 0` | Both candidates are **refuted**. Report that plainly, and re-open diagnosis from the Playwright report and `trace: 'on-first-retry'`. Do not substitute a third untested mechanism and ship against it. |
