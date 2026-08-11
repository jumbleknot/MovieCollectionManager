# Implementation Plan: `app-e2e` reliability cluster

**Branch**: `054-app-e2e-reliability-cluster` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/054-app-e2e-reliability-cluster/spec.md`

## Summary

Six backlog items filed by three sessions, sequenced by **what makes the next verdict trustworthy** rather
than by priority label. Fix the two tools that report something untrue about a run (US1, US2), make a
collapsed run label itself and leave client-side evidence (US3), then make the two changes whose effect has
to be judged against that background — per-worker identity (US4) and the queued-turn fix (US5) — and finally
restore a valid local signal (US6). #173's mechanism and its fix are **evidence-gated**, not scheduled: they
open when a collapse is caught with US3's capture.

The ordering argument in one sentence: **every run US4, US5 and US6 dispatch is a sampling opportunity for
the collapse once US3 has landed**, so diagnosing #173 in series ahead of them would throw those runs away.

## Technical Context

| | |
| --- | --- |
| **Languages** | Node ESM (`scripts/*.mjs`), TypeScript (Playwright harness + React 19 / RN Web), Bash (CI steps), JSON (Keycloak realm exports), YAML (Forgejo Actions) |
| **Primary surfaces** | `scripts/ci-status.mjs`, `scripts/ci-failure-digest.mjs`, `.forgejo/workflows/app-ci.yml`, `frontend/mcm-app/tests/e2e/web/{setup,fixtures}/`, `frontend/mcm-app/playwright.config.ts`, `frontend/mcm-app/src/hooks/use-assistant.tsx`, `infrastructure-as-code/docker/keycloak/dev-realm.json` |
| **Test tiers** | `node --test scripts/__tests__/*.test.mjs` (tooling), `pnpm nx test mcm-app` (Jest unit), `pnpm nx e2e mcm-app` (Playwright), `app-ci / app-e2e` (the gate) |
| **CI shape** | Single capacity-1 runner; `app-e2e` ~35 min against `timeout-minutes: 75`; ~100 live Anthropic calls per run |
| **Verification transport** | `workflow_dispatch` — `guardrails` and `app-ci` scope `push:` to `main` |
| **Branch base** | `main`. Verified: `E2E_AGENT_PRODUCTION` forwarding is present at [app-ci.yml:656](../../.forgejo/workflows/app-ci.yml#L656), so unlike feature 052 this **is** verifiable from `main` — the agent specs execute here. |

## Constitution Check

*GATE: passes before Phase 0. Re-check after each story.*

| Principle | Bearing on this feature | Verdict |
| --- | --- | --- |
| **Adherence / No Vibe Coding** | Every remedy below is chosen by a measured number or an explicitly stated assumption; the two that are not yet measured (US3's thresholds, US4's cost) are tasks that *produce* the number before the choice is fixed. | Pass |
| **Behavior-Descriptive Identifiers** | New symbols name behaviour (`collapseToNewestPerContext` in `ci-status.mjs`, the `classify_run_verdict` shell function in `e2e-turn-tally.sh`, `authFileForWorker`), never `FR-###`. Requirement IDs appear only in provenance comments. | Pass |
| **Documentation** | `docs/runbooks/e2e-testing.md`, `docs/runbooks/ci-diagnostics.md` and `openwiki/invariants/feature-validation-checklist.md` are updated as part of the work, not after. | Pass |
| **Secrets Management / never log credentials** | US3 captures browser console and request records. FR-011 forbids credential material; the capture redacts `Cookie`, `Authorization` and `Set-Cookie` and does not record request bodies. | Pass — pinned by a test |
| **No production security control weakened for the harness** | The refresh rate limit (2/30 s) and `MAX_CONCURRENT_SESSIONS` stay as they are. US4 changes the **test topology** (per-worker users), not the control. US6 changes a **dev-only realm's** token lifespan, not a production one. **Verified against the diff, not asserted from intent** — T043 checks it. | Pass (FR-026) |
| **Application-Managed User Registration / No Local Credential Stores** | US4 mints per-worker users through the Keycloak Admin API with the existing service account, exactly as `admin-registration.spec.ts` already does. No credential is stored by the application. | Pass |
| **Testing tiers / a skip reads as a pass** | FR-017 forbids skipping, deselecting, narrowing or gating any spec to reach a result. Every claim is judged by counts. | Pass |

## Project Structure

### Documentation (this feature)

```text
specs/054-app-e2e-reliability-cluster/
├── spec.md         # what and why
├── plan.md         # this file
├── tasks.md        # the decomposition
└── contracts/
    └── run-health-signal.md   # the [e2e-turns] line and its thresholds (US3)
```

### Source Code (repository root)

```text
scripts/
├── ci-status.mjs                     # US1 — newest-per-context collapse
├── ci-failure-digest.mjs             # US2 — counts-mode publication on a green run
├── e2e-contention-tally.sh           # US3 — the proven pattern the turn tally mirrors
├── e2e-turn-tally.sh                 # US3 — NEW: the run-health signal
└── __tests__/
    ├── ci-status.test.mjs            # US1
    ├── ci-failure-digest.test.mjs    # US2
    └── e2e-turn-tally.test.mjs       # US3 — NEW

.forgejo/workflows/app-ci.yml         # US2 (counts step), US3 (turn tally step)

frontend/mcm-app/
├── playwright.config.ts              # US4 — worker bound re-evaluated
├── src/hooks/use-assistant.tsx       # US5
└── tests/e2e/web/
    ├── fixtures/
    │   ├── worker-session.ts         # US3 (evidence fixture), US4 (per-user storageState)
    │   └── client-evidence.ts        # US3 — NEW
    └── setup/
        ├── global-setup.ts           # US4 — mint + seed N identities
        ├── auth-files.ts             # US4 — per-worker auth file naming
        ├── keycloak-admin.ts         # US4 — user minting (exists)
        ├── agent-config-seed.ts      # US4 — per-user seeding
        └── e2e-cleanup.ts            # US4 — teardown becomes worker-scoped and safe

infrastructure-as-code/docker/keycloak/dev-realm.json   # US6
docs/runbooks/e2e-testing.md                            # US3, US6
docs/runbooks/ci-diagnostics.md                         # US1, US2
openwiki/invariants/feature-validation-checklist.md     # US6
```

---

## US1 — Newest status per context wins

`computeMergeVerdict` maps over `selectEventContexts(...)` with no per-context collapse
([ci-status.mjs:356-372](../../scripts/ci-status.mjs#L356-L372)). A context accumulates one status per state
transition, so a job that failed and was re-run successfully on the same event leaves both, and the stale
`failure` lands in `blocking`.

**Approach**: insert a `collapseToNewestPerContext(statuses)` step between `selectEventContexts` and the
`.map`, keyed on the **full context string** (`s.context`), ordered by `created_at` with the original array
index as a stable tiebreak for equal timestamps.

Keying on the full string — not on `parseContext(s).job` — is load-bearing twice over: it keeps
`foo (push)` and `foo (pull_request)` distinct (FR-004), and it keeps an unsuffixed `foo` distinct from a
suffixed one, which `selectEventContexts` deliberately admits together.

**Not doing**: "any success passes". FR-002 requires a newer `failure` after an older `success` to resolve to
`failed`, which is the dangerous direction and the one an `.some(s => s.state === 'success')` shortcut gets
wrong.

**Verification**: unit only. RED first in `scripts/__tests__/ci-status.test.mjs`, using the reproduction
already written into item #176. No CI run is needed, and — per the spec's Edge Cases — none would show it,
because a dispatched run posts no commit status at all.

---

## US2 — A green run publishes its counts

[`shouldPublish`](../../scripts/ci-failure-digest.mjs#L214) is the single gate: it returns
`{publish: false}` for any `jobStatus !== 'failure'`, which is why a green run leaves no bundle.

**Approach**: make the gate three-way rather than binary.

| `runStatus` / `jobStatus` | Mode | What is published |
| --- | --- | --- |
| `cancelled` | none | nothing — a superseded run must not publish a failure for a commit that was never broken (unchanged) |
| `failure` | `digest` | today's full behaviour: evidence bundle + PR comment (unchanged) |
| anything else | `counts` | a **small** bundle version carrying only the `step:` sources named below; **no** PR comment |

`counts` mode collects only `e2e-result-gate` and the two tally steps, so it publishes at most a few
kilobytes. It is **self-limiting to the jobs that have counts**: if neither step log exists — every job other
than `app-e2e` — the mode emits its outcome line and returns without publishing. That is deliberately not a
job allowlist, which would be a second place to forget to update.

**Why not the commit-status channel** the backlog suggested: `createStatus`
([ci-failure-digest.mjs:863](../../scripts/ci-failure-digest.mjs#L863)) hardcodes `state: 'failure'` and is
reached **only** on the degraded path, when `CI_DIGEST_TOKEN` is empty. Using it for a green run means both a
state parameter and a new call site — and it is capped at `STATUS_DESCRIPTION_MAX` characters, which the two
tally lines do not fit. The bundle path already carries the sources *and* already prunes
(`selectExpiredVersions`, `RETENTION_DAYS`), which is #167's fourth acceptance criterion for free (FR-008).

`bundleVersion(runId, job)` is reused unchanged: a job is either green or red for a run, so a counts bundle
and a digest bundle can never collide on a name, and retention prunes both by the same rule.

**FR-007 (never fail the job it measures)**: the existing step already carries `if: always()`,
`continue-on-error: true` and an unconditional `exit 0`. Counts mode inherits all three. A task explicitly
verifies that a *thrown* error inside counts mode still exits 0.

---

## US3 — A collapsed run says so, and leaves client-side evidence

Two independent parts. Either is useful without the other; both are needed for SC-003 and SC-004.

### (a) The run-health signal — `scripts/e2e-turn-tally.sh`

Mirrors `e2e-contention-tally.sh` exactly, for the same reasons and with the same traps already solved
there: run under `ci-log-step.sh` so the output lands as a `step:` source (ranked 0 by the digest); run
**before** `Tear down CI stacks`, or the container it reads is gone and every count reads zero for a
structural reason; and **always exit 0**, because `grep -c` exits 1 on a zero count and a diagnostic must
never fail the job it diagnoses.

It emits one line:

```text
[e2e-turns] gateway_posts=<n> agent_specs_executed=<m> posts_per_spec=<r> verdict=healthy|collapsed|indeterminate
```

**Normalised, deliberately.** The raw discriminator measured in #173 is a whole-run count — healthy 155–169
gateway POSTs / 99–114 Anthropic calls, collapsed 39–56 / 24–34. A bare threshold on that number silently
becomes wrong the first time a spec is added or the mobile half is skipped. Dividing by the executed agent
spec count (which `e2e-failure-set.mjs` already parses) keeps the signal meaningful as the suite changes.

**It labels; it does not gate.** A collapsed run already fails on its test failures, so failing it a second
time adds nothing and buys a new false-failure mode. `indeterminate` is emitted whenever the gateway log is
unreadable or the executed count is zero — the same `0`-vs-`unavailable` distinction the contention tally
already makes, and for the same reason: an absent measurement must not read as a good one.

**The thresholds are calibrated on five runs and are stated as heuristic** in
`contracts/run-health-signal.md`, with the measured values that set them. They are a triage aid, not a
proof, and the contract file says so in those words.

### (b) Client-side evidence — `fixtures/client-evidence.ts`

Nothing captures the browser today: the only `page.on(...)` under `tests/e2e/web/` is a `'response'`
listener in `perf.spec.ts:37`. #173 has exhausted every server-side channel, so this is the missing one.

An auto-fixture composed into the `test` object exported by
[worker-session.ts](../../frontend/mcm-app/tests/e2e/web/fixtures/worker-session.ts) attaches `console`,
`pageerror` and `requestfailed` listeners plus a record of requests to the BFF agent routes, buffered in
memory in a ring holding the **last 500 entries per test**, and written out **only when the test did not
reach its expected status** (FR-012 — the instrument must not become the perturbation). Output lands in the
directory the `failure()` collect step already sweeps into the bundle.

**On overflow the oldest entries are dropped and the written file records how many were lost**, so a
truncated capture never reads as a complete one. 500 is chosen against the measured traffic: a healthy run
drives ~155 turns across the *whole suite*, so one spec never approaches it, while a runaway console loop
still cannot exhaust memory.

**Redaction (FR-011)**: `Cookie`, `Set-Cookie` and `Authorization` headers are dropped and request bodies are
not recorded at all. A unit test pins this, because "we do not log secrets" is exactly the claim that needs a
test rather than a comment.

**Stated limitation, not an oversight**: `worker-session.ts`'s own docblock records that three specs
deliberately do *not* import it — `auth.spec.ts`, `security-headers.spec.ts`, `bff-prod-lifecycle.spec.ts` —
because the fixture replaces the `storageState` option and would silently hand them a signed-in session. Those
three therefore get no capture. They are also not where the collapse manifests (#173's signature is every
*agent/dock* spec failing together), so this is an accepted boundary and is written into the runbook.

---

## US4 — One identity per worker

Per-worker **sessions** already exist; per-worker **users** do not. The machinery to close that gap is
already present: `worker-session.ts` resolves a storage-state file from `workerInfo.parallelIndex` via
`authFileForWorker`, and `keycloak-admin.ts` already mints users.

**Approach**:

1. Global setup mints N users through the Keycloak Admin API — one per worker — assigns `mc-user`, logs each
   in, and writes `authFileForWorker(i)`. N is the resolved worker count.
2. Fixture seeding, the default collection and the agent config are seeded **per user**.
3. `e2e-cleanup.ts`'s teardown becomes correct by construction: `listCollections` only ever returns the
   calling worker's data, so a blanket teardown can no longer delete another worker's live fixtures (the
   1.3-second median lifetime measured in #165).
4. The `lifecycle` project is untouched — `admin-registration` and `bff-prod-lifecycle` keep their own
   identities, which is what FR-015 enumerates.

**Mint at runtime, do NOT bake the users into the realm export.** Checked, not assumed:
[check-realm-consistency.mjs](../../scripts/check-realm-consistency.mjs) compares the **username set**
between `dev-realm.json` and `ci-realm.json` and fails on `users only in ci-realm`. Adding N per-worker users
to the CI realm would trip `guardrails / naming` unless mirrored into dev — an avoidable coupling. Runtime
minting is invisible to that gate and matches how `admin-registration.spec.ts` already works.

**The cost is measured before the ceiling moves (FR-014).** N× fixture seeding and N× agent-config PUT — the
latter running live credential probes — are a real setup cost, and one that could itself meet a rate limit.
A task records wall clock and the probe count before and after, and `MAX_E2E_WORKERS` is only re-evaluated
against `MAX_CONCURRENT_SESSIONS` **after** that number exists (FR-016). Raising the ceiling is a permitted
outcome, not a planned one: `app-e2e` runs ~35 min against a 75-minute budget, and a change that lengthens it
fails the job for a brand-new reason that looks exactly like the old one.

---

## US5 — Re-land the queued turn, judged against the verdict

The reverted fix is a one-line dependency change: [use-assistant.tsx:86](../../frontend/mcm-app/src/hooks/use-assistant.tsx#L86)
currently reads `[agent, resolveAgent, fire]`, and `agent` is a stable object whose `isRunning` is a mutable
property, so nothing re-runs the flush effect when a run *finishes*.

**Honouring "do not simply re-apply it".** Item #166's instruction stands, and it is honoured by *how* the
result is judged rather than by waiting: the revert's error was concluding causation from a 2-vs-1
comparison against a background whose variance was unlabelled. US3 supplies the `verdict`, and SC-007 requires
**at least three non-collapsed runs**, with excluded runs named in the report. That is the mechanically
correct remedy for the mistake actually made — gating on #173's *mechanism* would instead park a real
user-facing defect behind an open-ended diagnosis.

**Two changes, sequenced so their effects are separable**:

1. Restore `isRunning` in the flush effect's deps, with 053's RED→GREEN unit tests reinstated (T001–T003,
   T005 of that feature). `pendingRef.current = null` stays **before** `fire`, which is what makes delivery
   at-most-once under React 19 StrictMode's double-invoked effects.
2. Address FR-022 — today a second queued message silently overwrites the first. **Recommendation: a FIFO
   queue bounded at 8 messages** rather than a single slot. It satisfies FR-022 without any UI work, where
   the alternative (render the pending message in the dock) is a UX addition 053 explicitly scoped out. The
   trade is that all queued turns replay rather than only the last; the bound caps that. **On overflow the
   send is refused and surfaced to the member** — never dropped silently, which would re-create the exact
   defect this story fixes. Eight is far above any realistic type-ahead during one answer: it is a memory
   guard, not a UX limit. If the replay
   semantics prove wrong under E2E, the fallback is the single slot plus a visible pending indicator, and
   that decision gets recorded rather than quietly taken.

Landing (1) and (2) as separate commits means a regression in the suite can be attributed to one of them.

---

## US6 — A valid local full-suite signal

`dev-realm` sits at `accessTokenLifespan: 300` while `ci-realm` is `5400` — 052 scoped its fix deliberately,
and the local consequence went unnoticed. Six workers crossing a five-minute boundary re-enter exactly the
contention 052 removed.

**Approach: option 1 from item #168, plus a named substitute for what it costs.** Raise `dev-realm`'s
`accessTokenLifespan` to match `ci-realm`. The stated cost is local coverage of the refresh path — so the
substitute is named rather than left implicit: the BFF refresh path (including the 2-per-30 s bucket and the
429) is covered by `pnpm nx test:integration mcm-app`, which is where a rate-limit behaviour belongs anyway.
The realm-consistency gate is unaffected — its header states the two realms "may legitimately differ in
non-contract fields (redirect URIs, token lifespans)", and it compares realm name, app clients and usernames
only.

**FR-024 — the failure must name its cause.** Even with the lifespan raised, a long enough local run can
still cross a boundary. The local runner reads the contention counters at the end of a full-suite run and,
if `refresh_rate_limited > 0`, fails with a message naming the **token lifespan** — rather than leaving the
member to read `gotoHome: home screen did not render`, a sentence 052's own research calls out for naming a
cause it never tested.

Rejected: option 2 (document the horizon and refuse a full-suite invocation) — it leaves
`feature-validation-checklist.md` asking for a command that cannot produce a valid result, which is the
defect. Option 3 (a longer token only when a full-suite run is intended) needs a second dev realm or a
runtime realm mutation for no benefit over option 1 once the substitute coverage is named.

---

## Evidence standard, fixed in advance

Written here so no claim in this feature is judged by a number chosen after seeing the result.

| Claim | Standard | Why that number |
| --- | --- | --- |
| US1 correctness | Unit, RED then GREEN | Deterministic; a CI run cannot show it (a dispatched run posts no status) |
| US2 works | One green `app-e2e` whose counts are then read from a session | The claim is "readable", and one reading proves readable |
| US3's `verdict` is right | Checked against the measured signature on **every** run, and the result recorded | Cheap: every run is a sample, and a disagreement is itself the finding — perfect agreement is not required (the threshold is heuristic) |
| US4 removed the class | Two consecutive non-collapsed runs, empty failure-set diff by test identity | 052's SC-004 — a shrinking-but-varying set means reduced, not removed |
| US5 is safe | **≥3 non-collapsed runs**, collapsed runs excluded by `verdict` and named | #166's correction: a ~1-in-7 flip cannot be resolved by two samples |
| The collapse is gone | **10 consecutive runs, explicitly recorded as 79%-powered** | (6/7)¹⁰ = 0.214 — a clean ten has a 21% chance even if nothing was fixed. 20 would buy 95%. The cheaper standard was chosen deliberately; the report must carry that sentence |

**A red `app-e2e` is diagnosed before it is re-run.** The first question is US3's `verdict=` field, then the
Anthropic call count in the bundle's gateway log. Re-running as a reflex is how five stale specs hid for
three weeks.

## Risks

| Risk | Mitigation |
| --- | --- |
| US3's capture perturbs the timing it measures | Bounded in-memory ring, written only on a non-expected status; a task compares wall clock and counts against the pre-capture baseline |
| US4 lengthens `app-e2e` past `timeout-minutes: 75` | Cost measured before `MAX_E2E_WORKERS` is touched; the ceiling may stay at 6 |
| US4's N× agent-config PUT trips a live-provider rate limit | Probe count measured in the same task; seeding can be serialised or the config shared read-only if it does |
| A collapse is never caught during the feature | Reported as *not caught*, never as *fixed*; #173 stays open with the capture in place for whoever hits it next |
| US5's FIFO queue changes replay semantics under E2E | Landed as its own commit; fallback to single-slot-plus-indicator is pre-decided and recorded |
| A dispatched run posts no commit status, so `ci-status --sha` waits forever | Known; results read from the run's own outcome and its bundle. Listed in the runbook already |
| `run_number` in `/actions/tasks` is offset from the bundle's run id | LIST the package versions rather than constructing the name |

## Merge path

Branch cut from `main`, which is verifiable here because 051's `E2E_AGENT_PRODUCTION` forwarding is already
merged — the agent specs execute on `main`, so a green run on this branch means something. (This was not true
for feature 052, and that constraint is what its §7 was about.)

Verification is by `workflow_dispatch`, not by push. The PR is opened with a **real branch**
(`git push origin HEAD:054-app-e2e-reliability-cluster`, then `POST …/pulls` with the `git credential fill`
credential) — never an AGit push, whose `refs/pull/N/head` head runs with no Actions secrets and reports the
empty nx cache token as `Misconfigured remote cache endpoint`.

Backlog items #176, #167, #173, #169, #166 and #168 close on their own acceptance criteria, verified, not on
this PR merging. **#173 closes only if a collapse is caught, understood and fixed** — otherwise it stays open
with US3's detector and capture recorded on it as delivered. #170 gets a comment naming this feature's
residual failure rate as its trigger.
