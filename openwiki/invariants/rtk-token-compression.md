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

  Pin a specific version (current: `rtk 0.42.4`). The binary lives at `~/.claude/tools/bin/rtk` and is
  provisioned with the dev container — it is **not** a cargo install, and `~/.cargo/bin/rtk` does not
  exist. Verify with `rtk --version`; a session must not begin without RTK active.

## Gotchas

- **A session must not begin without RTK active.** This is a hard prerequisite, not a suggestion —
  the binary ships with the dev container at `~/.claude/tools/bin/rtk`, pin the version currently in use
  (`rtk 0.42.4`), and run `rtk init --global` to activate it in the shell before any test command is run.
- **`rtk gain` is the verification step, not a one-time install check.** Run it after the first test
  run of a session to confirm compression is actually happening (>80% required) — installed-but-inactive
  is indistinguishable from not-installed until this is checked.
- **RTK's compression changes what CI monitoring output looks like.** It compresses jest output down
  to a `PASS (n) FAIL (n)` summary line, so a monitoring script that greps for a phrase like
  `"n passed"` in raw test output will silently mis-count against the compressed form. Monitor by
  exit code or a structured status value, never by grepping a summary line assumed to be in
  uncompressed form.
- **A negative `grep` result is only trustworthy if the file carries no NUL byte.** GNU grep classifies
  any file containing a NUL as *binary*: it suppresses the matching **lines**, writes
  `<file>: binary file matches` to **stderr**, and exits **0**. RTK drops that stderr notice and reports
  exit **1** — byte-for-byte indistinguishable from a genuine "no matches". Measured 2026-09-14 (item
  #448): `grep -n "pip" scripts/sast-scan.mjs` printed nothing while the pattern occurred 28 times, which
  had already produced the wrong conclusion "pip-audit is not invoked here" during feature 071. The
  cheap cross-check is **`grep -c`**, which still reports the true count, or `/usr/bin/grep` directly,
  whose stderr notice survives. The trigger is removed at source and kept out by
  `scripts/__tests__/grep-nul-binary-trap.test.mjs`, which fails if any tracked *text* file contains a
  NUL — so write a NUL sentinel as the `\u0000` escape, never as a raw byte.
- **`rtk gain` is also the last item on the [feature validation checklist](/openwiki/invariants/feature-validation-checklist.md)**, run after every other check specifically because it measures the token cost of the runs that preceded it.

See [Feature validation checklist](/openwiki/invariants/feature-validation-checklist.md) for where
`rtk gain` fits in the full pre-completion sequence, and
[Testing tiers and what gates a merge](/openwiki/invariants/testing-tiers.md) for the test runs whose
output RTK is compressing.
