---
type: Process
title: Test authoring conventions — Rust test placement and the RED/GREEN task template
description: Where Rust unit and integration tests live in mc-service, and the rule that every feature test task follows the tasks-template's Verify RED then Verify GREEN checkpoint format.
tags: [testing, tdd, rust, process]
timestamp: 2026-07-30T13:49:05-04:00
---

# Test authoring conventions

Two conventions govern how tests are written and sequenced in this repository: where Rust tests
physically live in [mc-service](/openwiki/projects/mc-service.md), and the checkpoint structure
every feature's test tasks must follow regardless of language. Both are relocated here verbatim
from `CLAUDE.md` because they are load-bearing conventions, not step-by-step procedures. See
[Testing tiers and what gates a merge](/openwiki/invariants/testing-tiers.md) for how these tests
fit into the unit/integration/golden/E2E tiers and what actually gates CI.

## Rust (mc-service) test placement

**Unit tests** live in an inline `#[cfg(test)]` module at the **bottom of the same source file**
being tested — not in a separate file:

```rust
// src/domain/collection.rs
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn name_max_50_chars_enforced() { ... }
}
```

**Integration tests** live in `backend/mc-service/tests/integration/` (sibling to `src/`). Each
file is a separate test binary compiled against the crate. Require MongoDB running.

```bash
pnpm nx test mc-service                          # unit tests (inline #[cfg(test)] blocks)
pnpm nx test:integration mc-service              # integration tests (requires mc-service compose up)
pnpm nx test mc-service -- --test collection_create  # single test by name
```

## The RED then GREEN checkpoint format

Every feature test task must follow the format in
`docs/templates/feature-test-tasks-template.md`, which pairs each test-writing task with an
implementation task and requires two explicit checkpoints:

- **Verify RED** (run before implementing — the test must fail). If this shows 0 failures, the
  test is trivially passing and must be fixed before implementation; a passing test that was never
  RED is not a TDD test.
- **Verify GREEN** (run after implementing — the test must pass), followed by re-running the
  touched suite as a regression check to confirm previously passing tests still pass.

Documentation and config tasks are exempt from the RED/GREEN cycle — the template provides a
separate "Done when" format for those. See `docs/templates/feature-test-tasks-template.md` for the
full template, the platform parity table format, and the worked example.

## Gotchas

- **A passing test that was never RED is not a TDD test.** The template's explicit "Expected RED:
  [N] test(s) failing" line exists specifically to catch a test that was written trivially-passing
  and would otherwise slip through without ever proving anything.
- **Rust unit tests must stay in the same file as the code they test, at the bottom.** A separate
  test file for Rust unit tests is a convention break, not a stylistic choice — reviewers and future
  agents should expect `#[cfg(test)] mod tests` inline, and treat a standalone unit-test file as a
  signal something was misplaced (integration tests are the one exception, and those belong in
  `tests/integration/`, not scattered elsewhere).
- **The paired implementation task's regression check runs the touched suite, not the full suite.**
  Running the full regression on every implementation task is redundant with the final validation
  checklist and is not what the template asks for.

## Watching a test fail proves it is SENSITIVE, not that it is CORRECT

The RED/GREEN discipline above says: see the test fail before you make it pass. That check has a
blind spot worth naming, because it is easy to mistake for proof.

**Removing the code and watching the test go red only proves the assertion tracks that code. It
says nothing about whether the assertion is the right one.** A test can be perfectly sensitive to a
property nobody needs.

Measured 2026-08-05 (047 US3). A dock test asserted that `useAgent` was *asked* for the
`OnStateChanged` update. It passed; deleting the option made it fail; that felt like proof. But
`useAgent` resolves `updates ?? ALL_UPDATES`, so passing a list **replaces** the default rather
than extending it — the "explicit" subscription silently dropped message and run-status updates,
and tool calls stopped reaching the client. The unit suite stayed green through all of it, because
it asserted what was **requested** and never what was still **delivered**. Three web E2E specs
caught what 1,179 unit tests could not.

So, after watching a test fail, ask the second question:

> **If this assertion held and the feature were still broken, how would that look?** If you can
> describe that state, the assertion is measuring the wrong thing.

The general form: prefer asserting an **observable outcome** ("a later state update re-renders the
line") over a **configuration detail** ("the option was passed"). Configuration is a means; when a
test pins the means, the means can be satisfied while the end is not.

## When a spec fails: fix the code, or fix the spec?

Both answers were correct in the same session, so the discriminator matters more than either
instance:

> **Does the spec still describe intended behaviour?**

- **Yes → fix the CODE.** `open Dune in Favorites` returned *"Where should I look for 'Dune in
  Favorites'?"* because the scope parser only accepted the qualified form (`… in my Favorites
  collection`). Rewording the spec to add "collection" would have been fixing the test to match the
  code — the failure mode this repository names explicitly. The parser was fixed instead, matching
  the trailing phrase against the member's REAL collection names so `"Dune in 2013"` and
  `"The Man in the High Castle"` cannot be mistaken for a scope.
- **No → fix the SPEC.** An add spec waited for the approval card immediately after the request.
  047 US4 deliberately inserted the ownership question chain before the proposal is built, so the
  old expectation was stale, not violated. The spec now answers the question.

The trap is that both look identical from the failure output — a red test and a plausible one-line
change either way. Deciding by "which is quicker to edit" is how a spec quietly stops describing
the product.
