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
since. SC-005 is met once the price table carries the corrected rates (T023/T023a). T032 is done: kept internal (R15). Feature stays open pending
US6 (auto-escalation, added 2026-10-07). SC-002 decision: keep Fireworks, recorded as an accepted
deviation.

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
**Status 2026-10-07: reconciled (research R14, "SC-005 reconciled").** Tokens match the console per day. The
2026-09-27 rates under-priced by 1.43×. At the operator's corrected standard rates ($0.30 / $0.006 / $1.20), the
window prices at $9.997 against ≈ $10.08 (−0.8%), so SC-005 is met. **DONE (T023a):**
- `scripts/wiki-provider-prices.json` carries the corrected standard rates. The priority row is kept and flagged
  as not re-verified (unused).
- The arithmetic tests now price from a frozen fixture.
- A new guard re-prices the R14 window and fails beyond 5% of the bill. Verified RED (1/1 failing at the old rates,
  30.3% off) then GREEN. The wiki suites show 177 passed, 0 skipped.

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
**DONE 2026-10-07 — kept internal, not filed (operator decision).** The fact-checked gaps G1–G4 and the 0.7.1
review are in research R15. The runbook's version-bump procedure now says to re-check them on every generator
bump. G4 is already upstream as #556 / PR #557.

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
Operator decision 2026-10-07: keep Fireworks, no flip back (cost). SC-002 is an accepted deviation.

---

## Phase 7 — US5 amended: OpenWiki 0.7.1 (amendment 2026-10-07; plan D8)

**Merge C** (T023a, T035–T049): the close-out PR. It carries the scoring docs, the price-table fix, 0.7.1 and US6,
in one branch with one PR (batching rule). T050 follows the merge.

### T035 — Side-install 0.7.1 and point the guard at it (RED)
**Type**: Test | **Risk**: Low | **Spec**: US5-AC4, FR-015 | **File**: `scripts/__tests__/wiki-maintain.guard.test.mjs`
```bash
S="${TMPDIR:-/tmp}/ow-bump"; mkdir -p "$S"   # a scratch prefix, never the container's global one
npm install -g --prefix "$S/ow071" openwiki@0.7.1 mermaid jsdom
```
Edit the pin assertion at `wiki-maintain.guard.test.mjs:179-180`:
```js
  // 078 FR-015: 0.6.0 was the first version with parallel page workers (OPENWIKI_PAGE_CONCURRENCY);
  // 0.7.1 (amendment 2026-10-07) adds the worker retry (#913) and scoped planning (#865), research R15.
  assert.equal(pinned.version, '0.7.1', 'the generator is pinned at 0.7.1 (feature 078 amendment, research R15)');
```
**Verify RED**: `OPENWIKI_ROOT="$S/ow071/lib/node_modules/openwiki" node --test --test-name-pattern "pin|installed|managed" scripts/__tests__/wiki-maintain.guard.test.mjs`
**Expected RED**: exactly the pin assertion fails (the Dockerfile and workflow still say `0.6.0`). Every
installed-generator assertion **runs (count them; 0 skipped)** and passes against 0.7.1, including the R12
managed-block byte comparison. If the byte comparison fails, STOP: 0.7.1's snippet text differs from what R15
recorded, and `AGENTS.md`/`CLAUDE.md` need the R12 treatment first.

### T036 — Bump both pins (GREEN)
**Type**: Implementation | **Prerequisite**: T035 RED
- `.devcontainer/toolchain.Dockerfile:86` → `RUN npm install -g openwiki@0.7.1 mermaid jsdom`
- `.forgejo/workflows/wiki-maintain.yml:160` → `… npm install -g openwiki@0.7.1 mermaid jsdom`. Also update the
  comment at `:145` that names the version.
- `docs/runbooks/wiki-maintenance.md`: the version named in §1a's bump bullet ("how 0.5.2 → 0.6.0 was done") gains
  "and 0.6.0 → 0.7.1".

**Verify GREEN**: the T035 command passes with 0 skipped. Then run the whole guard WITHOUT `OPENWIKI_ROOT`:
`node --test scripts/__tests__/wiki-maintain.guard.test.mjs`. The container's global copy is still 0.6.0 until the
image refreshes. Report its counts as they are: the version-only pin test passes either way, and an assertion that
reads the installed generator's version would be the one to differ. Name any such assertion in the PR rather than
treating it as a pass.

### T037 — One paid single-page probe on 0.7.1 (paid, ~$0.10–0.30; operator approval BEFORE running)
**Type**: Verification | **Spec**: US5-AC4 | **Risk**: Low
In a **scratch clone** (never the worktree): `git clone -q --shared /workspaces/mcm "$S/probe071" && cd "$S/probe071"`
and check out this branch's head. Run one covered page through the launcher. The page is
`runbooks/android-emulator.md`, the T015e page, with the run message shape that T015e used:
```bash
PATH="$S/ow071/bin:$PATH" OPENWIKI_ROOT="$S/ow071/lib/node_modules/openwiki" \
MCM_WIKI_PROVIDER=fireworks MCM_WIKI_PAGE_CONCURRENCY=4 WIKI_USAGE_LOG="$S/probe071.usage.jsonl" \
WIKI_RUN_MESSAGE="$(node -e 'import("./scripts/wiki-maintain.mjs").then(m=>console.log(m.renderRunMessage({area:"runbooks",pages:["android-emulator.md"],kind:"refresh",areaExists:true,subjects:{}})))')" \
node scripts/wiki-generate.mjs; echo "exit=$?"
git status --short; pnpm nx okf-lint infrastructure-as-code
```
**Pass**:
- exit 0;
- the page and `openwiki/runbooks/index.md` are the only bundle pages modified;
- `AGENTS.md` and `CLAUDE.md` are absent from `git status`;
- `okf-lint` reports 0 findings;
- the usage log has lines.

Record wall clock, calls, tokens and cost (at the corrected rates) as research **R16**. Delete the scratch clone.

### T038 — Record the bump
**Type**: Docs | Research R15's "what 0.6.1 → 0.7.1 change" table gains a "measured" column from T037. Mark US5-AC4
done here.

---

## Phase 8 — US6: escalate to low after a deadline failure (amendment 2026-10-07; plan D9)

### Review Focus — inputs the spec implies that no acceptance scenario exercises (each is pinned by a test below)

1. **A carried backlog slice with a stored `runMessage`, partly tagged.** The split copies must not reuse it, or the
   low invocation is told to write the untagged pages. Pinned in T039 (`split: a mixed slice …`).
2. **`MCM_WIKI_REASONING_EFFORT=''`.** The workflow renders this for every run without the dispatch input. It must
   read as "no explicit effort", or escalation would never fire in CI. Pinned in T039 (`policy: …`).
3. **Tag keys from a PACKED invocation.** An invocation's display `pages` are already `area/page`, so keying from
   them would produce `area/area/page`. Keys come from parts only. Pinned in T042 (the AC4 test asserts exact keys).
4. **A hand-edited, malformed `escalations` map.** It must be refused at read/write with a message naming the field,
   not crash mid-run. Pinned in T041.
5. **A deadline stop at an explicit `high` effort.** It still tags the page, and an existing tag is neither reset nor
   counted. Pinned in T039.

### T039 — Test: the pure escalation rules (new file)
**Type**: Test | **Risk**: Medium | **Spec**: FR-017, FR-019–FR-021, SC-009 | **File**: `scripts/__tests__/wiki-escalation.test.mjs`
```js
// Feature 078 US6 — retry a page that ran out of time at low reasoning effort (plan D9).
// Pure rules only: which pages carry a tag, and what effort an invocation overrides. Offline, free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCALATED_EFFORT, pageKey, isDeadlineStop, splitByEscalation, escalationPolicy, invocationEffort,
  nextEscalations, stillFailing,
} from '../wiki-escalation.mjs';

const sl = (area, pages, extra = {}) => ({ area, pages, kind: 'refresh', reason: `r:${area}`, subjects: {}, ...extra });
const tag = (failuresAtLow = 0) => ({ effort: 'low', reason: 'deadline', since: 't0', failuresAtLow });
const NOW = '2026-10-08T00:00:00.000Z';
const outcome = (o) => ({ parts: [], ok: false, landedParts: [], failedParts: [], deadlineStop: false, effortUsed: null, ...o });

test('the escalation step is low, keyed area/page', () => {
  assert.equal(ESCALATED_EFFORT, 'low');
  assert.equal(pageKey('runbooks', 'x.md'), 'runbooks/x.md');
});

test('trigger: only exit 124/137 with a deadline in force is a deadline stop (FR-017, SC-009)', () => {
  assert.equal(isDeadlineStop({ status: 124 }, 60_000), true);
  assert.equal(isDeadlineStop({ status: 137 }, 60_000), true);
  for (const inv of [{ status: 0 }, { status: 1 }, { status: 2 }, { error: 'spawn failed' }, null, undefined]) {
    assert.equal(isDeadlineStop(inv, 60_000), false, JSON.stringify(inv));
  }
  assert.equal(isDeadlineStop({ status: 124 }, null), false, 'no deadline in force (a local run): a 124 is not ours');
});

test('trigger table: a non-deadline failure never creates a tag (SC-009)', () => {
  // Research R14's failure types other than the deadline stop all end as a NORMAL exit: worker exit
  // without submitting, provider 429, openwiki state error, policy or conformance (V16) violation.
  const next = nextEscalations({
    prior: {}, outcomes: [outcome({ parts: [sl('runbooks', ['a.md'])], failedParts: [sl('runbooks', ['a.md'])] })],
    backlog: [sl('runbooks', ['a.md'])], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(next, {});
});

test('a deadline stop tags exactly the pages that did not land (AC1, partial landing)', () => {
  const next = nextEscalations({
    prior: {},
    outcomes: [outcome({ parts: [sl('projects', ['sast.md']), sl('runbooks', ['x.md'])], landedParts: [sl('projects', ['sast.md'])], failedParts: [sl('runbooks', ['x.md'])], deadlineStop: true })],
    backlog: [sl('runbooks', ['x.md'])], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(next, { 'runbooks/x.md': { effort: 'low', reason: 'deadline', since: NOW, failuresAtLow: 0 } });
});

test('a deadline stop at an explicit high still tags; an existing tag is neither reset nor counted (Review Focus 5)', () => {
  const fresh = nextEscalations({ prior: {}, outcomes: [outcome({ parts: [sl('a', ['p.md'])], failedParts: [sl('a', ['p.md'])], deadlineStop: true, effortUsed: 'high' })], backlog: [sl('a', ['p.md'])], pageExists: () => true, now: NOW });
  assert.equal(fresh['a/p.md'].failuresAtLow, 0);
  const kept = nextEscalations({ prior: { 'a/p.md': tag(2) }, outcomes: [outcome({ parts: [sl('a', ['p.md'])], failedParts: [sl('a', ['p.md'])], deadlineStop: true, effortUsed: 'high' })], backlog: [sl('a', ['p.md'])], pageExists: () => true, now: NOW });
  assert.deepEqual(kept['a/p.md'], tag(2));
});

test('a landed tagged page loses its tag, whether its invocation verified or only that part landed (AC5)', () => {
  const prior = { 'a/p.md': tag(), 'b/q.md': tag() };
  const next = nextEscalations({
    prior,
    outcomes: [outcome({ parts: [sl('a', ['p.md'])], ok: true }), outcome({ parts: [sl('b', ['q.md']), sl('c', ['r.md'])], landedParts: [sl('b', ['q.md'])], failedParts: [sl('c', ['r.md'])] })],
    backlog: [sl('c', ['r.md'])], pageExists: () => true, now: NOW,
  });
  assert.deepEqual(next, {});
  assert.deepEqual(Object.keys(prior), ['a/p.md', 'b/q.md'], 'the input map is not mutated');
});

test('failing again at low increments the count, for ANY failure kind (AC6)', () => {
  const next = nextEscalations({ prior: { 'a/p.md': tag(1) }, outcomes: [outcome({ parts: [sl('a', ['p.md'])], failedParts: [sl('a', ['p.md'])], effortUsed: 'low' })], backlog: [sl('a', ['p.md'])], pageExists: () => true, now: NOW });
  assert.equal(next['a/p.md'].failuresAtLow, 2);
  assert.deepEqual(stillFailing({ 'a/p.md': tag(1) }, next), [{ key: 'a/p.md', failuresAtLow: 2 }]);
  assert.deepEqual(stillFailing({}, {}), []);
});

test('an orphan tag is kept while its page exists or is queued, dropped otherwise (edge case)', () => {
  const next = nextEscalations({
    prior: { 'a/exists.md': tag(), 'a/queued.md': tag(), 'a/gone.md': tag() }, outcomes: [],
    backlog: [sl('a', ['queued.md'])], pageExists: (k) => k === 'a/exists.md', now: NOW,
  });
  assert.deepEqual(Object.keys(next).sort(), ['a/exists.md', 'a/queued.md']);
});

test('split: no tags is the identity, stored message included', () => {
  const slices = [sl('a', ['p.md'], { runMessage: 'stored' })];
  const { escalated, normal } = splitByEscalation(slices, {});
  assert.deepEqual(escalated, []);
  assert.equal(normal[0], slices[0], 'the very same object: a run with no tags is byte-for-byte today');
});

test('split: a fully tagged slice moves whole, keeping its message', () => {
  const s = sl('a', ['p.md'], { runMessage: 'stored' });
  const { escalated, normal } = splitByEscalation([s], { 'a/p.md': tag() });
  assert.deepEqual(normal, []);
  assert.equal(escalated[0], s);
});

test('split: a mixed slice is narrowed and its stored message dropped (Review Focus 1)', () => {
  const s = sl('runbooks', ['a.md', 'b.md'], { runMessage: 'Write a.md and b.md', subjects: { 'a.md': 'A', 'b.md': 'B' } });
  const { escalated, normal } = splitByEscalation([s], { 'runbooks/b.md': tag() });
  assert.deepEqual(escalated.map((x) => [x.area, x.pages, x.kind, x.subjects]), [['runbooks', ['b.md'], 'refresh', { 'b.md': 'B' }]]);
  assert.deepEqual(normal.map((x) => [x.area, x.pages, x.kind, x.subjects]), [['runbooks', ['a.md'], 'refresh', { 'a.md': 'A' }]]);
  assert.ok(!('runMessage' in escalated[0]) && !('runMessage' in normal[0]), 'both re-render from their own pages');
  assert.equal(s.runMessage, 'Write a.md and b.md', 'the input slice is not mutated');
});

test('policy: provider support and explicit effort, with the workflow\'s empty string meaning unset (Review Focus 2)', () => {
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'fireworks' }), { explicit: null, supportsLow: true });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_REASONING_EFFORT: '' }), { explicit: null, supportsLow: true });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_REASONING_EFFORT: 'high' }), { explicit: 'high', supportsLow: true });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'anthropic' }), { explicit: null, supportsLow: false });
  assert.deepEqual(escalationPolicy({ MCM_WIKI_PROVIDER: 'nonsense' }), { explicit: null, supportsLow: false });
});

test('invocationEffort: low only for escalated work, never over an explicit effort or an unsupporting provider (FR-019, FR-020)', () => {
  assert.equal(invocationEffort({ explicit: null, supportsLow: true }, true), 'low');
  assert.equal(invocationEffort({ explicit: null, supportsLow: true }, false), null);
  assert.equal(invocationEffort({ explicit: 'high', supportsLow: true }, true), null);
  assert.equal(invocationEffort({ explicit: null, supportsLow: false }, true), null);
});
```
**Verify RED**: `node --test scripts/__tests__/wiki-escalation.test.mjs`
**Expected RED**: the file fails to import `../wiki-escalation.mjs` (module not found).

### T040 — Implement `scripts/wiki-escalation.mjs` (GREEN)
**Type**: Implementation | **Prerequisite**: T039 RED
```js
// wiki-escalation.mjs — feature 078 US6: a page the job deadline stopped is retried at LOW reasoning
// effort on the next run, without the operator (spec FR-017..FR-023, plan D9).
//
// Pure. It decides two things and nothing else: which pages carry an escalation tag, and which effort
// an invocation should OVERRIDE. The tag map lives in the run record beside the backlog, never inside
// it, keyed by `area/page` because the planner rebuilds slices from scratch every run.
//
// Only a deadline stop escalates (exit 124/137 from `timeout` with a deadline in force), and the test
// is the exit status, never openwiki's text. A worker that "exited without submitting" is a different
// failure that `low` does not cure (item #682), so it must not be escalated.

import { resolveWikiProvider, WIKI_PROVIDERS } from './wiki-provider.mjs';

export const ESCALATED_EFFORT = 'low';

export const pageKey = (area, page) => `${area}/${page}`;

/** Keys of slice PARTS. An invocation's display `pages` are already `area/page`, so never key from them. */
const keysOf = (parts = []) => parts.flatMap((p) => (p.pages ?? []).map((page) => pageKey(p.area, page)));

export function isDeadlineStop(invocation, timeoutMs) {
  return timeoutMs !== null && timeoutMs !== undefined && (invocation?.status === 124 || invocation?.status === 137);
}

/** A copy holding only `pages`. Its stored run message named every original page, so it is dropped. */
function narrow(slice, pages) {
  const { runMessage: _stale, ...copy } = slice;
  const subjects = Object.fromEntries(Object.entries(slice.subjects ?? {}).filter(([p]) => pages.includes(p)));
  return { ...copy, pages, subjects };
}

export function splitByEscalation(slices, escalations = {}) {
  const escalated = [];
  const normal = [];
  for (const slice of slices) {
    const tagged = slice.pages.filter((p) => Object.hasOwn(escalations, pageKey(slice.area, p)));
    if (tagged.length === 0) normal.push(slice);
    else if (tagged.length === slice.pages.length) escalated.push(slice);
    else {
      escalated.push(narrow(slice, tagged));
      normal.push(narrow(slice, slice.pages.filter((p) => !tagged.includes(p))));
    }
  }
  return { escalated, normal };
}

export function escalationPolicy(env = process.env) {
  try {
    const { provider, reasoningEffort } = resolveWikiProvider(env);
    return { explicit: reasoningEffort ?? null, supportsLow: WIKI_PROVIDERS[provider].reasoningEfforts.includes(ESCALATED_EFFORT) };
  } catch {
    return { explicit: null, supportsLow: false }; // the preflight has already failed this run, loudly
  }
}

/** The effort to override for one invocation; null leaves the environment as it is. */
export function invocationEffort({ explicit, supportsLow }, escalated) {
  if (explicit) return null;
  return escalated && supportsLow ? ESCALATED_EFFORT : null;
}

export function nextEscalations({ prior = {}, outcomes = [], backlog = [], pageExists = () => false, now }) {
  const next = Object.fromEntries(Object.entries(prior ?? {}).map(([k, v]) => [k, { ...v }]));
  for (const o of outcomes) {
    for (const key of keysOf(o.ok ? o.parts : o.landedParts)) delete next[key];
    if (o.ok) continue;
    for (const key of keysOf(o.failedParts)) {
      if (next[key]) {
        if (o.effortUsed === ESCALATED_EFFORT) next[key].failuresAtLow += 1;
      } else if (o.deadlineStop) {
        next[key] = { effort: ESCALATED_EFFORT, reason: 'deadline', since: now, failuresAtLow: o.effortUsed === ESCALATED_EFFORT ? 1 : 0 };
      }
    }
  }
  const queued = new Set(keysOf(backlog));
  for (const key of Object.keys(next)) if (!queued.has(key) && !pageExists(key)) delete next[key];
  return next;
}

export function stillFailing(prior = {}, next = {}) {
  return Object.entries(next)
    .filter(([key, t]) => prior?.[key] && t.failuresAtLow > prior[key].failuresAtLow)
    .map(([key, t]) => ({ key, failuresAtLow: t.failuresAtLow }));
}
```
**Verify GREEN**: same command. All tests pass, 0 skipped; note the count.

### T041 — Test + implement: the record carries `escalations` (FR-018, Review Focus 4)
**Type**: Test + Implementation | **File**: `scripts/__tests__/wiki-maintain.test.mjs`, `scripts/wiki-maintain.mjs`
RED first. Append to `wiki-maintain.test.mjs`:
```js
// ── 078 US6: escalation tags in the run record ──────────────────────────────────

test('US6 record: the committed record has no escalations and loads as none (FR-018)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-esc-'));
  try {
    mkdirSync(join(root, 'openwiki'), { recursive: true });
    cpSync(join(REPO_ROOT, mod.STATE_FILE), join(root, mod.STATE_FILE));
    assert.deepEqual(mod.readRunRecord(root).escalations, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 record: a malformed escalations map never reaches disk (Review Focus 4)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-esc-'));
  try {
    for (const bad of [[], 'x', { 'a/b.md': { effort: 'low', failuresAtLow: -1 } }, { 'a/b.md': { failuresAtLow: 0 } }, { 'a/b.md': null }]) {
      assert.throws(() => mod.writeRunRecord(root, { escalations: bad }), /escalations/, JSON.stringify(bad));
    }
    assert.deepEqual(mod.writeRunRecord(root, { escalations: { 'a/b.md': { effort: 'low', reason: 'deadline', since: 't', failuresAtLow: 0 } } }).escalations['a/b.md'].failuresAtLow, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```
**Verify RED**: `node --test --test-name-pattern "US6 record" scripts/__tests__/wiki-maintain.test.mjs`. Expect 2
tests: the first fails (`undefined` is not `{}`), and the second fails because nothing throws.
**Implement**: in `scripts/wiki-maintain.mjs`, add `escalations: {},` to `EMPTY_RECORD` (after `lastRunBudget`), and
at the end of `assertRecordShape`:
```js
  const esc = record.escalations;
  if (esc === null || typeof esc !== 'object' || Array.isArray(esc)) {
    throw new Error(`${STATE_FILE}: escalations must be an object keyed by area/page (078 US6)`);
  }
  for (const [key, t] of Object.entries(esc)) {
    if (!t || typeof t.effort !== 'string' || !Number.isInteger(t.failuresAtLow) || t.failuresAtLow < 0) {
      throw new Error(`${STATE_FILE}: escalations[${JSON.stringify(key)}] needs a string effort and a non-negative integer failuresAtLow`);
    }
  }
```
**Verify GREEN**: same command, 2 pass. Then run the whole `wiki-maintain` suite: every pre-existing test still passes.
A record written by any run now carries `escalations: {}`, which is additive.

### T042 — Test: `executeSlices` escalates, isolates, and reports (AC1–AC7, FR-019–FR-022)
**Type**: Test | **Risk**: Medium | **File**: `scripts/__tests__/wiki-maintain.test.mjs`
```js
// ── 078 US6: escalation inside a run ─────────────────────────────────────────────

const DEADLINE = { clock: () => 1_000_000, deadlineMs: 1_000_000 + 60 * 60_000 };
const FIREWORKS_POLICY = { explicit: null, supportsLow: true };
const TAG = (n = 0) => ({ effort: 'low', reason: 'deadline', since: 't0', failuresAtLow: n });
// Writes exactly the invocation's own pages, so a split run never writes outside its boundary.
const ownPagesStub = (root) => (work) => {
  for (const p of mod.partsOf(work)) writingStub(root, p.area, p.pages)();
  return { status: 0 };
};

test('US6 run: a deadline stop that lands nothing tags the requested pages (AC1)', () => {
  const root = twoAreaRepo();
  try {
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root), slices: [sl('invariants', ['one.md'])],
      attemptsPerSlice: 1, effortPolicy: FIREWORKS_POLICY, ...DEADLINE, invoke: () => ({ status: 124 }),
    });
    assert.equal(result.outcome, 'failed');
    const esc = mod.readRunRecord(root).escalations;
    assert.deepEqual(Object.keys(esc), ['invariants/one.md']);
    assert.equal(esc['invariants/one.md'].reason, 'deadline');
    assert.equal(result.results[0].deadlineStop, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: a normal-exit failure tags nothing (AC2)', () => {
  const root = twoAreaRepo();
  try {
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root), slices: [sl('invariants', ['one.md'])],
      attemptsPerSlice: 1, effortPolicy: FIREWORKS_POLICY, ...DEADLINE, invoke: () => ({ status: 0 }),
    });
    assert.deepEqual(mod.readRunRecord(root).escalations, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: tagged pages run first, alone, at low; the rest at the default; landing clears the tag (AC3, AC5, FR-019)', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const stub = ownPagesStub(root);
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG() } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: FIREWORKS_POLICY,
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])],
      invoke: (work, ctx) => { calls.push({ pages: work.pages, effort: ctx.reasoningEffort }); return stub(work); },
    });
    assert.deepEqual(calls, [{ pages: ['two.md'], effort: 'low' }, { pages: ['one.md'], effort: null }]);
    assert.deepEqual(mod.readRunRecord(root).escalations, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: an explicit effort wins, packing is unchanged, and the tags are kept with exact keys (AC4, Review Focus 3)', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG(1) } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: { explicit: 'high', supportsLow: true },
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: (work, ctx) => { calls.push({ pages: work.pages, effort: ctx.reasoningEffort }); return { status: 0 }; },
    });
    assert.deepEqual(calls, [{ pages: ['invariants/one.md', 'gotchas/two.md'], effort: null }], 'one packed invocation, no override');
    assert.deepEqual(mod.readRunRecord(root).escalations, { 'gotchas/two.md': TAG(1) }, 'kept as-is: not reset, not counted, no area/area/page key');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: a provider without effort ignores the tags and keeps them (AC7)', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG() } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: { explicit: null, supportsLow: false },
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: (work, ctx) => { calls.push(ctx.reasoningEffort); return { status: 0 }; },
    });
    assert.deepEqual(calls, [null]);
    assert.deepEqual(mod.readRunRecord(root).escalations, { 'gotchas/two.md': TAG() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: failing again at low increments the count and says so in the log (AC6, FR-021)', (t) => {
  const root = twoAreaRepo();
  try {
    const errors = t.mock.method(console, 'error', () => {});
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG(1) } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: FIREWORKS_POLICY,
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1, invoke: () => ({ status: 0 }),
    });
    assert.equal(mod.readRunRecord(root).escalations['gotchas/two.md'].failuresAtLow, 2);
    assert.ok(mod.readRunRecord(root).backlog.some((b) => b.area === 'gotchas' && b.pages.includes('two.md')),
      'still queued: escalation never parks a page (FR-023)');
    const lines = errors.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(lines.some((l) => /escalated to low and still failing \(2\): gotchas\/two\.md/.test(l)), lines.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: the usage summary carries the effort actually used (FR-022)', () => {
  const root = twoAreaRepo();
  try {
    const stub = ownPagesStub(root);
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG() } };
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: FIREWORKS_POLICY, usage: USAGE_CTX,
      slices: [sl('gotchas', ['two.md'])],
      invoke: (work, ctx) => {
        writeFileSync(ctx.usageLog, `${JSON.stringify({ kind: 'page', status: 200, ms: 10, uncached: 1, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 })}\n`, { flag: 'a' });
        return stub(work);
      },
    });
    assert.equal(result.results[0].usage.reasoningEffort, 'low');
    assert.equal(result.results[0].effortUsed, 'low');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```
**Verify RED**: `node --test --test-name-pattern "US6 run" scripts/__tests__/wiki-maintain.test.mjs`. Expect 7 tests,
nearly all failing. `executeSlices` ignores `effortPolicy` and the record's tags, never passes `reasoningEffort` to
`invoke`, and writes no tags. AC2 and AC7 may already pass by construction; say which ones did.

### T043 — Implement the escalation wiring in `executeSlices` (GREEN)
**Type**: Implementation | **Prerequisite**: T040, T041, T042 RED | **File**: `scripts/wiki-maintain.mjs`
1. Import:
   `import { isDeadlineStop, splitByEscalation, escalationPolicy, invocationEffort, nextEscalations, stillFailing } from './wiki-escalation.mjs';`
2. Add `effortPolicy = escalationPolicy(),` to `executeSlices`' parameters (after `deadlineMs`).
3. Replace `const work = packSlices(queue);` and `remainingParts` with:
   ```js
   // 078 US6: pages a deadline stopped last time run first, alone, at low effort. Packing never
   // mixes them with default-effort work, because effort is per generator PROCESS. With an explicit
   // effort, or a provider without one, the split is skipped and the tags are simply kept (FR-020).
   const lowEffort = invocationEffort(effortPolicy, true);
   const { escalated, normal } = lowEffort === null
     ? { escalated: [], normal: queue }
     : splitByEscalation(queue, runRecord.escalations ?? {});
   const plan = [
     ...packSlices(escalated).map((work) => ({ work, effort: lowEffort })),
     ...packSlices(normal).map((work) => ({ work, effort: null })),
   ];
   const remainingParts = (from) => plan.slice(from).flatMap((p) => partsOf(p.work));
   const outcomes = [];
   ```
4. The dry-run branch maps `plan` (`({ work: s }) => ({ slice: s, dryRun: true, … })`). Change the loop header to
   `for (const [i, { work: slice, effort }] of plan.entries())`.
5. Track the deadline stop: declare `let stopped = false;` with `attempts`. Inside the attempt loop, after `invoke`,
   set `stopped = isDeadlineStop(invocation, timeoutMs);` and reuse it in the existing `revertUnrequested`
   condition. Pass `reasoningEffort: effort` in `invoke`'s context object.
6. Usage: `invocationUsage(usageLog, usage ? { ...usage, reasoningEffort: effort ?? usage.reasoningEffort ?? null } : usage)`.
   `invocationUsage` already returns `NOT_CAPTURED` for a null context (`wiki-maintain.mjs:1579`), and that must
   stay so.
7. `results.push({ slice, ...verdict, attempts, invocationError: …, usage: spent, effortUsed: effort ?? effortPolicy.explicit ?? null, deadlineStop: stopped });`
   followed by
   `outcomes.push({ parts: partsOf(slice), ok: verdict.ok, landedParts: verdict.landedParts ?? [], failedParts: verdict.ok ? [] : (verdict.failedParts ?? partsOf(slice)), deadlineStop: stopped, effortUsed: effort ?? effortPolicy.explicit ?? null });`
8. Before `writeRunRecord`:
   ```js
   const escalations = nextEscalations({
     prior: runRecord.escalations ?? {}, outcomes, backlog, now: now(),
     pageExists: (key) => existsSync(join(bundleDir, key)),
   });
   for (const { key, failuresAtLow } of stillFailing(runRecord.escalations ?? {}, escalations)) {
     console.error(`[wiki-maintain] ⚠ escalated to low and still failing (${failuresAtLow}): ${key} — consider parking it (078 US6)`);
   }
   ```
   Then add `escalations,` to the object passed to `writeRunRecord`.

**Verify GREEN**: T042's command shows 7 pass, then `node --test "scripts/__tests__/wiki-*.test.mjs"`. The count is
T023a's 177 + T039 + T041 + T042, with 0 skipped. Pre-existing tests stay unmodified.

### T044 — Test + implement: the effort reaches the generator, and `main` passes the policy
**Type**: Test + Implementation | **File**: `wiki-maintain.test.mjs`, `wiki-maintain.mjs`
RED first:
```js
test('US6 env: generatorEnv overrides the effort only when asked', () => {
  const base = { PATH: '/bin', MCM_WIKI_REASONING_EFFORT: '' };
  assert.equal(mod.generatorEnv('m', base, { reasoningEffort: 'low' }).MCM_WIKI_REASONING_EFFORT, 'low');
  assert.equal(mod.generatorEnv('m', base, {}).MCM_WIKI_REASONING_EFFORT, '');
  assert.equal(mod.generatorEnv('m', base, { reasoningEffort: null }).MCM_WIKI_REASONING_EFFORT, '');
});

test('US6 env: the CLI path hands executeSlices the escalation policy (structural, like the preflight pin)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const main = src.slice(src.indexOf('async function main'));
  assert.match(main, /effortPolicy:\s*escalationPolicy\(process\.env\)/);
});
```
**Verify RED**: `node --test --test-name-pattern "US6 env" scripts/__tests__/wiki-maintain.test.mjs` shows 2 failing.
(`main` is declared `async function main(argv)` at `wiki-maintain.mjs:2228`.)
**Implement**:
- `generatorEnv(runMessage, env = process.env, { usageLog = null, reasoningEffort = null } = {})` returns
  `{ ...env, [RUN_MESSAGE_ENV]: runMessage, ...(usageLog ? { WIKI_USAGE_LOG: usageLog } : {}), ...(typeof reasoningEffort === 'string' ? { MCM_WIKI_REASONING_EFFORT: reasoningEffort } : {}) }`.
- `defaultInvoke(slice, { root, usageLog = null, timeoutMs = null, reasoningEffort = null })` passes
  `{ usageLog, reasoningEffort }`.
- In `main`'s `executeSlices({...})` call, add `effortPolicy: escalationPolicy(process.env),`.

**Verify GREEN**: same command, 2 pass. Then the whole wiki suite, with 0 skipped.

### T045 — Docs at the canonical sources (FR-013)
**Type**: Docs
- `docs/runbooks/wiki-maintenance.md`: a new subsection under §3 "Reading a failure", **"Escalation after a deadline
  failure (078 US6)"**. It covers:
  - what tags a page (deadline stop only; never a worker exit, 429 or state error);
  - where the map lives (`escalations` in `openwiki/.maintenance-state.json`);
  - what the next run does (`low`, alone, first);
  - precedence (an explicit dispatch input or repository variable wins);
  - the flag line;
  - how to park: remove the backlog slice **and** its `escalations` entry in the same commit;
  - the R14 caveat that `low` is not guaranteed to land a page.
- `scripts/wiki-usage-tap.mjs` header: replace "openwiki refuses an effort for its fireworks provider, so this is
  the only route" with "openwiki refuses an effort for its `fireworks` provider. The `openai-compatible` provider
  could carry it (R15, G2), but cannot send `service_tier`, so the tap stays."
- Apply the same correction to the comment in `scripts/wiki-provider.mjs` that says the tap sets the body key
  because openwiki refuses the effort.

Then run `pnpm nx okf-lint infrastructure-as-code` and `pnpm nx okf-governance infrastructure-as-code`. These need a
real `CI=true pnpm install --frozen-lockfile` in the worktree, per the CLAUDE.md worktree gate.

### T046 — Preflight and the affected tiers
`pnpm nx preflight infrastructure-as-code` (or the cheap-checks target its `project.json` names). Also run
`node --test "scripts/__tests__/*.test.mjs"` for the whole scripts tier. Watch the SKIP count, and name every skip
with its reason.

### T047 — Self-review of the branch
`git diff origin/main...HEAD` read end to end. Check it against spec FR-017–FR-023 and US5-AC4, and against this
phase's Review Focus list. Run one fresh-reviewer pass over the whole branch.

### T048 — Close out 078's task list
Mark T023, T032, T034–T047 done with their evidence. The Status block names what remains post-merge (T050).

### T049 — Open the close-out PR
Rename the branch to `feat/078-closeout`. `git push origin HEAD:feat/078-closeout`, a real branch, never AGit. Open
the PR with the `git credential fill` credential, then run `ci-status watch`, redirecting output and echoing `$?`.
The operator merges if any required context was path-skipped.

### T050 — After merge: observe (no code)
Over the first real runs on 0.7.1, record in research R16:
- **SC-008:** the first deadline failure, and the next run's `reasoningEffort: "low"` on the tagged pages;
- **0.7.1:** whether #913 lands a page that used to exit, or only doubles its time; whether #906 absorbs a "different
  persisted plan"; whether #865 narrows plans;
- the price table holding: estimates within 5% of the console for a fresh window (SC-005).

Then mark US6 done.

---

## Dependencies

T001 → everything. T015a → T015b → T015c; T006 → T015d; T013 + T015c + T015d → T015e. T005→T006→T007→T008. T009, T012 → T013 → T014 → T015. T010 → T011 (independent of T005–T009).
T016–T019 → T020 (independent of Phase 2 except T013 for end-to-end runs). T021 → T022 (needs T011). T003+T004 →
T024. T024+T025 → T026 (Merge A). T026 → T027 → T028 → T029 → T030 → T031; T033 needs T028 + the operator secret;
T034 last.

**Amendment (2026-10-07):**
- T035 → T036 → T037 (operator approval) → T038.
- T039 → T040; T041; T042 needs T040 + T041 → T043 → T044.
- T045 and T046 need everything above. Then T047 → T048 → T049 (Merge C) → T050.
- 0.7.1 (T035–T038) goes before US6's GREEN steps, so US6 is measured on the generator CI will run.
