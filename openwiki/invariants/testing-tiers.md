---
type: Convention
title: Testing tiers and what gates a merge
description: The unit / integration / golden / E2E test tiers used across mc-service, mcm-app, and the agent gateway, and which of them actually block a merge in CI versus which are informational.
resource: CLAUDE.md
tags: [testing, tdd, ci, gates]
timestamp: 2026-07-26T20:11:56+00:00
---

# Testing tiers and what gates a merge

TDD is mandatory across the repo (tests written → approved → red → implementation → green →
refactor). Below that policy, each project exposes the same four Nx-invoked tiers with
project-specific meaning:

| Tier | mc-service | mcm-app | Agent Gateway |
|---|---|---|---|
| **Unit** | inline `#[cfg(test)]` modules, bottom of the tested file | Jest, ≥70% line coverage enforced | `pytest tests/unit` |
| **Integration** | `tests/integration/`, requires MongoDB | requires Keycloak + Redis running | `pytest tests/integration`, requires live stack |
| **Golden** | — | — | `pytest tests/integration -m golden` — cassette-recorded LLM behavior |
| **E2E** | exercised indirectly via mcm-app E2E | Playwright (web) + Maestro (mobile) | mobile agent flows via Maestro |

All tiers run through Nx (`pnpm nx test <project>`, `pnpm nx test:integration <project>`) — see
[Nx as the task runner](/openwiki/invariants/nx-task-runner.md) for why direct tool invocation is
discouraged.

## What actually gates CI

**The integration tier gates CI.** The `app-ci` workflow's `app-e2e` job runs `test:integration` for
all three projects (agent, mc-service, mcm-app) with a live-stack requirement flag that **escalates a
skip into a failure**. Before this was added, no project's integration tier ran anywhere in CI — only
a keyless golden subset — and it silently rotted for roughly a month without anyone noticing.

**The full web E2E regression (`pnpm nx e2e mcm-app`) is required for every feature, including
backend-only changes** — a Rust-only or Python-only change is only proven end-to-end by driving it
through the BFF from the client's perspective.

## Gotchas

- **A skip is a failure in CI, not a soft pass.** Locally, a missing dependency skips a suite
  cleanly; in CI, an unexpected skip is treated as a broken test harness and fails the job.
  Legitimately-optional skips must be added to an explicit allowlist per suite — never used as a way
  to turn a red run green.
- **Agent/MCP images are rebuilt on every CI run, not reused.** Before this was enforced, CI could
  test whatever image happened to be cached on the runner — an `agents/**` or `mcp-servers/**` change
  could go untested against its own code.
- **If a deployed service/BFF container was changed, rebuild + redeploy it before the E2E run** — the
  E2E suite otherwise validates a stale image and reports false confidence.
- **Golden tests are the model-cost-bearing surface.** All intent mapping, dedup, and resolution logic
  is pure code and unit/property tested at zero model cost; only actual model *decisions* (intent
  classification, phrasing) are exercised by the golden cassette suite, keeping the expensive tier
  small and stable. See [Model-provider scoping](/openwiki/invariants/model-provider-scoping.md) for
  why golden cassettes are recorded against Claude specifically.
- **Nx target caching differs by tier**: `test` is cached, `test:integration` is explicitly
  uncached (`nx.json` `targetDefaults`) because it depends on live external state that Nx cannot see.

Full CI-enforcement rationale and evidence that the gate genuinely catches regressions:
`specs/041-integration-test-ci-enforcement/SC-003-SC-004-EVIDENCE.md`; day-to-day test-run ordering
and the mandatory final validation checklist live in `CLAUDE.md`'s Test Run Protocol section.
