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
`app-e2e` is ~35 min, so every extra PR costs a runner slot, and a stack of N PRs trends toward
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

**The second `app-e2e` after a merge is a CHOICE, not something the forge forces — and the runner
cost is O(N) regardless.** This passage used to say a merge "invalidates the others' base, forcing
an Update-branch and a full re-run". Measured 2026-09-06 on `main`'s branch protection:

```bash
curl -s -H "Authorization: token $TOKEN" "$FORGE/api/v1/repos/jumbleknot/mcm/branch_protections" \
  | jq '.[] | {branch_name, block_on_outdated_branch}'
# → "block_on_outdated_branch": false
```

So a sibling PR whose own contexts already passed stays mergeable after another PR merges: nothing
is *forced*. Re-running it is still often right — an outdated branch's `app-e2e` never exercised the
two changes together — but that is a judgement about what you want tested, and it should be made
deliberately rather than paid because the forge appeared to demand it. Whether the setting was
`false` on 2026-07-26 is unknown; that session's ~4 h measurement stands either way.

What a merge *does* cost unconditionally is one runner slot: the merge commit triggers `app-e2e` on
`main`, which occupies the single runner ahead of every open PR. Measured twice on 2026-09-06 —
after PR #369 merged, `main`'s own `app-e2e` ran ahead of PR #370's, and after #370 merged it ran
ahead of #372's. Both times a `ci-status watch` expired against a queue, not a stall. Budget for
that when sequencing merges; see
[CI self-serve diagnostics](/openwiki/runbooks/ci-diagnostics.md) for reading a starved queue
correctly.

## Splitting a feature moves the attribution baseline — `main` stops being the control

A feature shipped as PR A then PR B has a consequence that is easy to miss while working on PR B:
**`main` already contains half the feature.** So the reflex question when a test fails —

> "does it fail on `main` too? then it is pre-existing, not mine"

— is no longer sound. It puts part of the suspect in the control group, and it will confidently
clear the feature of a regression the feature caused.

**The baseline is the commit before the feature's FIRST pull request**, not `main`:

```bash
git log --oneline --merges main | grep '<feature-number>'   # find PR A's merge commit
git rev-parse <prA-merge>^1                                 # its first parent = the true baseline
git diff --stat <baseline> main -- <the code the test exercises>
```

Measured 2026-08-05 (047 PR B). Two agent E2E specs failed. Bisecting against `main` showed them
failing there too, and they were recorded as pre-existing — wrongly. Against the real baseline the
diff immediately showed PR A had grown `organizer.py` by 363 lines, `render-movie-card.tsx` by 78,
and inserted the ownership-question chain ahead of the approval gate. One of the two failures was
that chain: the spec waited for an approval card that the feature had moved behind four new
questions. It was the feature's regression, found only because the human reviewer said "those were
working before 047" and did not accept the `main` comparison.

**The cheap version of this check costs nothing**: before running any bisect, `git diff --stat
<baseline> main -- <paths the failing test exercises>`. If the feature's earlier PR touched that
code, "it fails on main" tells you nothing.
