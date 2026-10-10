# Research: 082 — wiki drift re-planning

## R1. Which concepts are stale, and why each is not re-planned (2026-10-10, offline, free)

**Method.** `node scripts/check-openwiki-okf.mjs` on `origin/main` (`0e5dcb8d`) for V12. For each flagged page:
- whether it has a `.page-manifest.json` entry (Claims-covered);
- whether `openwiki/.maintenance-state.json` → `backlog` holds it;
- whether its source's last commit is an ancestor of `coveredCommit` (`631f47dc`), using
  `git merge-base --is-ancestor`.

| Concept | Claims | Backlog | Source last commit | Relative to marker | Why |
|---|---|---|---|---|---|
| `process/spec-driven-development.md` ← `specs/` | no | no | f562668f | after (will be planned) | directory `resource`: re-flagged by every spec commit |
| `runbooks/ci-evidence-pipeline.md` | yes | **yes** | f81fdab6 | behind | retried from the backlog |
| `runbooks/devcontainer-sandbox.md` | no | no | 59147ab6 | **behind** | **parked** (PR #718, item #719) |
| `runbooks/infra-image-scanning.md` | yes | no | 4707ffb9 | after (will be planned) | — |
| `runbooks/renovate.md` | yes | no | 78b143a1 | **behind** | **parked** (PR #710, item #719) |
| `runbooks/sast-scanning.md` | yes | **yes** | 03db6735 | behind | retried from the backlog |
| `runbooks/wiki-maintenance.md` | yes | no | ae2d7769 | after (will be planned) | — |

**Finding.** Every page that is behind the marker and out of the backlog is there by a **deliberate parking**
decision. Today that decision is recorded only in a PR description and a backlog comment, never in the state
the planner reads. A drift re-planner must therefore distinguish parked pages from pages that genuinely
ratcheted, which means parking needs a field (spec FR-005).

On 2026-09-20 (item #526, at 7531611f) the count was **23 of 68**, and item #525's sweep cleared it. The count
is low today because of that sweep, not because the gap closed.

## R2. What openwiki's Claims preflight already covers

openwiki 0.7.1 `runClaimsPreflight` (`dist/claims/brains/code/preflight.js`) forces every page with a stale or
unresolved Claim citation into every run (item #707). `.page-manifest.json` lists **30** pages. A page is forced
only when one of **its citations** moved, and a page's `resource` is not necessarily among them. The mechanism
cannot be bounded per run, cannot exclude a page, and forces parked pages too. For example, `runbooks/renovate.md`
is forced through its `.forgejo/workflows/renovate.yml` citations (`wiki-maintain --claims-audit`, PR #722).

**Decision input:** this is a second, partial drift signal outside our control. It is not a substitute for planner-side
drift selection. Its cost is #707's subject.

## R3. The budget premise

Item #526 names "16 pages / 20 minutes per run". The current values are in `scripts/wiki-maintain.mjs`:
- `MAX_PAGES_PER_INVOCATION = 8` and `PAGE_BUDGET = MAX_PAGES_PER_INVOCATION`;
- `TIME_BUDGET_SECONDS = 4 * 60`, a **start** deadline checked between invocations;
- a job deadline (#613) that stops a running generator.

The criterion "the budget invariant still holds" is kept, with these values (spec FR-008).

## R4. Choosing `DRIFT_PAGES_PER_RUN`

With today's data, 2 unparked pages are behind the marker and both are already in the backlog. So steady-state
drift is small, and the bound matters for the recovery case: after a period of failures, or a burst of parking
and unparking. With 2 per run and the budget at 8, a run keeps at least 6 pages for change-driven and backlog work,
and drift only uses budget that is left over (spec FR-001). A run that lands clears n drifted pages in ⌈n/2⌉ runs.
At the 2026-09 count of 23, that is 12 landed runs, about the merge cadence of 1–2 weeks. That is slow enough to
avoid starving change-driven work, and fast enough to stop a ratchet.
