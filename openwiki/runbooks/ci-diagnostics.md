---
type: Runbook
title: CI self-serve diagnostics
description: How ci-status.mjs answers "is this commit mergeable" without a human pasting CI logs into the session — the superseded-vs-failed misclassification trap, the live-fetched required-check list, and the query shape that keeps a lookup fast instead of pulling a multi-megabyte payload.
resource: docs/runbooks/ci-diagnostics.md
tags: [ci, forgejo, diagnostics, tooling, runbook]
timestamp: 2026-07-26T11:52:54+00:00
---

# CI self-serve diagnostics

The forge's API exposes no log, artifact, or per-run-jobs endpoint, so `scripts/ci-status.mjs`
inverts the usual direction: CI pushes a curated status digest somewhere the API can already read,
and the script reads it back to answer "is this commit/PR mergeable" and "why did it fail" without a
human copy-pasting logs into the session. It resolves the forge host from the `origin` remote at
runtime rather than any literal configured value.

## Gotchas

- **Two of the five reported check states are misreported by the raw API and must be derived, not
  trusted literally.** A path-gated-out job reads `success` with description "Has been skipped"
  (fine); a cancelled-by-newer-push run reads `failure` on **every** job it touched, even though
  nothing was actually broken — the tell is that unrelated jobs die together on a change that
  couldn't have affected them all, confirmed by the literal "Has been cancelled" description or the
  owning run's `cancelled` status.
- **The "superseded" trap is the dangerous direction: it fails loud, announcing a broken build that
  isn't.** The other misreport (skipped) fails safe. Both were measured against real API responses,
  not inferred from documentation.
- **The required-check list is fetched live from branch protection, never hand-maintained.** It
  previously drifted (a hardcoded array missed a check added by a later feature) and let the tool
  report "mergeable" for a PR the forge then rejected outright — over-reporting mergeable is the
  dangerous direction here, because a wrapper that chains a status check into an actual merge call
  will attempt a merge that cannot succeed.
- **A context string carries an event suffix, and the same job can disagree between events** (e.g.
  green on `push`, red on `pull_request`) — a required-check glob that ignores the event can report
  failure for a commit whose relevant run was entirely green. The tool selects the event matching the
  query type.
- **Query shape is a correctness rule here, not a performance tweak.** Filtering by the full commit
  SHA is server-side honored and returns a small payload; several other filter parameters are
  silently ignored by the API and fall back to a payload roughly 800x larger — using the wrong query
  doesn't just make a lookup slower, it can make it impractically slow.
- **Exit code `3` (still waiting when `watch` timed out) is deliberately distinct from exit `1` (a
  required context failed).** There is a single CI runner in this homelab, so a saturated queue is
  expected and must never be conflated with an actual build failure.

Full exit-code table, the exact API endpoints and payload measurements, and the required-check
fetch/fallback logic: `docs/runbooks/ci-diagnostics.md`.
