# Tasks: 078 — cheaper wiki maintenance

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)
**Format**: per `docs/templates/feature-test-tasks-template.md` — every test task is verified RED before its paired
implementation task is verified GREEN.

**Command rule for every Verify step**: node's flags go BEFORE the path. `node --test <file> --test-name-pattern x`
silently runs everything (CLAUDE.md, instrument checks). Always check the reported test COUNT, not only the exit
code — a pattern that matches nothing exits 0.

**Merges** (per `openwiki/process/pull-request-batching.md` — batch by default):
- **Merge A** (T001–T026): all code, with the default provider still `anthropic`. Behaviour on `main` is
  unchanged except that runs plan fewer times and record usage.
- **Merge B** (T027–T034): the R9 measurement and decision record, the budget/timeout constants, and the flip of the
  CI default to Fireworks.

**Operator actions** (cannot be done from a session): create the Forgejo Actions secret
`FIREWORKS_API_WIKI_MAINTAIN` (before T033); set the repository variable `MCM_WIKI_PROVIDER` if T004 shows `vars`
resolves on this forge.

## Status (2026-09-27)

Merge A implemented on `078-wiki-generator-cost`: T001 (baseline 86 → 145 passed, 0 skipped), T002, T003,
T004 (R10), T005–T015d, T016–T022, T024, T025 done; T015e (research R12, R13 — found and fixed the AGENTS.md blocker) and T026 (preflight 27/27) done. Deviations from the plan are recorded in research R11 — notably the backlog shape is unchanged,
so T019 holds by construction. T023 and Phase 6 follow merge.

**Merge A merged as #593 (2026-09-27). Merge B (2026-09-28):** T027 measured (research R9), T028 signed off by the
operator ("~8 pages per run, timeout 60"), T029–T031 implemented with the derived-timeout guard, T033 flips the CI
default in the workflow; added: the wiki job verifies the installed generator and fails on a skip. T032 (upstream
request) and T034 (score ≥ 10 real runs, SC-005 reconciliation) remain.

**2026-10-07:** T034 scored 45 real runs (research R14). SC-001 and SC-003 are met. SC-002 is **not met**: 53%
of runs completed against Sonnet's 98%. SC-004 is not met over the window (3 kills before #626) but has held
since. SC-005 waits on the operator's bill figure (T023). T032 is drafted, not filed. Feature stays open pending
the operator's SC-002 decision.

---

## Phase 1 — Setup

### T001 — Confirm the baseline suites are green and count them
**Type**: Setup | **Risk**: None
```bash
node --test "scripts/__tests__/wiki-*.test.mjs" 2>&1 | tail -8
```
Record the pass count; every later GREEN step must show this count plus the new tests, with 0 skipped.

### T002 — Carry the R0 instrument figures into research.md
**Type**: Docs | **Risk**: None
DONE 2026-09-27 — R3 priority row filled; tier decision: standard (no measured speed gain, +25% cost).
duration. No code.

### T003 — Test: the wiki job's secret allowlist admits exactly the new Fireworks secret
**Type**: Test | **Risk**: Low | **Spec**: FR-003 | **File**: `scripts/__tests__/wiki-maintain.guard.test.mjs`
Extend the existing allowlist test: `FIREWORKS_API_WIKI_MAINTAIN` is referenced by `wiki-maintain.yml`, is in the
allowed set, and no other new secret is.
**Verify RED**: `node --test --test-name-pattern "secret" scripts/__tests__/wiki-maintain.guard.test.mjs`
**Expected RED**: 1 failing — the workflow does not reference `FIREWORKS_API_WIKI_MAINTAIN`.

### T004 — Probe whether this Forgejo resolves `${{ vars.* }}`
**Type**: Research | **Risk**: Low
Read the forge version's Actions docs / a throwaway workflow on a scratch branch (never `main`). Record the answer
in research.md §R10. If `vars` does not resolve, D6 uses a literal default in the workflow and the switch becomes a
one-line commit.

---

## Phase 2 — US1: provider is configuration (P1)

### T005 — Test: provider resolution table
**Type**: Test (new file) | **Risk**: Low | **Spec**: US1-AC1/AC2, FR-001, FR-004
**File**: `scripts/__tests__/wiki-provider.test.mjs`
Cases: unset → anthropic/`claude-sonnet-5`/16384; `fireworks` → `fireworks`/`accounts/fireworks/models/deepseek-v4p1-flash`/16384;
unknown value throws naming the accepted values; `MCM_WIKI_SERVICE_TIER=priority` with anthropic throws; every row
has an explicit numeric cap ≥ 16384.
**Verify RED**: `node --test scripts/__tests__/wiki-provider.test.mjs`
**Expected RED**: fails to import `../wiki-provider.mjs` (module not found).

### T006 — Implement `scripts/wiki-provider.mjs`
**Type**: Implementation | **Prerequisite**: T005 RED
Pure `resolveWikiProvider(env)` per plan D1.
**Verify GREEN**: same command — all cases pass, 0 skipped.

### T007 — Test: credential mapping at the point of use, and a loud failure when absent
**Type**: Test | **Risk**: Medium | **Spec**: US1-AC3, FR-003, FR-006 | **File**: `wiki-provider.test.mjs`
`buildGeneratorEnv(env)`: fireworks + only `MCM_FIREWORKS_API_KEY` → child env has `FIREWORKS_API_KEY` set and no
`ANTHROPIC_API_KEY`; anthropic + only `MCM_ANTHROPIC_API_KEY` → `ANTHROPIC_API_KEY` mapped (today's behaviour);
neither credential → throws a message naming both accepted names and containing no value.
**Verify RED**: `node --test --test-name-pattern "credential" scripts/__tests__/wiki-provider.test.mjs`
**Expected RED**: `buildGeneratorEnv` is not a function.

### T008 — Implement credential mapping
**Type**: Implementation | **Prerequisite**: T007 RED
Make `wiki-maintain.mjs`'s `CREDENTIAL_ENV_NAMES` provider-aware by delegating to D1 (the Anthropic list is kept
verbatim for the anthropic row — item #209's lesson).
**Verify GREEN**: same command, then the whole `wiki-provider` + `wiki-maintain` suites.

### T009 — Test: the Fireworks cap guard
**Type**: Test | **Risk**: Low | **Spec**: FR-004 | **File**: `wiki-maintain.guard.test.mjs`
For every provider row, the resolved `OPENWIKI_MAX_OUTPUT_TOKENS` is explicit and ≥ 16384, and reaches the child
env. The existing Anthropic assertions are NOT modified (FR-004 forbids relaxing them).
**Verify RED**: `node --test --test-name-pattern "cap" scripts/__tests__/wiki-maintain.guard.test.mjs`
**Expected RED**: the Fireworks row assertion fails (no launcher sets the cap yet).

### T010 — Test: the usage preload is inert unless configured, and changes only `service_tier`
**Type**: Test (new file) | **Risk**: Medium | **Spec**: FR-009, FR-010, FR-011
**File**: `scripts/__tests__/wiki-usage-tap.test.mjs`
With a stub `fetch`: (a) nothing set → the stub receives the caller's exact `init` object and no file is written;
(b) `WIKI_USAGE_LOG` set → one JSONL line per call with counts/timing only (assert no key named `messages`,
`content`, `authorization`); (c) `MCM_WIKI_SERVICE_TIER=priority` on a Fireworks URL → body differs from the
original in exactly one key; on an Anthropic URL → unchanged; (d) a malformed response body → `{tapError}` line and
the response returned unchanged.
**Verify RED**: `node --test scripts/__tests__/wiki-usage-tap.test.mjs`
**Expected RED**: module not found.

### T011 — Implement `scripts/wiki-usage-tap.mjs`
**Type**: Implementation | **Prerequisite**: T010 RED
Per plan D3 (the R0 instrument, reduced to counts + the tier injection).
**Verify GREEN**: same command.

### T012 — Test: the launcher and the Nx target
**Type**: Test | **Risk**: Medium | **Spec**: US1-AC1, US1-AC4, FR-005 | **File**: `wiki-maintain.guard.test.mjs`
The `wiki-update` target's command is `node scripts/wiki-generate.mjs`; its `env` contains NO `OPENWIKI_PROVIDER`
or `OPENWIKI_MODEL_ID` (R4 — the target env would overwrite the job's choice); the launcher passes the run message
as a single argv element (spawn with a message containing spaces and quotes; assert argv length). The existing
"local parity" tests stay unmodified and green.
**Verify RED**: `node --test --test-name-pattern "launcher|target" scripts/__tests__/wiki-maintain.guard.test.mjs`
**Expected RED**: the target still runs the shell-string command.

### T013 — Implement `scripts/wiki-generate.mjs` and repoint the target
**Type**: Implementation | **Prerequisite**: T009, T012 RED
Per plan D2, including `--preflight`. Update the target's `description` (the output-cap history stays).
**Verify GREEN**: T009 and T012 commands, then `node --test "scripts/__tests__/wiki-*.test.mjs"` — count = T001 + new.

### T014 — Preflight before paid work
**Type**: Test + Implementation | **Risk**: Medium | **Spec**: FR-005, Edge "model withdrawn"
Test (RED first) that `runMaintenance --execute` calls the preflight once before the first slice and stops with a
non-zero exit when it fails, without invoking any slice. Then implement.
**Verify**: `node --test --test-name-pattern "preflight" scripts/__tests__/wiki-maintain.test.mjs`

### T015 — Live check of both providers from the dev container (paid, ~$0.01)
**Type**: Manual verification | **Risk**: Low
```bash
MCM_WIKI_PROVIDER=anthropic node scripts/wiki-generate.mjs --preflight; echo "exit=$?"
MCM_WIKI_PROVIDER=fireworks node scripts/wiki-generate.mjs --preflight; echo "exit=$?"
MCM_WIKI_PROVIDER=fireworks MCM_WIKI_SERVICE_TIER=priority node scripts/wiki-generate.mjs --preflight; echo "exit=$?"
env -u MCM_FIREWORKS_API_KEY MCM_WIKI_PROVIDER=fireworks node scripts/wiki-generate.mjs --preflight; echo "exit=$?"  # must be non-zero
```

---

## Phase 2b — US5: generator 0.6.0 and parallel pages (P2)

### T015a — Side-install `openwiki@0.6.0` for local verification
**Type**: Setup | **Risk**: None
`npm install -g --prefix <scratchpad>/ow060 openwiki@0.6.0 mermaid jsdom` — never over the container's global
0.5.2, which other sessions in this container use until the image refreshes. Every later local run and the guard's
installed-generator assertions select it with `OPENWIKI_ROOT=<prefix>/lib/node_modules/openwiki` and the prefix's
`bin` first on `PATH`.

### T015b — Test: the pin is 0.6.0 everywhere, and the guard can target a side install
**Type**: Test | **Risk**: Low | **Spec**: FR-015 | **File**: `wiki-maintain.guard.test.mjs`
The pin-agreement test expects `0.6.0` in both the toolchain Dockerfile and the workflow; `OPENWIKI_ROOT` from the
environment overrides the default install path; with it set to the side install, the installed-generator
assertions run (count them — they must NOT skip) and pass: cap resolver found, `resolvePageConcurrency` exists,
`MAX_PAGE_CONCURRENCY` is 8.
**Verify RED**: `node --test --test-name-pattern "pin|installed" scripts/__tests__/wiki-maintain.guard.test.mjs`
**Expected RED**: the pin assertion reads `0.5.2`.

### T015c — Bump the pins and make the guard's install path overridable
**Type**: Implementation | **Prerequisite**: T015b RED
`.devcontainer/toolchain.Dockerfile` and `wiki-maintain.yml` → `openwiki@0.6.0`; guard's `OPENWIKI_ROOT` =
`process.env.OPENWIKI_ROOT ?? '/usr/local/lib/node_modules/openwiki'`.
**Verify GREEN**: T015b command with `OPENWIKI_ROOT` set to the side install — pass count includes the
installed-generator assertions, 0 skipped.

### T015d — Test + implement: page concurrency is configuration, validated before paid work
**Type**: Test + Implementation | **Spec**: FR-016, US5-AC1 | **File**: `wiki-provider.test.mjs`
RED first: `MCM_WIKI_PAGE_CONCURRENCY` unset → 1; `4` → 4 and exported as `OPENWIKI_PAGE_CONCURRENCY`; `0`, `9`,
`2.5`, `x` → throw naming the 1–8 range. Then implement in `wiki-provider.mjs` / `wiki-generate.mjs`.
**Verify**: `node --test --test-name-pattern "concurrency" scripts/__tests__/wiki-provider.test.mjs`

### T015e — Regression run on 0.6.0 at concurrency 1 (paid, ~$0.10)
**Type**: Verification | **Spec**: US5-AC3
One-page probe of `runbooks/android-emulator.md` on the side install, Fireworks, concurrency 1, through
`wiki-generate.mjs`: page + index written, Claims submitted, `okf-lint` green, usage record present; front matter and
sidecar shape compared with the 0.5.2 probe output (no new fields beyond R8's list).

---

## Phase 3 — US2: plan once per run (P2)

### T016 — Test: slices pack pages across areas
**Type**: Test | **Risk**: Medium | **Spec**: US2-AC1, FR-007, SC-003 | **File**: `wiki-maintain.test.mjs`
A change set touching 3 areas with 5 refresh pages total yields ONE refresh slice with 3 parts; 12 pages across 3
areas yields ⌈12/`MAX_PAGES_PER_SLICE`⌉ slices; refreshes and creations are never mixed in one slice.
**Verify RED**: `node --test --test-name-pattern "across areas" scripts/__tests__/wiki-maintain.test.mjs`
**Expected RED**: 3 slices returned where 1 is expected.

### T017 — Test: the run message names every part and bounds writes to the listed areas
**Type**: Test | **Spec**: FR-007 | Assert each area's pages and `index.md` appear; the boundary sentence lists the
areas; the message contains no shell metacharacter; a single-part slice renders exactly today's message (a
byte-for-byte fixture — no regression for the one-area case).

### T018 — Test: verification across parts
**Type**: Test | **Spec**: US2-AC2/AC3 | A write into an unlisted area → violation naming the path; a missing page
in part 2 → reported as `area/page`; a no-change refresh across parts → `noChange`, not failure.

### T019 — Test: old single-area backlog entries still load
**Type**: Test | **Spec**: back-compat (plan D4) | The committed `openwiki/.maintenance-state.json` from `main`
parses and each old slice normalises to one part with identical pages.

### T020 — Implement multi-area slices (`planSlices`, `renderRunMessage`, `verifySlice`, `assertRecordShape`)
**Type**: Implementation | **Prerequisite**: T016–T019 RED
Per plan D4, including per-part re-queue on failure.
**Verify GREEN**: `node --test "scripts/__tests__/wiki-*.test.mjs"` — count = previous + new, 0 skipped; then
`node scripts/wiki-maintain.mjs --plan` (offline, free) on the worktree and read the slices.

---

## Phase 4 — US4: record what each run cost (P3)

### T021 — Test: usage aggregation and the "not captured" rule
**Type**: Test | **Spec**: FR-010, SC-005 | **File**: `wiki-maintain.test.mjs`
From a fixture JSONL (two calls), aggregate to the D5 shape and price it from a fixture price table; an absent or
empty log → `usage: "not captured"`, never zero; the record carries the price table's date.

### T022 — Implement usage aggregation and the price table
**Type**: Implementation | **Prerequisite**: T021 RED
`scripts/wiki-provider-prices.json` (dated 2026-09-27, operator figures for Fireworks standard/priority and Sonnet 5
list prices), per-slice `WIKI_USAGE_LOG`, `lastRunUsage` in the run record, one summary line per slice in the log.

### T023 — Reconcile the estimate with a bill (SC-005)
**Type**: Manual verification | After the first real CI runs on Fireworks, compare `lastRunUsage.estCostUsd` with
the Fireworks console for the same window; record the delta in research.md. Target ≤ 5%.
**Status 2026-10-07:** estimate side done (R14): $7.0291 over 24 CI runs, 2026-10-01 → 10-07 UTC. Waiting for the
operator's console figure for the same window.

---

## Phase 5 — Merge A

### T024 — CI wiring with the default still Anthropic
**Type**: Implementation | **Prerequisite**: T003 RED, T004 answered
Plan D6 with `MCM_WIKI_PROVIDER` defaulting to `anthropic`. **Verify GREEN**: T003 command.

### T025 — Docs at the canonical sources (FR-013)
**Type**: Docs
`docs/runbooks/wiki-maintenance.md` (provider switch, tier, reading `lastRunUsage`, preflight failures);
`openwiki/invariants/model-provider-scoping.md` (canonical concept — edited in place: the wiki's provider is
configurable and independent of the gateway); `docs/proposals/MCM-LLM-Cost-Analysis-1.md` §5 (link this spec and
research). Then `pnpm nx okf-lint infrastructure-as-code` and `pnpm nx okf-governance infrastructure-as-code`
(needs a real `pnpm install` in the worktree — CLAUDE.md worktree gate).

### T026 — Preflight gates and open Merge A
`pnpm nx preflight infrastructure-as-code` (or the cheap-checks target named in `project.json`), push the branch
(real branch, never AGit), open the PR with `git credential fill`. Wait for the required contexts with
`ci-status watch`, redirecting and echoing `$?` (never through a pipe).

---

## Phase 6 — US3: measure the budget, then flip the default (Merge B)

### T027 — Measure a multi-area invocation on 0.6.0, by concurrency (paid, ~$1)
**Type**: Research | **Spec**: US3, US5, SC-007 | Locally on the 0.6.0 side install, one 4-page slice across 2
areas with `MCM_WIKI_PROVIDER=fireworks` (standard tier, T002) at concurrency 1, 2 and 4: record wall clock, the
planner's fixed time, per-page slope, cost, non-200 calls (rate limiting) and pages landed. Repeat once on Sonnet
at the concurrency Fireworks wins on.

### T028 — Write the budget decision record (R9)
**Type**: Docs | **Spec**: FR-008, US3-AC1
In research.md §R9: the per-page slope and fixed cost for each candidate and concurrency; the chosen
`MCM_WIKI_PAGE_CONCURRENCY` default, `PAGE_BUDGET`,
`TIME_BUDGET_SECONDS`, `MAX_PAGES_PER_SLICE`; the effective ceiling including one-invocation overshoot;
`timeout-minutes` above it; the runner-minutes committed per run. **Needs operator sign-off** — present the options
(e.g. fewer pages per run at today's timeout vs more pages at a longer runner hold) and record the choice.

### T029 — Test: timeout exceeds the budget's effective ceiling
**Type**: Test | **Spec**: US3-AC2, SC-004 | **File**: `wiki-maintain.guard.test.mjs`
Parse `timeout-minutes` from the workflow and assert it exceeds `TIME_BUDGET_SECONDS` plus the measured worst-case
single-invocation duration recorded in R9 (a constant in the test with a comment citing R9).
**Verify RED**: fails with today's 45 min if R9's ceiling is higher; if R9 keeps the ceiling under 45, the test is
written against the new constants first and fails until they land.

### T030 — Set the budget constants and the workflow timeout
**Type**: Implementation | **Prerequisite**: T028 signed off, T029 RED
Update `PAGE_BUDGET`, `TIME_BUDGET_SECONDS`, `MAX_PAGES_PER_SLICE`, the header comment's ceiling arithmetic, and
`timeout-minutes`. **Verify GREEN**: T029 command + full wiki suites.

### T031 — Test: "stopped at budget" is still not a failure under the new budget
**Type**: Test | **Spec**: US3-AC3 | Existing exit-3 behaviour asserted with the new constants.

### T032 — File the upstream request
**Type**: Chore | Open an OpenWiki issue asking for provider request options (e.g. `service_tier`) and per-run usage
output, citing R6. Record the link in research.md.
**Status 2026-10-07:** drafted for the operator, not filed. The draft asks for provider request options, per-run
usage, and a way to stop the managed `AGENTS.md` block being rewritten (R12). Posting it is the operator's call;
record the link here once it is filed.

### T033 — Flip the CI default to Fireworks (FR-002)
**Type**: Implementation | **Prerequisite**: operator created `FIREWORKS_API_WIKI_MAINTAIN`; T028 recorded
One-line change to the default (or the repository variable, per T004).

### T034 — Watch the first real runs and score the success criteria
**Type**: Verification | After ≥ 10 real runs: SC-001 (median cost/page vs $0.90), SC-002 (landed-page share vs
Sonnet), SC-003 (invocations < areas on a multi-area run), SC-004 (no platform timeout), SC-005 (T023). Record in
research.md and the proposal §5; if SC-002 regresses, flip the variable back to `anthropic` (SC-006) and open an
item with the failing runs.
**Scored 2026-10-07 (research R14):** 45 runs. SC-001 met (median −83%), SC-002 **not met** (53% vs 98%),
SC-003 met, SC-004 not met over the window (3 kills before #626, 0 in the 25 runs since), SC-005 pending T023.
The SC-002 response is the operator's decision and has not been taken. One option is the flip above; the other is
re-scoring on routine runs now that the #525 sweep is closed.

---

## Dependencies

T001 → everything. T015a → T015b → T015c; T006 → T015d; T013 + T015c + T015d → T015e. T005→T006→T007→T008. T009, T012 → T013 → T014 → T015. T010 → T011 (independent of T005–T009).
T016–T019 → T020 (independent of Phase 2 except T013 for end-to-end runs). T021 → T022 (needs T011). T003+T004 →
T024. T024+T025 → T026 (Merge A). T026 → T027 → T028 → T029 → T030 → T031; T033 needs T028 + the operator secret;
T034 last.
