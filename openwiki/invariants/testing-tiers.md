---
type: Convention
title: Testing tiers and what gates a merge
description: The unit / integration / golden / E2E test tiers used across mc-service, mcm-app, and the agent gateway, and which of them actually block a merge in CI versus which are informational.
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

## The golden tier is a MARKER, not a directory

This is the trap most likely to cost the next person a session. The golden tier is entered by
`@pytest.mark.golden` on a test **that lives under `tests/integration/`** — not by where the file
sits:

- `nx test:golden` runs `pytest tests/integration -m golden`.
- `tests/golden/` holds **only** cassettes, `dataset.json` and `compare.py` — no tests, and neither
  selector globs it. **Moving a test into `tests/golden/` makes it run nowhere**, silently: the run
  still exits 0, just with a smaller collection.
- `app-ci`'s agent step selects `-m "not golden"`. The two selectors are therefore complementary and
  exhaustive over `tests/integration/` (measured: 62/113 + 51/113 = 113), so **adding the marker
  enrols a test in the keyless replay gate and deselects it from the live-key job in one change**.

That property is what let feature 048 move the 9 topic-confinement tests off the live model without
touching any workflow: they assert a *model decision*, which is what the golden tier is for, and they
had been erroring `app-ci` whenever the Anthropic balance ran out.

## Where each gate runs

| Gate | Command | Where | Credential |
|---|---|---|---|
| Golden — merge | `LLM_CASSETTE_MODE=replay nx test:golden` | `guardrails.yml` | **none** (cassette replay) |
| Golden — pre-deploy | `nx test:golden-live` | `cd-deploy.yml`, before build/promote/webhook | `ANTHROPIC_API_CD_GOLDEN` |
| Agent integration | `nx test:integration movie-assistant -- -m "not golden"` | `app-ci` `app-e2e` | `ANTHROPIC_API_CI_E2E` |
| MCP integration | `nx test:integration movie-mcp` / `spreadsheet-mcp` | `app-ci` `app-e2e` | none |

Quality gates run **at merge or at deploy, never on a timer** (product-owner constraint): a scheduled
gate can only ever report damage that already shipped. `web-api-mcp` is deliberately not in CI —
unconfirmed TMDB egress plus an unsettled per-user credential question.

## What actually gates CI

**The integration tier gates CI.** The `app-ci` workflow's `app-e2e` job runs `test:integration` for
all three projects (agent, mc-service, mcm-app) with a live-stack requirement flag that **escalates a
skip into a failure**. Before this was added, no project's integration tier ran anywhere in CI — only
a keyless golden subset — and it silently rotted for roughly a month without anyone noticing.

**The full web E2E regression (`pnpm nx e2e mcm-app`) is required for every feature, including
backend-only changes** — a Rust-only or Python-only change is only proven end-to-end by driving it
through the BFF from the client's perspective.

## Which AGENT assertions may block a merge

**An agent assertion may block a merge only if the same code and the same prompt cannot produce a
different verdict on a re-run.**

Stated as a property of the assertion, not of its failure history: a test is not promoted for having
been lucky, nor demoted for having been unlucky.

| Blocks a merge | Does NOT block |
| --- | --- |
| the turn reaches the gateway and a reply renders | which words the model chose |
| the approval gate pauses and resumes | which tool the model selected |
| a chosen option navigates to the right route | how options were ranked |
| a tool call reaches mc-service and persists | whether TMDB returned this title first |
| an error surfaces to the member | whether the model classified an utterance as X |

**Borderline falls into the gate only if the deterministic half can be asserted on its own.**
Splitting a test is expected; guessing is not. Where a model-decision test is the ONLY coverage of a
wiring path, the wiring assertion stays in the gate — split out, not moved wholesale.

### What this costs, said plainly

The gate stops proving that the assistant makes the **right decision**. It proves only that the
machinery around the decision works. That is a real reduction in what a green tick means, and it is
the price of a gate that means something when it is **red**.

### The evidence that forced it

Two `app-ci` runs on **identical code** (sha `1fada7a`), same worker count, same stack:

| run | counts |
| --- | --- |
| #1684 | `failed=0 flaky=0 passed=177 did-not-run=0 skipped=0` |
| #1685 | `failed=1 flaky=7 passed=166 did-not-run=3 skipped=0` |

Every alternative explanation was excluded by a **measured counter**, not by argument: `verdict=healthy`
at 93 gateway posts per 100 tests (not the #173 collapse), `refresh_429=0` and `session_evicted=0`
(not contention), `minted 8 worker identities` (not the shared identity of #169), item #179's gateway
livelock fixed, and zero identity/login/403/fixture errors. All eight affected entries were
model-decision assertions.

A required gate that fails on identical code roughly half the time is not gating. It taxes every pull
request with a coin flip and teaches people to re-run — the habit that hid five stale specs for three
weeks (#150) and caused a sound fix to be reverted on a two-run inference (#166/#173).

### Where the non-blocking ones run

Tagged `@model-decision`, excluded from the pull-request gate by `--grep-invert`, and run as a second
non-blocking selection in the SAME job on pushes to `main` and on `workflow_dispatch`. They keep
running, keep publishing counts through the same bundle channel the gate uses, and cannot silently
stop — a tier that quietly stopped running would read as one that is passing, which is the failure
this arrangement exists to avoid. **Nothing leaves the gate without a tier that runs it** (051 SC-001,
054 FR-017).

## Gotchas

- **A skip is a failure in CI, not a soft pass.** Locally, a missing dependency skips a suite
  cleanly; in CI, an unexpected skip is treated as a broken test harness and fails the job.
  Legitimately-optional skips must be added to an explicit allowlist per suite — never used as a way
  to turn a red run green. Three flags carry this: `MCM_REQUIRE_LIVE_STACK=1` (integration suites,
  incl. both MCP servers), `E2E_REQUIRE_AGENT_STACK=1` (agent E2E), and `MCM_REQUIRE_LIVE_MODEL=1`
  (the pre-deploy golden gate). **Watch the SKIP COUNT** — a skipped suite exits 0 and reads as a pass.
- **A whitelisted skip reason outlives the thing it excused.** `"no cassette"` sat in the agent
  suite's allowlist long after every one of the 41 golden pairs had a cassette, where it could only
  ever mask a future regression. Measure before adding one, and re-measure before keeping it.
- **A missing fixture must fail, not skip.** Under `LLM_CASSETTE_MODE=replay` an absent cassette
  fails the run. It used to skip, so deleting every cassette produced a green golden gate — a gate
  that cannot fail is not a gate.
- **"It can't run in this environment" is a conclusion to distrust.** A credential-driven skip is
  almost always a missing *file*, not a missing *capability*. In 2026-08 the agent integration suite
  produced 38 credential errors and was written off as un-runnable in the dev container; the cause was
  one absent gitignored `frontend/mcm-app/.env.local`, which `gen-dev-env.mjs` skipped silently
  because the file did not exist, and one command fixed it (13 passed / 38 errors → 51 passed / 0
  failed). Before retiring a tier to CI, name the specific missing input and check whether a generator
  or documented command supplies it — see
  [local-dev.md](../../docs/runbooks/local-dev.md) §"A credential-driven skip is a missing file".
- **A skip reason that cannot be acted on is itself a defect.** Every credential skip in this repo
  names the variable, the file it is read from, and the command that fixes it. "Needs the live stack"
  is what got a tier retired by accident; if you meet a message like that, fix the message.
- **A generator that silently no-ops is a gate that skips to green, one layer down.** `syncEnvFile`
  returned early on a missing path and reported success. Same failure mode, different disguise — the
  false conclusion it produced was "unrunnable" rather than "passing".
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
