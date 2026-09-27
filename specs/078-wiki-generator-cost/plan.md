# Implementation Plan: Cheaper wiki maintenance — Fireworks provider, fewer planning passes, a measured time budget

**Branch**: `078-wiki-generator-cost` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/078-wiki-generator-cost/spec.md`; measurements in [research.md](research.md)

## Summary

Make the wiki job's generator provider a configuration choice (Anthropic Sonnet 5 | Fireworks DeepSeek V4.1
Flash), resolved by one small repo-owned launcher that the `wiki-update` Nx target runs instead of calling
`openwiki` from a shell string. The launcher maps the right credential at the point of use, sets the explicit
output cap for every provider, preflights the model, and loads a repo-owned fetch preload that (a) adds
`service_tier` for Fireworks when configured and (b) records per-call usage. `wiki-maintain.mjs` then plans
**multi-area slices** so a run plans once rather than once per area, aggregates the usage into the run record, and
runs under a page/time budget derived from measurement. The CI default flips to Fireworks only after the budget
decision record exists (FR-002).

## Technical Context

**Language/Version**: Node 24 ESM scripts (`scripts/*.mjs`), `node --test` suites in `scripts/__tests__/`
**Primary Dependencies**: `openwiki@0.6.0` (upgraded from 0.5.2 — D7; pinned in the toolchain image and the CI job), `nx@22.7.8`
**Storage**: `openwiki/.maintenance-state.json` (committed run record; shape extended, old shape still read)
**Testing**: `node --test "scripts/__tests__/wiki-*.test.mjs"` (glob, flags BEFORE the path — the
`--test-name-pattern` trap in CLAUDE.md), `pnpm nx okf-lint` / `okf-governance` for bundle gates; paid probes
through the R0 harness only where a task says so
**Target Platform**: Forgejo Actions `wiki-maintain.yml` (single capacity-1 runner) and the dev container
**Project Type**: repository tooling (no deployable unit changes)
**Performance Goals**: the time budget is a decision output of Phase 0 (below), not an input
**Constraints**: the CI runner is shared with `app-e2e` (~35 min); credentials never in argv/logs/image; output is
always a proposal PR, never auto-merged
**Scale/Scope**: ~69 concept pages; typical run 1–8 pages; #525 sweep ~57 pages (held until this lands)

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. No violations.*

| Principle | Assessment |
|---|---|
| **TDD (NON-NEGOTIABLE)** | PASS. Every behaviour change (provider resolution, credential mapping, preload inertness, multi-area slicing, multi-area verification, usage aggregation, Fireworks cap guard, workflow secret allowlist) gets a `node --test` case written and verified RED first; `tasks.md` carries Verify RED / Verify GREEN commands per the template. |
| **Test Type Integrity** | PASS. The new unit tests are pure (no network). The preflight is a genuine live call, gated so a missing credential FAILS (the 075 R13 lesson), and runs in the job rather than in the offline suite. |
| **AI Assistant Constraints** | PASS. The Anthropic key rule is untouched; the Fireworks key follows the same point-of-use mapping (`MCM_FIREWORKS_API_KEY` → `FIREWORKS_API_KEY`). Nothing sets `ANTHROPIC_API_KEY` in any environment. |
| **Security — secrets** | PASS. New secret `FIREWORKS_API_WIKI_MAINTAIN` is scoped to the wiki job only; the guard test's secret allowlist gains exactly that name. The preload records counts and timings, never prompts, file content or headers. |
| **Model-provider scoping invariant** | PASS with a required doc update (FR-013). The wiki becomes provider-configurable independently of the agent gateway; the gateway is untouched. |
| **Nx as universal task runner** | PASS. The generator is still reached only through `nx wiki-update`; the launcher is what that target runs. No new target. |
| **Logging & Monitoring** | ADVANCED. Per-invocation usage and estimated cost reach the job log and the run record (Story 4). |

**Post-Phase-1 re-evaluation**: no violations. One scope note recorded rather than absorbed: the launcher replaces
the target's shell-string command, which also removes the `WIKI_RUN_MESSAGE`-inside-quotes workaround (the message
becomes an argv element passed with `spawn`, never through `sh -c`). The existing "invoked through the Nx target"
and "identical entry point" parity guards are kept and extended, not relaxed.

## Phase 0 — Research (done: [research.md](research.md))

R0–R7 are measured. Two decisions remain that the spec requires be taken from data, not assumed:

1. **Tier (FR-009)** — standard vs priority, from R3's timed priority run.
2. **Budget and timeout (FR-008)** — from a measured **multi-page** invocation on the chosen provider/tier
   (R3 measured one page per invocation; with multi-area slices the planner is paid once and page workers
   dominate). Task T030 measures a 4-page, 2-area invocation and records the per-page slope and fixed planning
   cost; the decision record in `research.md` §R9 then sets `PAGE_BUDGET`, `TIME_BUDGET_SECONDS`,
   `MAX_PAGES_PER_SLICE` and `timeout-minutes`, and states the runner-minutes committed.

**Generator upgrade to 0.6.0 — in scope (operator decision 2026-09-27).** See research R8 and D7. The budget
measurement (T027) is taken on 0.6.0 at the chosen concurrency, since that is what CI will run.

## Phase 1 — Design

### D1. Provider configuration — `scripts/wiki-provider.mjs` (new, pure)

`resolveWikiProvider(env)` → `{ provider, openwikiProvider, modelId, maxOutputTokens, tier, credential: { from,
to } }`, selected by **`MCM_WIKI_PROVIDER`** ∈ `anthropic | fireworks` (unset → the default, which is
`anthropic` until the FR-002 flip). Unknown value → throw (a mis-typed selector must never mean "the other
provider" — the rejecting-parser rule in CLAUDE.md). The table is the single source for model ids and caps:

| provider | OPENWIKI_PROVIDER | OPENWIKI_MODEL_ID | cap | credential (first non-empty) → mapped to |
|---|---|---|---|---|
| anthropic | `anthropic` | `claude-sonnet-5` | 16384 | `ANTHROPIC_API_KEY`, `MCM_ANTHROPIC_API_KEY` → `ANTHROPIC_API_KEY` |
| fireworks | `fireworks` | `accounts/fireworks/models/deepseek-v4p1-flash` | 16384 | `FIREWORKS_API_KEY`, `MCM_FIREWORKS_API_KEY` → `FIREWORKS_API_KEY` |

`MCM_WIKI_SERVICE_TIER` (`priority` | unset) applies to fireworks only; set for anthropic → throw.

### D2. Launcher — `scripts/wiki-generate.mjs` (new), run by the `wiki-update` target

- Target `command` becomes `node scripts/wiki-generate.mjs`; the target's `env` keeps only
  `OPENWIKI_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1` and the heap flag — **no provider or model** there (R4: the
  target's env would overwrite the job's choice).
- Resolves D1, maps the credential (fails naming BOTH accepted names when absent — FR-006), sets
  `OPENWIKI_PROVIDER` / `OPENWIKI_MODEL_ID` / `OPENWIKI_MAX_OUTPUT_TOKENS`, appends
  `--import=<repo>/scripts/wiki-usage-tap.mjs` to `NODE_OPTIONS`, and spawns
  `openwiki code --update --print [message]` with the message from `WIKI_RUN_MESSAGE` as **one argv element**.
- `--preflight`: one minimal completion against the resolved model with the resolved tier; non-2xx or missing
  credential → exit non-zero with the provider's error type (never the key). `wiki-maintain --execute` runs it once
  before the first slice (FR-005).

### D3. Usage preload — `scripts/wiki-usage-tap.mjs` (new; R0 promoted)

- Inert unless `WIKI_USAGE_LOG` is set: then it tees Anthropic `/v1/messages` and `/chat/completions` responses
  and appends `{kind, status, ms, uncached, cached, cacheWrite, output, reasoning}` per call.
- When `MCM_WIKI_SERVICE_TIER` is set and the URL is Fireworks chat-completions, it sets `service_tier` on the
  JSON body — and changes nothing else. Guard test: with both unset, the request object passed to the real fetch is
  identity-equal to the caller's; with the tier set, the parsed body differs from the original in exactly one key.
- Never throws into the generator: a tap failure writes `{tapError}` and the response is returned untouched.

### D4. Multi-area slices — `planSlices`, `renderRunMessage`, `verifySlice` in `scripts/wiki-maintain.mjs`

- A slice becomes `{ parts: [{ area, pages, areaExists, subjects }], kind, reason }`, packed greedily up to
  `MAX_PAGES_PER_SLICE` pages **across** areas (refreshes and creations still separated by kind).
- `renderRunMessage` lists every part's pages and index, and the boundary sentence names every listed area
  ("Do not write anywhere else: no directory of openwiki/ other than …").
- `verifySlice` checks missing pages per part and allows index writes only in listed areas; policy and OKF checks
  are unchanged. A write to an unlisted area is a violation exactly as today (FR-007, Story 2 scenario 2).
- Backward compatibility: `assertRecordShape` accepts the old `{area, pages}` slice and normalises it to one part,
  so the committed backlog in `openwiki/.maintenance-state.json` keeps working (no migration step).
- On a failed multi-area slice, landed pages stay and the unlanded pages are re-queued **per part** (a later
  failure narrows rather than repeating the whole combination).

### D5. Usage in the run record — `executeSlices`, `writeRunRecord`

Each slice gets a fresh `WIKI_USAGE_LOG`; after the invocation, aggregate to `{provider, model, tier, calls,
uncached, cached, cacheWrite, output, ms, estCostUsd}` using `scripts/wiki-provider-prices.json` (dated table,
operator-supplied figures). Written to `lastRunUsage` in the run record and printed to the job log. Capture
failure → `usage: "not captured"`, never zeros (FR-010, SC-005).

### D6. CI wiring — `.forgejo/workflows/wiki-maintain.yml`

- Job env: `MCM_WIKI_PROVIDER: ${{ vars.MCM_WIKI_PROVIDER || 'anthropic' }}`, `MCM_WIKI_SERVICE_TIER:
  ${{ vars.MCM_WIKI_SERVICE_TIER }}`, `FIREWORKS_API_KEY: ${{ secrets.FIREWORKS_API_WIKI_MAINTAIN }}` alongside
  the existing Anthropic secret. Flipping the default to `fireworks` is a separate one-line commit after the R9
  decision (FR-002). Whether this Forgejo version resolves `vars` is verified in T004 before relying on it; the
  fallback is the literal default in the workflow.
- `timeout-minutes` set from R9. CI runner egress to `api.fireworks.ai` verified by the preflight's first real run.

### D7. Generator upgrade and page concurrency

- Pin `openwiki@0.6.0` in `.devcontainer/toolchain.Dockerfile` and `.forgejo/workflows/wiki-maintain.yml` (the
  guard's pin-agreement test enforces both). The dev-container image picks it up on its next refresh; until then,
  local runs and the guard's installed-generator assertions use a side install selected by `OPENWIKI_ROOT`
  (the guard's hard-coded `/usr/local/lib/node_modules/openwiki` becomes the default, not the only value).
- `resolveWikiProvider` gains `pageConcurrency` from `MCM_WIKI_PAGE_CONCURRENCY` (integer 1–8, validated with the
  same rule as openwiki's `resolvePageConcurrency`, so a bad value fails in our launcher before any paid call);
  the launcher exports it as `OPENWIKI_PAGE_CONCURRENCY`. Default 1 until R9 records the chosen value.
- The installed-generator guard checks gain: `resolvePageConcurrency` still exists and still caps at 8, and the
  Anthropic cap resolver is still found (in 0.6.0 it lives in `dist/agent/index.js`, where the guard already looks).
- Rate limits under concurrency: 0.6.0 raises provider retries to 5 when concurrency > 1 unless
  `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` is set; we leave it unset and record retries seen in the usage log (a
  non-200 status per call).

### Project Structure

```text
specs/078-wiki-generator-cost/   spec.md, research.md, plan.md, tasks.md, checklists/
scripts/
├── wiki-provider.mjs            # NEW  D1 — pure resolution table
├── wiki-generate.mjs            # NEW  D2 — launcher the Nx target runs; --preflight
├── wiki-usage-tap.mjs           # NEW  D3 — inert-unless-configured fetch preload
├── wiki-provider-prices.json    # NEW  D5 — dated price table
├── wiki-maintain.mjs            # EDIT D4/D5 — multi-area slices, usage aggregation, preflight call, budget constants
└── __tests__/
    ├── wiki-provider.test.mjs       # NEW
    ├── wiki-usage-tap.test.mjs      # NEW
    ├── wiki-maintain.test.mjs       # EDIT  multi-area plan/render/verify, record back-compat, usage
    └── wiki-maintain.guard.test.mjs # EDIT  Fireworks cap assertion, secret allowlist, target command
infrastructure-as-code/project.json  # EDIT wiki-update command/env
.forgejo/workflows/wiki-maintain.yml # EDIT D6, D7 pin
.devcontainer/toolchain.Dockerfile   # EDIT D7 pin
docs/runbooks/wiki-maintenance.md    # EDIT FR-013
openwiki/invariants/model-provider-scoping.md  # EDIT FR-013 (canonical concept)
docs/proposals/MCM-LLM-Cost-Analysis-1.md      # EDIT FR-013 §5
```

## Complexity Tracking

| Addition | Why needed | Simpler alternative rejected because |
|---|---|---|
| A launcher instead of the shell-string command | R4: the target's env overwrites the job's; the provider must be resolved in-process | A shell `${VAR:-default}` in the command string would work for the provider but not for credential mapping, preflight or the preload, and re-opens the quoting trap the current command documents |
| A fetch preload in the generator process | R6: `openwiki@0.5.2` cannot send `service_tier` or report usage | Patching `node_modules` is invisible and lost on install; waiting for upstream blocks the feature |
