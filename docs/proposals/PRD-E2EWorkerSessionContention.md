# PRD — `app-e2e` worker/session contention (make the web E2E suite survive its own agent specs)

**Status:** Proposed

**Created:** 2026-08-09

**Context:** Feature 051 fixed a false green: `app-ci / app-e2e` had never executed a single
`agent-*.spec.ts`, because `E2E_AGENT_PRODUCTION` was set at job level and never forwarded into the
Playwright container. Forwarding it worked — the specs now execute, with **zero skips**. But it also
exposed a **pre-existing** fragility that the skipping had hidden: **8 parallel Playwright workers
share a single `E2E_TEST_USER`**, and once the agent specs actually occupy those workers for minutes
at a time, the suite degrades badly. `app-e2e` is now red, and feature 051 is not mergeable until
this is resolved.

**This document is a handoff.** Everything in §1 is measured, from two full CI runs. Do not re-derive
it; §6 lists what is *not* yet established so the boundary is explicit.

**Related:**
[PRD-CIDiagnosticsGapClosure.md](PRD-CIDiagnosticsGapClosure.md) (feature 051 — where this was found),
[specs/051-ci-diagnostics-closure/tasks.md](../../specs/051-ci-diagnostics-closure/tasks.md) (T017 carries the full evidence trail),
[frontend/mcm-app/playwright.config.ts](../../frontend/mcm-app/playwright.config.ts),
[frontend/mcm-app/src/bff-server/session-manager.ts](../../frontend/mcm-app/src/bff-server/session-manager.ts),
[frontend/mcm-app/src/config/env.ts](../../frontend/mcm-app/src/config/env.ts),
[.forgejo/workflows/app-ci.yml](../../.forgejo/workflows/app-ci.yml),
[openwiki/invariants/feature-validation-checklist.md](../../openwiki/invariants/feature-validation-checklist.md).

---

## 1. Problem Statement — measured, not inferred

### 1.1 The same commit produces wildly different results

Two `app-ci` runs, **identical code, identical flags, provider `anthropic`**:

| | run #1603 | run #1604 |
| --- | ---: | ---: |
| collected | 177 | 177 |
| **failed** | **33** | **61** |
| flaky (passed on retry) | 15 | 37 |
| passed | 126 | 76 |
| **duration** | **17.9 min** | **1.1 h** |

Failure-set diff, by test identity: **26 in both · 7 only in #1603 · 35 only in #1604.**

So it is **both** a reproducible core *and* a large load-dependent component. Any explanation that
picks only one of those is wrong — two were tried and discarded during 051, and both are recorded in
T017 so the reasoning stays checkable.

### 1.2 The mechanism

Established from the run output and the config, not from an error message:

- **`Running 177 tests using 8 workers`** — printed identically in both runs. There is no `workers`
  setting in `playwright.config.ts`, so Playwright takes its default (~half the cores).
- **`fullyParallel: false`** serialises tests *within* a file but still runs *files* in parallel
  across those 8 workers.
- **All workers share one `E2E_TEST_USER` and one `storageState`**
  (`./tests/e2e/web/setup/.auth/user.json`, written once by global setup). Only `auth.spec.ts` and
  `admin-registration.spec.ts` opt out.
- **`MAX_CONCURRENT_SESSIONS` defaults to 10** ([env.ts:53](../../frontend/mcm-app/src/config/env.ts#L53)),
  and `session-manager.ts` **evicts the oldest session by `lastActivityAt`** when the cap is reached.
  8 workers against a cap of 10 sits right at the edge.
- **`retries: 1`**, and its comment already names the latent fault in the codebase's own words
  ([playwright.config.ts:24](../../frontend/mcm-app/playwright.config.ts#L24)):

  ```ts
  retries: 1,  // SSO timing races between parallel workers cause intermittent login timeouts
  ```

**What feature 051 changed.** Before it, an agent spec file was picked up by a worker, hit
`test.skip` in a `beforeAll`, and freed the worker in milliseconds. Now each holds a worker for
**minutes**, doing real model round-trips. The window in which all 8 workers are simultaneously
active against one shared session goes from negligible to most of the run. `retries: 1` then re-runs
that slow model work, which is why identical code took **3.7× longer** the second time — a
compounding loop, not a fixed cost.

### 1.3 What the failures look like, and why the message misleads

30 of 33 failures in run #1603 carried:

```text
Error: gotoHome: home screen did not render — is the global-setup session valid?
```

**That sentence is the helper's guess, not a measurement.** `gotoHome` races two selectors for 60 s
and throws it on timeout; it cannot distinguish an invalid session from a slow render. During 051 it
was briefly taken at face value, and the correction is recorded in T017 rather than quietly dropped —
an error string that names a cause it never tested is exactly the class of false signal that feature
worked on. **Do not treat that message as evidence of session death.**

### 1.4 Who the 26 reproducible failures actually are

| Bucket | Count | Verdict |
| --- | ---: | --- |
| `agent-*.spec.ts` (gated; **never ran in CI before**) | 7 | **Genuine pre-existing defects.** This is the answer backlog item **#150** asked for. Out of scope here; file separately. |
| previously-green ungated specs — `movies` (8), `responsive` (3), `assistant-*` (7), … | 19 | **Collateral from the contention above.** Not 19 independent regressions. |

---

## 2. Goals / Non-Goals

### Goals

- `app-ci / app-e2e` is green again **without** re-hiding the agent specs.
- The agent specs keep executing with a **zero** skip count — SC-001 of feature 051 must not regress.
- The fix is proven by **result** (executed/skipped/failed counts across two consecutive runs), never
  by exit status alone.

### Non-Goals

- **Fixing the 7 genuine `agent-*` defects.** They are real, they are pre-existing, and they belong to
  item #150. Conflating them with this would make both harder to judge.
- Reducing overall E2E runtime. Speed is not the objective; determinism is.
- Any change to feature 051's instrumentation, gates or digest work — that is landed and CI-green.

---

## 3. Proposed Solution (sketch — planning should challenge this)

Three candidates, cheapest first. **They are not exclusive**, and 1 is a reasonable stopgap even if 3
is the eventual answer.

### 3.1 Pin `workers` for CI — one line

```ts
workers: process.env.CI ? 4 : undefined,
```

Halves the concurrent pressure on the shared session and moves 8-against-a-cap-of-10 well clear of
the edge. Cheapest possible change; costs wall-clock time on a job that already runs ~35 min.

**Open question for planning:** is 4 low enough? That is a measurement, not a guess — see §4.

### 3.2 Raise `MAX_CONCURRENT_SESSIONS` for the CI BFF — one env var

If eviction is the proximate cause, lifting the cap for the CI stack alone removes it without
touching test topology. **Only worth doing if §6's first question is answered yes** — otherwise it
treats a symptom that may not be the one biting.

### 3.3 Give the agent specs their own identity — the real fix

A dedicated E2E user for `agent-*.spec.ts`, or running them as a separate Playwright **project** with
its own `storageState`. Removes the shared-session coupling rather than tuning around it, and stops
the next slow spec family from re-creating this. Largest change; needs a seeded second user in the CI
realm (`ci-realm.json`) and its own global setup.

**Recommendation:** land 3.1 first to unblock 051, measure, then decide between 3.2 and 3.3 with the
numbers in hand. Do not ship 3.1 and declare victory — §4 requires two consecutive runs.

---

## 4. Success Criteria

Stated as observed results, because a green tick here is the thing that was wrong before.

- **SC-1** — `app-e2e` passes on **two consecutive** runs. One green run does not distinguish a fix
  from the favourable end of the variance already measured in §1.1.
- **SC-2** — the agent specs show a **non-zero executed count and a zero skip count** in both runs.
  Measured by count, not by exit status. (This is feature 051's SC-001; it must not regress.)
- **SC-3** — the failure-set diff between the two runs is **empty**. A shrinking-but-still-varying set
  means the contention was reduced, not removed, and should be said so rather than accepted.
- **SC-4** — any residual failures are exclusively the 7 known `agent-*` defects from §1.4, each
  filed against item #150.

---

## 5. Residual Risk (named deliberately)

- **Lowering `workers` lengthens `app-e2e`**, already the longest job on a capacity-1 runner. If it
  pushes past `timeout-minutes: 75`, the job fails for a new reason — check the budget before merging.
- **The agent specs cost real model tokens on every run**, and `retries: 1` doubles that for each
  failing spec. Reducing flakiness reduces spend; it is a genuine secondary benefit, not just tidiness.
- **§3.3 adds a second CI realm user**, which must stay in lockstep with `dev-realm.json` — the
  realm-consistency gate in `guardrails / naming` will enforce that, and will fail loudly if it drifts.

---

## 6. What is NOT established — read before planning

Stated explicitly so the next session does not inherit a guess as a fact.

1. **Whether session *eviction* actually fires.** The cap is 10 and there are 8 workers, which is
   *close* — but no eviction was observed directly. `session-manager.ts` logs nothing on evict, and
   the BFF log showed 0 hits for `evict`, `concurrent` or `session`. **Adding a log line on eviction
   is probably the single highest-value diagnostic** and is a one-line change.
2. **Whether the 361 `auth_failed reason:"no_token"` events are signal or noise.** `no_token` means a
   request arrived with no cookie at all, which is what the deliberately-unauthenticated specs do by
   design. They were *not* counted as evidence of eviction, and should not be without further work.
3. **Whether 4 workers is sufficient**, or whether it needs to be 2, or 1. Measure; do not assume.
4. **Whether the 19 collateral failures fully disappear** once contention is addressed. Expected, but
   unproven — SC-3 exists to catch the case where they do not.

---

## 7. State of feature 051 (the branch this came from)

`051-ci-diagnostics-closure` — **pushed, no PR opened, nothing merged.** Check the current shape with
`git log --oneline main..HEAD` rather than trusting a count written here.

- **Delivered and CI-green:** US1, US2, US3, US5, US6, US7. All five `guardrails` jobs plus `changes`,
  `affected`, `mc-service-checks`, `dast`, `infra-image-scan` and `devcontainer-image` pass on the
  branch. Local suite: **517 collected, 517 pass, 0 fail, 0 skipped**; all nine gates green.
- **`app-e2e` is the only red job**, for the reason this document exists.
- **Two commits are TEMPORARY and MUST be reverted before merge** (feature 051 T058 checks for them):
  `fcb1975` and `b0dbb1d`, both titled `TEMPORARY(051): …`. They add an auto-token capability probe to
  `guardrails / secret-scan`. **The probe has not been dispatched yet** — 051's T034 is still open, and
  its result gates whether US4 gets built at all.
- **Also still open on 051:** T056/T057 (rehearsals), T058 (the revert), T061 (backlog closure), and
  **T049** — the operator's Windows re-run, which is the only thing that closes item **#157**.

### ⚠️ The fix CANNOT be verified on `main` — decide the branching first

This is the first decision, and it is not obvious. **The contention only manifests when the agent
specs actually run, and they only run with feature 051's `-e E2E_AGENT_PRODUCTION` forwarding.** On
`main`, `app-e2e` still skips every agent spec, so it is green *whatever* this fix does — and §4's
criteria could not be measured at all. A branch cut from `main` would produce two green runs that
prove nothing, which is precisely the false-green shape both this document and feature 051 exist to
eliminate.

So the fix and 051's forwarding must be **on the same branch when verified**. Two workable shapes:

| Option | Shape | Trade |
| --- | --- | --- |
| **A** | Cut the new feature branch **from `051-ci-diagnostics-closure`**, fix there, merge it back into 051, and merge 051 as one unit | Verifiable immediately; couples the two, and 051's PR grows |
| **B** | Keep 051 as-is and treat the fix as an extension of its scope (a new story on the existing branch) | Simplest to verify; widens 051, which was deliberately scoped to diagnostics |

**Not workable:** a branch from `main`, verified independently. Say so if someone proposes it.

### Process notes for whoever picks this up

- **SDD applies.** §3 touches `frontend/mcm-app/playwright.config.ts`, which is implementation code —
  a numbered `specs/NNN-*/` **spec → plan → tasks** set is required before the edit. This proposal is
  exempt as a proposal; the fix is not.
- **A backlog item has NOT been filed** for this. It probably should be, alongside a separate one for
  the 7 `agent-*` defects under item #150.
- **Verifying a branch without a PR**: `guardrails` and `app-ci` scope `push:` to `main`, so a branch
  push runs almost nothing. Dispatch them instead — the recipe, and three traps that each produce
  *silence that reads as a result*, are in
  [docs/runbooks/ci-diagnostics.md](../runbooks/ci-diagnostics.md).

---

## Prompt for the fresh session

```text
Fix the app-ci / app-e2e worker/session contention in /workspaces/mcm.

Read docs/proposals/PRD-E2EWorkerSessionContention.md first, all of it. Section 1 is
MEASURED across two full CI runs — do not re-derive it. Section 6 lists what is NOT
established, so you can see exactly where the evidence stops.

Background in one line: feature 051 forwarded E2E_AGENT_PRODUCTION into the Playwright
container, so the agent specs finally execute (zero skips — that is the win, and it must
not regress). Doing so exposed a pre-existing fragility it did not create: 8 parallel
Playwright workers share one E2E_TEST_USER against a MAX_CONCURRENT_SESSIONS cap of 10.
app-e2e is now red and feature 051 cannot merge until this is resolved.

Decide the branching BEFORE anything else — §7's "cannot be verified on main" section.
The contention only appears when the agent specs run, which only happens with 051's
forwarding, so a branch cut from main would go green while proving nothing. That is the
exact false-green this work exists to remove. Pick option A or B and say which.

SDD applies: playwright.config.ts is implementation code, so write the numbered
specs/NNN-*/ spec → plan → tasks set before editing it. The proposal itself is exempt.

Rules that matter more than usual here:
- ONE green run is not evidence. §4 requires two consecutive runs AND an empty
  failure-set diff, because the measured variance between two identical runs was
  33 vs 61 failures and 17.9min vs 1.1h.
- Judge by COUNTS — executed, skipped, failed — never by exit status.
- Do not "fix" this by re-skipping the agent specs or narrowing the selection. That
  recreates the false green feature 051 removed.
- The 7 genuine agent-* defects are OUT of scope; they belong to backlog item #150.
  Keep them separate or neither problem can be judged.
- 'gotoHome: ... is the global-setup session valid?' is the helper's GUESS on a 60s
  timeout, not a measurement. It was believed once already. Do not treat it as evidence
  of session death.
- Session eviction has never been directly observed. session-manager.ts logs nothing
  when it evicts; adding that one line is probably the cheapest useful diagnostic and
  would settle §6 question 1.

Verifying a branch needs a workflow_dispatch, not a push — guardrails and app-ci scope
push: to main. The recipe and three traps that each produce silence-that-looks-like-a-
result are in docs/runbooks/ci-diagnostics.md.

Feature 051's branch carries two commits titled TEMPORARY(051) (fcb1975, b0dbb1d) that
must be reverted before any merge. Do not merge 051 with them present. Leave 051's own
open tasks (T034, T049, T056-T058, T061) alone unless you are asked.
```
