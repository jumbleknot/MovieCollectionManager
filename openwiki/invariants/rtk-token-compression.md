---
type: Convention
title: RTK (Rust Token Killer) token compression
description: RTK is a mandatory transparent CLI proxy that compresses test-command output before it reaches the agent's context window; it must be active before any AI-assisted session begins and is verified with rtk gain reporting above 80 percent compression.
tags: [rtk, tooling, testing, context-window, prerequisite]
timestamp: 2026-07-30T13:00:00+00:00
---

# RTK (Rust Token Killer) token compression

RTK is a mandatory transparent CLI proxy that compresses test-command output reaching the agent's
context, preserving the context window for reasoning. Without it, a full test run's raw output can
consume enough of an AI assistant's context window that little room is left for the reasoning the
session actually needs. RTK sits in front of test commands and shrinks that output before it ever
reaches the assistant.

## Prerequisites (mandatory before starting any AI-assisted session)

- **RTK (Rust Token Killer)** must be installed and active. It compresses test-command output reaching the agent context, preserving the context window for reasoning.

  ```bash
  rtk init --global   # activate in this shell
  rtk gain            # verify >80% compression after the first test run
  ```

  Pin a specific version (current: `rtk 0.40.0`); installed via cargo (`~/.cargo/bin/rtk`). A session must not begin without RTK active.

## Gotchas

- **A session must not begin without RTK active.** This is a hard prerequisite, not a suggestion —
  install via cargo (`~/.cargo/bin/rtk`), pin the version currently in use (`rtk 0.40.0`), and run
  `rtk init --global` to activate it in the shell before any test command is run.
- **`rtk gain` is the verification step, not a one-time install check.** Run it after the first test
  run of a session to confirm compression is actually happening (>80% required) — installed-but-inactive
  is indistinguishable from not-installed until this is checked.
- **RTK's compression changes what CI monitoring output looks like.** It compresses jest output down
  to a `PASS (n) FAIL (n)` summary line, so a monitoring script that greps for a phrase like
  `"n passed"` in raw test output will silently mis-count against the compressed form. Monitor by
  exit code or a structured status value, never by grepping a summary line assumed to be in
  uncompressed form.
- **`rtk gain` is also the last item on the [feature validation checklist](/openwiki/invariants/feature-validation-checklist.md)**, run after every other check specifically because it measures the token cost of the runs that preceded it.

See [Feature validation checklist](/openwiki/invariants/feature-validation-checklist.md) for where
`rtk gain` fits in the full pre-completion sequence, and
[Testing tiers and what gates a merge](/openwiki/invariants/testing-tiers.md) for the test runs whose
output RTK is compressing.
