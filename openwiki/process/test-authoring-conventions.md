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
