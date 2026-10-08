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

### D8. Generator bump to 0.7.1 (amendment 2026-10-07; US5 AC4, FR-015)

- The same procedure as D7 (0.5.2 → 0.6.0):
  - side-install `openwiki@0.7.1 mermaid jsdom` under a scratch prefix;
  - point the guard at it with `OPENWIKI_ROOT`, and require **0 skipped**;
  - then move both pins: `.devcontainer/toolchain.Dockerfile:86` and `.forgejo/workflows/wiki-maintain.yml:160`.
- The guard's version assertion (`wiki-maintain.guard.test.mjs:179-180`) changes from `'0.6.0'` to `'0.7.1'`. This is
  an update at the cause: FR-015 now names 0.7.1. Its comment keeps the 0.6.0 history.
- **Read from the unpacked 0.7.1 `dist` (research R15), to be confirmed by the guard:**
  - `MAX_PAGE_CONCURRENCY` is still 8 and `resolvePageConcurrency` still exists;
  - the managed `AGENTS.md`/`CLAUDE.md` snippet text is unchanged from 0.6.0, so the R12 byte-for-byte guard passes
    without editing `AGENTS.md`;
  - `OPENWIKI_REASONING_EFFORT` still throws for `fireworks`, so the tap stays the route for effort (US6 relies on it).
- **One paid probe (~$0.10–0.30, operator approval first)**, the T015e shape:
  - one covered page through `wiki-generate.mjs` on the side install, Fireworks, concurrency 4;
  - run in a **scratch clone**, never the worktree, so the generator's writes cannot reach the branch;
  - pass when the page and its index are written, `okf-lint` is green, `AGENTS.md`/`CLAUDE.md` are untouched, and a
    usage record exists.
- **Behaviour to observe after merge, not assumed:**
  - #913, the worker retry: does a page that used to exit now land, or now take twice as long?
  - #906: is run 4348's "different persisted plan" absorbed?
  - #865: are plans narrower?

  These are recorded with T050's observation.

### D9. Escalate to low reasoning effort after a deadline failure (US6; FR-017–FR-023)

**A new pure module, `scripts/wiki-escalation.mjs`,** with one responsibility: deciding effort and tags. It does no
I/O beyond what it is handed, so it can be tested without a repo fixture. Exports:

| Export | Signature | Rule |
|---|---|---|
| `ESCALATED_EFFORT` | `'low'` | the only escalation step |
| `pageKey` | `(area, page) → 'area/page'` | the tag key; always built from a slice PART's `area` and one page, never from an invocation's display `pages` (those are already `area/page`) |
| `isDeadlineStop` | `(invocation, timeoutMs) → boolean` | `timeoutMs !== null && (status === 124 \|\| status === 137)`; the same condition `executeSlices` already uses to call `revertUnrequested` (FR-017) |
| `splitByEscalation` | `(slices, escalations) → { escalated, normal }` | a slice with no tagged page passes through **unchanged** (identity, so a run with no tags is byte-for-byte today's). A slice whose pages are all tagged moves to `escalated` unchanged. A slice with both kinds is split into two copies, each holding only its pages and their `subjects`; **only these split copies drop `runMessage`**, so `renderRunMessage` re-renders it from the narrowed pages. A carried backlog slice's stored message names every original page, and reusing it would tell the low invocation to write the untagged pages. Order is preserved. |
| `escalationPolicy` | `(env) → { explicit: string\|null, supportsLow: boolean }` | from `resolveWikiProvider(env)`: `explicit` = its `reasoningEffort`; `supportsLow` = the provider row's `reasoningEfforts` includes `'low'`. If resolution throws → `{ explicit: null, supportsLow: false }` (the preflight has already failed the run loudly). |
| `invocationEffort` | `({ explicit, supportsLow }, escalated) → string\|null` | the effort to **override** for one invocation. `null` means "leave the env as it is". Explicit set → `null` (the env already carries it; FR-020). Escalated and `supportsLow` → `'low'`. Otherwise → `null`. |
| `nextEscalations` | `({ prior, outcomes, backlog, pageExists, now }) → escalations` | the new map (rules below) |
| `stillFailing` | `(prior, next) → [{ key, failuresAtLow }]` | the tags whose `failuresAtLow` rose this run; each one gets the flag line |

`nextEscalations` rules. Each **outcome** is `{ parts, ok, landedParts, failedParts, deadlineStop, effortUsed }`, one
per invocation, where `parts` is `partsOf(work)`:
1. Start from a deep copy of `prior` (`{}` if absent). The input is never mutated.
2. For every page in `parts` when `ok`, or in `landedParts` otherwise: delete its tag (FR-021).
3. For every page in `failedParts` (only when not `ok`):
   - if it is already tagged: increment `failuresAtLow` when `effortUsed === 'low'`, otherwise leave it alone. A run
     at an explicit `high` neither resets nor counts.
   - if it is not tagged and `deadlineStop`: set `{ effort: 'low', reason: 'deadline', since: now, failuresAtLow: effortUsed === 'low' ? 1 : 0 }` (FR-017).

   Any other failure leaves the map unchanged for that page (SC-009).
4. Drop any tag whose page is in neither `backlog` (as `pageKey` of each backlog part) nor `pageExists(key)`. A page
   queued for creation keeps its tag.

**Run record** (`scripts/wiki-maintain.mjs`):
- `EMPTY_RECORD` gains `escalations: {}`, so an older record without the field loads as no tags (FR-018).
- `assertRecordShape` rejects an `escalations` that is not a plain object, or an entry without a string `effort`
  and a non-negative integer `failuresAtLow`.
- The backlog is untouched.

**`executeSlices`:**
- New parameter `effortPolicy = escalationPolicy()`.
- Before packing: `const { escalated, normal } = splitByEscalation(queue, runRecord.escalations ?? {})`.
- When `invocationEffort(effortPolicy, true)` is `null` (explicit set, or the provider has no effort), the split is
  **not** applied: every slice is treated as normal, so tags have no effect but are kept (FR-020, AC7).
- Otherwise the run's invocation list is
  `[...packSlices(escalated).map(w => ({ work: w, effort: 'low' })), ...packSlices(normal).map(w => ({ work: w, effort: null }))]`.
  This packs low work separately and runs it first (FR-019). `remainingParts` and the dry-run report iterate this
  list.
- Each invocation calls `invoke(work, { ..., reasoningEffort: effort })`. Its usage is summarised with
  `{ ...usage, reasoningEffort: effort ?? usage?.reasoningEffort ?? null }`, so the usage line and record show the
  effort actually used (FR-022).
- Each result gains `effortUsed` and `deadlineStop`.
- After the loop: `escalations = nextEscalations({ prior: runRecord.escalations, outcomes, backlog, pageExists, now })`,
  where `pageExists = (key) => existsSync(join(bundleDir, key))`. The map is written with the record.
- Every page whose `failuresAtLow` rose gets one `console.error` line:
  `[wiki-maintain] ⚠ escalated to low and still failing (N): area/page — consider parking it (078 US6)`.
  The execute step's log is what the failure bundle captures (its `logs/step:wiki-maintain-execute`), so the
  digest carries it (FR-021).
- No page is dropped or parked (FR-023).

**`defaultInvoke` / `generatorEnv`:**
- `generatorEnv(runMessage, env, { usageLog, reasoningEffort })` sets `MCM_WIKI_REASONING_EFFORT` only when
  `reasoningEffort` is a string.
- `wiki-generate.mjs` already resolves and validates it, and the tap already sends it; no change there.

**`main()`** passes `effortPolicy: escalationPolicy(process.env)` into `executeSlices`.

**Documentation (FR-013):**
- the runbook gains "Escalation after a deadline failure": what tags, what does not, where the map lives, how to
  park (remove the backlog slice **and** its tag), and the flag line;
- `wiki-usage-tap.mjs`'s header loses the claim that the tap is "the only route" for effort (R15, G2).

### Project Structure

```text
specs/078-wiki-generator-cost/   spec.md, research.md, plan.md, tasks.md, checklists/
scripts/
├── wiki-provider.mjs            # NEW  D1 — pure resolution table
├── wiki-generate.mjs            # NEW  D2 — launcher the Nx target runs; --preflight
├── wiki-usage-tap.mjs           # NEW  D3 — inert-unless-configured fetch preload
├── wiki-provider-prices.json    # NEW  D5 — dated price table
├── wiki-maintain.mjs            # EDIT D4/D5 — multi-area slices, usage aggregation, preflight call, budget constants; D9 wiring
├── wiki-escalation.mjs          # NEW  D9 — pure: deadline trigger, split, effort choice, tag map
└── __tests__/
    ├── wiki-escalation.test.mjs     # NEW  D9 — trigger table (SC-009), split, policy, tag rules
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
