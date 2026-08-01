---
type: Runbook
title: OpenWiki knowledge-bundle maintenance
description: How to run, read and diagnose maintenance of the OKF bundle at openwiki/ — locally and in CI — including the plan/execute split, slice sizing, the retry-then-backlog model, exit codes, and how a lost run record self-heals against the forge's own proposal state.
resource: docs/runbooks/wiki-maintenance.md
tags: [openwiki, okf, ci, automation, runbook]
timestamp: 2026-08-01T00:55:16+00:00
---

# OpenWiki knowledge-bundle maintenance

**Feature 044.** `pnpm nx wiki-plan infrastructure-as-code` decomposes documentation changes since the
last recorded run into **slices** — at most 8 pages, exactly one bundle area each — offline and free,
so there is never a reason to skip it before spending on `pnpm nx wiki-maintain infrastructure-as-code`
(paid, needs `ANTHROPIC_API_KEY`). The run record lives at `openwiki/.maintenance-state.json`,
committed because runners are ephemeral; it is distinct from the tool's own
`openwiki/.last-update.json`. See [OpenWiki bundle generation and maintenance](/openwiki/process/wiki-maintenance.md)
for the underlying `wiki-update`/`okf-lint` Nx targets this machinery drives, and
[Nx as the task runner](/openwiki/invariants/nx-task-runner.md) for why the bare `openwiki` CLI must
never be invoked directly.

## Gotchas

- **A filename is not a specification.** The run message carries a one-line subject per page — without
  one, the generator spends its whole budget working out what a page should say; measured across the
  feature-044 relocation, that single change was the difference between 0 pages in 643s and 3 pages in
  367s. The planner asks for at most 8 pages when *refreshing* existing concepts but only 3 when
  *creating* new ones, and never mixes the two kinds in one slice. **The creation cap of 3 is
  unverified**: it was calibrated while every turn was silently capped at 4096 output tokens (the
  `claude-sonnet-5` bug); that cap is now fixed, and the limit may be needlessly conservative — treat
  it as a starting point, not a measured finding, and raise it against measurement if you need to.
- **The backlog is committed, so it outlives the policy that produced it — and is re-validated against
  the current policy on every plan.** A slice that can never succeed (e.g. one targeting a page
  `policy.yaml` no longer covers) is dropped and reported as `carried-forward page(s) dropped` rather
  than silently starving the queue behind it. A failed slice no longer blocks the next one either; the
  run stops only after **two consecutive** failures.
- **A slice is retried up to 3 times within one run before returning to the backlog**, and the attempt
  count is always reported. A retry can never forgive what an earlier attempt did: the working tree is
  snapshotted once, before the first attempt, so a forbidden write on attempt 1 still fails the slice
  even if attempt 2 behaves. Note: the ~50% "miss" rate measured during feature-044 was not genuine
  non-determinism — it was a fixed bug (the `claude-sonnet-5` model id was absent from `@langchain/anthropic`'s
  table, so every turn was silently capped at 4096 output tokens and truncated before it could open a
  tool call). The target now pins `claude-sonnet-4-6` (16 384 token ceiling). **If zero-page runs
  return, measure the wire — check `stop_reason` and `output_tokens` on a pass-through proxy — not the
  retry count.**
- **The budget is 16 pages and 20 minutes, whichever comes first, checked between slices** — a
  declared effective ceiling of ≤24 pages / ~37 minutes. The page count is files that actually
  appeared in the working tree, not what the generator claims to have written. Exit code `3` means the
  run correctly stopped at budget with work outstanding — not a failure, and re-running continues where
  it left off.
- **A slice fails when any of three things is true, and the generator's own exit status is not one of
  them:** no concept page appeared (an `index.md`-only refresh counts as zero pages — this is exactly
  what produced feature 043's false-green run), the bundle stopped being conformant, or a written path
  was not permitted by `openwiki/policy.yaml`.
- **Remediation is always the brief, never an allowlist.** If a page trips the conformance gate, a leak
  scan, or the governance gate, fix `openwiki/INSTRUCTIONS.md` and re-run — the gates have no skip flag
  by design, because an allowlisted leak stays leaked.
- **CI waits ~15 minutes (concurrency + `cancel-in-progress` + an initial sleep) so one run covers a
  burst of merges, but never defers past 6 hours** — that ceiling is derived from git commit dates
  because the waiting run gets cancelled and any in-memory timer dies with it; git state survives
  cancellation, run state does not.
- **The proposal is one long-lived branch, at most one open pull request, ever, and never
  auto-merged.** Closing it without merging returns its work to the backlog and rolls the marker back.
- **If the run record and the forge disagree about an open proposal, the forge wins.** The record's
  `proposal` pointer is a cache, not the source of truth — a run created a proposal, its marker commit
  lost a push race against `main`, and the pointer never landed; the next run then tried to open a
  second proposal and died on `forge POST /pulls → 409`. A run now asks the forge which proposal is
  open for the branch before creating one, adopts it if found, and treats a 409 as "someone beat me to
  it — adopt and update" rather than a fatal error, so a run that lost its record self-heals instead of
  staying permanently stuck.
- **A protected passage may only live on a concept with no `resource`.** Freezing a derived summary
  against the document it summarizes would fail every legitimate refresh; see
  `openwiki/protected.yaml` and the fingerprint-update command in the full runbook.

Full plan/execute CLI flags, the exit-code table, the CI workflow's proposal-adoption logic, and the
self-test/lint/governance verification commands: `docs/runbooks/wiki-maintenance.md`.
