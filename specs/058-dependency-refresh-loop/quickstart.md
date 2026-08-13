# Quickstart — validating feature 058

**Feature**: `058-dependency-refresh-loop` · **Date**: 2026-08-13

How to prove this feature works, in the order the evidence becomes available. Read
[research.md R3](./research.md) first if you are tempted to verify anything by reading a CI log — this
forge exposes no log or step endpoint, and a *successful* run publishes no failure digest, so a green
tick proves less here than it does elsewhere.

## Prerequisites

- The dev container (`docs/runbooks/devcontainer.md`).
- `MCM_FORGE_TOKEN` in the environment for API **reads**; `git credential fill` for **writes**.
- No stack needs to be up. Every check below except §4 is pure file parsing.

---

## 1. The test tier (fastest signal, run this first)

```bash
node --test scripts/__tests__/*.test.mjs
```

**Expected**: the suite passes with a count **above** the 653 baseline — this feature adds tests, so an
unchanged count means the new files were not discovered. Check the count, not just the colour.

The two new/extended files:

```bash
node --test scripts/__tests__/app-ci-lockfile-filter.guard.test.mjs
node --test scripts/__tests__/override-lever.test.mjs
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```

## 2. The mutation checks (what makes §1 mean anything)

A wiring test is exactly the kind that can pass vacuously, so each assertion is proven by breaking the
thing it guards. Do these one at a time, reverting between:

| Mutation | Expected failure |
| --- | --- |
| remove `pnpm-lock.yaml` from `changes.app` in `app-ci.yml` | filter test fails by name (FR-001) |
| remove `pnpm-workspace.yaml` from `changes.app` | filter test fails (FR-002) |
| add `pnpm-lock.yaml` to `changes.mobile` | filter test fails (FR-003) |
| add a path to `mobile` that is not in `app` | subset test fails (FR-004) |
| remove `pnpm-workspace.yaml` from `push:` paths | agreement test fails (FR-005) |
| change `app-e2e`'s `if:` to drop `needs.changes.outputs.app` | wiring test fails (FR-006) |
| delete `lockFileMaintenance.schedule` from `renovate.json` | schedule test fails (FR-010) — **this is the trap from R1** |

```bash
git diff --stat && git checkout -- .forgejo/workflows/app-ci.yml renovate.json   # revert between each
```

## 3. The gates, unweakened

```bash
node scripts/check-override-consistency.mjs        # exit 0 · 11 keyed floors, 11 agreeing
node scripts/check-override-consistency.mjs --selftest
```

**Expected**: unchanged from before this feature. This is SC-008 — the guard must not have been relaxed
to accommodate anything here.

## 4. The advice, against the measured incident and against live `main`

```bash
node scripts/sast-scan.mjs --scope full --only pnpm-audit
node scripts/check-sast-findings.mjs
```

**Do not use the bare `--scope full` scan.** It fail-closes (semgrep.dev is outside the egress
allowlist by design — re-apply the firewall, never allowlist it) and leaves a 0-finding report the gate
passes **vacuously**.

**Check the finding count, not the exit code.** Baseline before this feature: **55 findings, 2
blocking** (the allowlisted `image-size` pair).

**Expected** in the gate's output — the two live cases named (SC-006):

```
hono 4.12.29 — `>=4.12.25` already permits 4.12.34; the lockfile pins 4.12.29. Refresh it.
undici 6.27.0 — `>=6.27.0 <7` already permits 6.28.0; the lockfile pins 6.27.0. Refresh it.
```

and `undici@7.24.7` **absent** from that section — its resolution is outside the override's range
(FR-019). Exit code unchanged at 0 (FR-018).

## 5. Pre-push sweep

```bash
pnpm nx preflight infrastructure-as-code    # 27 checks
```

---

## 6. The observation that cannot be done locally (#186's acceptance criterion)

#186 requires a pull request touching **only** `pnpm-lock.yaml` to demonstrably run the intended tier —
"verified by reading the job list, not by assuming the filter matched".

**After PR-A merges**, open PR-B:

```bash
pnpm update hono undici --lockfile-only    # the remedy §4's advice recommends
git status --porcelain                     # MUST show pnpm-lock.yaml and NOTHING else
```

If any other file changed, the observation is void — a second changed path could be what matched the
filter. Then push a **real branch** and open the PR by API (never AGit: a `refs/pull/N/head` head runs
with no Actions secrets):

```bash
git push origin HEAD:058-lockfile-refresh-probe
# then POST …/pulls using the `git credential fill` credential, NOT MCM_FORGE_TOKEN (read-only)
```

**Expected**: `app-ci/app-e2e` reports a real conclusion, **not `skipped`** (SC-001). It reported
`skipped` on both PR #185 and PR #187 before this feature.

**Stated limit**: the job's conclusion is observable; its *step list* is not. That the emulator half did
not run rests on the mutation-tested wiring assertion (§2), not on an observation. Do not claim
otherwise in the evidence comment.

**Then** re-run §4 on the merged result: the `hono` and `undici` findings should be **gone by count**
(SC-007).

## 7. The observation that has to wait for the bot (#184's acceptance criterion)

The first scheduled run after PR-A merges must produce a lockfile-refresh proposal (SC-009). The crons
are nightly `0 3 * * *` (security-exempt only) and Friday `0 7 * * 5` — so the relevant run is the
**Friday** one.

```bash
node scripts/ci-status.mjs ...     # or list runs via /actions/tasks
```

Watch for a pull request whose branch topic is `lock-file-maintenance`.

**Traps** (all measured, all previously cost a session):

- A dispatch returns **204** and the run is **invisible** in `/actions/tasks` until it starts. An empty
  listing is not evidence the dispatch failed — re-dispatching only queues duplicates.
- `inputs` values must be **strings** (`{"dryRun": true}` → 422).
- A **successful** run publishes no failure digest, so its log is unreadable. Verify by exit code plus a
  failing control, never by expecting to read output.

**Item #184 stays open until this is observed.** The config being correct is necessary, not sufficient —
R1 exists precisely because a configuration that looks right can be one that never fires.

---

## Done means

| # | Criterion | Where |
| --- | --- | --- |
| SC-001 | lockfile-only PR runs the tier | §6 |
| SC-002 | emulator half excluded | §2 (pinned), §6 (stated limit) |
| SC-003 | six wiring mutations each fail | §2 |
| SC-004 | removing the explicit schedule fails | §2 |
| SC-005 | fixture reconstruction advises refresh | §1 |
| SC-006 | live cases named | §4 |
| SC-007 | findings cleared by count | §6 |
| SC-008 | override guard unweakened | §3 |
| SC-009 | bot proposes a refresh | §7 |
| SC-010 | both items closed with evidence | after §6 and §7 |
