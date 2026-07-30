---
type: Process
title: PR batching — split only when a failure would be ambiguous
description: The rule for how many pull requests to open for a set of changes, given a single CI runner and a ~35-minute app-e2e job — batch by default, split only when a red build could not be attributed to one change.
tags: [ci, process, pull-requests, app-e2e]
timestamp: 2026-07-30T13:49:05-04:00
---

# PR batching — split only when a failure would be ambiguous

There is one CI runner and the `app-e2e` job takes about 35 minutes, so every extra pull request
costs a runner slot — and every merge invalidates the others' base, forcing an update-branch and a
full re-run. A stack of N pull requests therefore trends toward O(N²) `app-e2e` runs. This rule
governs how to decide when to batch unrelated changes into one PR versus splitting them, and is
relocated here verbatim from `CLAUDE.md` because it is a non-obvious operational decision, not a
step-by-step procedure. See [Testing tiers and what gates a merge](/openwiki/invariants/testing-tiers.md)
for why `app-e2e` (the integration tier) is the expensive gate this rule is protecting, and
[the CI/CD pipeline](/openwiki/projects/ci-cd-pipeline.md) for where that job sits in the workflow.

## Gotchas

**How many PRs? Split only when a failure would be AMBIGUOUS.** There is one `kvm` runner and
`app-e2e` is ~35 min, so every extra PR costs a runner slot — *and* every merge invalidates the
others' base, forcing an Update-branch and a full re-run. A stack of N PRs therefore trends toward
O(N²) `app-e2e` runs (measured 2026-07-26: four small fixes cost six-plus runs, ~4 h of runner
time). So batching is the default. The test is not "are these changes related?" but:

> **If CI goes red, could I tell WHICH change caused it?** If yes → batch them. If no → split.

Both directions were demonstrated in that same session. Splitting **earned** its cost once: the
pnpm-11 bump and a Maestro flow race were separated, and the flow fix's PR passing `app-e2e` while
the pnpm PR failed on the *same flow* is what proved the race was not caused by pnpm. Splitting
**wasted** it elsewhere: an unrelated exit-code fix and a CVE-allowlist edit each took their own
full suite when neither could have been confused for the other. Run
`pnpm nx preflight infrastructure-as-code` before pushing either way — it catches the
offline-knowable failures without spending a runner slot at all.
