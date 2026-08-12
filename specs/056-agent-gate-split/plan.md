# Implementation Plan: which agent assertions may block a merge

**Branch**: `054-app-e2e-reliability-cluster` (shared) | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

## Summary

One rule, one tag per agent test, and two selections out of one job: a **blocking** run of everything
whose verdict is determined by code we control, and a **non-blocking** run of the model-decision
assertions that still executes, still publishes counts, and cannot fail a pull request.

## The rule

> **An agent assertion may block a merge only if the same code and the same prompt cannot produce a
> different verdict on a re-run.**

Stated as a property of the assertion, not of its failure history (FR-001) — a test is not promoted
because it has been lucky, nor demoted because it has been unlucky.

In practice:

| Blocks a merge | Does not block |
| --- | --- |
| the turn reaches the gateway and a reply renders | which words the model chose |
| the approval gate pauses and resumes | which tool the model selected |
| a chosen option navigates to the right route | how options were ranked |
| a tool call reaches mc-service and persists | whether TMDB returned this title first |
| an error surfaces to the member | whether the model classified an utterance as X |

**Borderline falls into the gate only if the deterministic half can be asserted on its own.**
Splitting a test is allowed and expected; guessing is not (spec Edge Cases, FR-009).

**What it costs, stated in the rule itself**: the gate stops proving that the assistant *makes the
right decision* — only that the machinery around the decision works. That is a real reduction, and it
is the price of a gate that means something when it is red.

## Mechanism — one job, two selections

Playwright tags (`test('…', { tag: '@model-decision' }, …)`, supported since 1.42; the repo runs
1.60), selected with `--grep` / `--grep-invert`.

```text
Web E2E (gate)         playwright test --grep-invert @model-decision     ← blocking
Web E2E (model tier)   playwright test --grep @model-decision            ← continue-on-error
```

### Why not a separate scheduled workflow

That was the obvious shape and it is the wrong one here. The model tier needs the *same* stack —
Keycloak, mcm, mc-service, the agent stack, the Playwright container — so a separate workflow
duplicates ~20 bring-up steps and doubles the infrastructure that can rot. Worse, it introduces
exactly the failure this feature is supposed to avoid: a tier that quietly stops running and reads as
passing (FR-007).

Running it as a second selection in the job that already has the stack up costs nothing to provision,
and cannot silently stop — if it stopped, the job would say so.

### Where the wall-clock saving comes from

The model tier is **skipped on `pull_request`** and runs on pushes to `main` and on
`workflow_dispatch`. So a PR pays only for the deterministic gate, while `main` and dispatched runs
still exercise the model assertions every time. That is the cycle-time win, and it is also what keeps
FR-007 satisfied without a schedule: every merge to `main` runs the tier.

### Counts, on both selections

Each selection writes its own `ci-log-step.sh` log, so `e2e-failure-set.mjs gate` runs twice and both
lines reach the counts bundle (054 US2). A reader sees the gate's counts and the model tier's counts
separately, on green runs as well as red.

## Enforcing the classification

A guard in `scripts/__tests__/` parses the agent spec files and fails when any `test(` in an
`agent-*.spec.ts` / `assistant-*.spec.ts` carries neither tag (FR-003). Static, so it runs in the
tooling tier rather than needing CI, and an unclassified test cannot drift into a tier by default.

## Verification

| Claim | Standard |
| --- | --- |
| The partition is complete and disjoint | The guard, plus `--list` on both selections: union = all agent tests, intersection = ∅ |
| An unclassified test fails | Add one deliberately in the guard's fixture, see it fail |
| The gate is stable | **Two consecutive `app-e2e` runs on identical code with an empty failure-set diff** (SC-004) — the thing 054's T028 could not achieve |
| The model tier still runs and reports | A dispatched run: its counts appear in the bundle beside the gate's |
| The price is stated | Wall clock and live turns against the #1684/#1685 baseline, both tiers' spend |

## Risks

| Risk | Mitigation |
| --- | --- |
| This becomes quarantine | The tier runs on every `main` push and every dispatch, publishes counts, and is non-blocking rather than absent |
| A wiring path loses its only gate coverage | FR-009: split the wiring assertion out and keep it in the gate before the model half leaves |
| The classification rots as specs are edited | The guard fails on an unclassified test |
| The gate goes green while the assistant is broken | Stated plainly in the rule as the accepted cost, not discovered later |
