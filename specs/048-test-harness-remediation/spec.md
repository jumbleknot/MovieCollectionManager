# Feature Specification: Test-harness remediation — golden topic-confinement gate + MCP integration tests in CI

**Feature branch**: `048-test-harness-remediation`
**Created**: 2026-08-06
**Status**: Draft
**Input**: [PRD-TestHarnessRemediation.md](../../docs/proposals/PRD-TestHarnessRemediation.md) work items 1 and 2 · [PRD-UnrunMcpIntegrationTests.md](../../docs/proposals/PRD-UnrunMcpIntegrationTests.md) · [MCM-Testing-Strategy.md](../../docs/proposals/MCM-Testing-Strategy.md) §2, §5.6, §6

Both work items share one theme — **a check that cannot fail is not a check** — and both are decided by
the product owner. This spec implements them; it does not re-open them.

Work item 3's **tier 0 credential split** is now in scope (US4): the product owner has minted three
per-surface Anthropic keys and added them to Forgejo Actions Secrets. Tier 1 (a usage sink at the
cassette seam) remains **out** of this feature.

**Decided 2026-08-07 — the ~52 live-model E2E flows stay on live Anthropic.** The open question work
item 3 existed to inform is closed; no measurement gates it. This does not affect US1, which moves 9
*model-decision* tests to the tier that owns them (strategy §2) — that is a tier-correctness change,
not a cost change, and it stands on its own.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Topic confinement is provable at merge without a credential (Priority: P1)

`test_out_of_domain.py` drives the **live** supervisor model to verify FR-005 topic confinement. On
2026-08-06 the Anthropic balance ran out, the model became unreachable, and all 9 tests errored in
`app-ci`. CI green therefore depends on an account balance rather than on the code being correct.

The test asserts a **model decision**, which by strategy §2 is exactly what the **golden** tier is
for. It is a golden-shaped test living in the integration tier, and that is how it imported a
live-model dependency into a tier whose purpose is service↔service contracts.

**Why this priority**: it is the item that is actively breaking merges today.

**Independent Test**: with no `ANTHROPIC_API_KEY` present anywhere in the environment, the topic
confinement assertions run to completion and pass, and a deliberate edit to the supervisor prompt
makes them fail loudly rather than skip.

**Acceptance Scenarios**:

1. **Given** no `ANTHROPIC_API_KEY` and `LLM_CASSETTE_MODE=replay`, **When** the golden gate runs,
   **Then** all 9 topic-confinement assertions execute against recorded responses and pass, with a
   SKIP COUNT of zero for those tests.
2. **Given** the supervisor prompt is edited, **When** the golden gate runs in replay, **Then** the
   affected assertions fail with `CassetteMissError` — never skip, and never silently pass.
3. **Given** the cassette file for a scenario is deleted, **When** the golden gate runs in replay,
   **Then** the run fails. A missing cassette MUST NOT be reported as a pass.
4. **Given** `app-ci`'s agent-integration step runs with a real `ANTHROPIC_API_KEY`, **When** the
   suite executes, **Then** the topic-confinement tests are **not** selected there — they no longer
   consume live-model calls in that job.

### User Story 2 - The live model decision is verified before deploy, not after (Priority: P1)

The strategy doc (§5.6), the constitution (§469, §493) and `test_golden_pairs.py`'s own docstring all
assert that a live-model pre-deploy gate exists. **It does not.** `guardrails.yml` runs `replay`, and
`cd-deploy.yml` has no live-model gate at any point. The `off`-mode branch is implemented inside
`test_golden_pairs.py` but nothing invokes it.

Shipping User Story 1 without this story is **the failure mode to avoid**: it would convert a
behavioural check into a regression check and silently drop the live verification the test exists for.

**Why this priority**: US1 removes the live signal; this story is what preserves it. They must ship
together.

**Independent Test**: a deploy is attempted with a supervisor prompt that genuinely breaks topic
confinement against the live model; the deploy is blocked before any image is promoted.

**Acceptance Scenarios**:

1. **Given** a push to `main` that triggers `cd-deploy`, **When** the pipeline runs, **Then** the
   live-model golden gate executes in `off` mode against the real provider **before** any image is
   promoted or any Komodo webhook fires.
2. **Given** the live gate fails, **When** the pipeline continues, **Then** no digest is promoted, no
   redeploy webhook is fired, and the failure names the gate.
3. **Given** the live gate cannot obtain a credential, **When** it runs, **Then** it **fails** — it
   MUST NOT skip its way to green. A pre-deploy gate that skips is the defect this feature exists to
   remove.
4. **Given** the provider returns HTTP 529 (capacity), **When** the gate runs, **Then** it retries
   and, only on exhausted retries, reports a distinguishable infrastructure outcome rather than a
   silent pass.

### User Story 3 - The MCP servers' integration tests are correct and actually run (Priority: P2)

No MCP server's `test:integration` runs anywhere in CI — `app-ci` covers `movie-assistant`,
`mc-service` and `mcm-app` only. Two `spreadsheet-mcp` tests have therefore **never passed**: the
test, the parser and the fixture share exactly one commit (`33eba4c`, 2026-06-14), so nothing
regressed. They were simply never run.

Fixing the tests without enrolling them in CI was explicitly rejected — it restores the illusion that
produced this.

**Why this priority**: real but latent coverage loss; no merge is currently blocked by it.

**Independent Test**: both previously-failing tests pass locally and in CI, and reverting either fix
turns CI red.

**Acceptance Scenarios**:

1. **Given** the sample workbook, **When** `test_parse_via_real_transient_store_is_single_use` runs,
   **Then** the asserted row count is **derived from the fixture**, so appending a row to the sheet
   cannot silently break it again.
2. **Given** the full `spreadsheet-mcp` integration suite runs in one pytest session, **When**
   `test_missing_handle_raises_not_found` executes after another test, **Then** it passes — no
   "Future attached to a different loop" or "Event loop is closed".
3. **Given** `movie-mcp` and `spreadsheet-mcp` integration suites run in CI, **When** a required
   backing service (Redis, `mc-service`) is absent, **Then** the run **fails** rather than skipping to
   green.
4. **Given** `web-api-mcp`, **When** this feature ships, **Then** it is **not** enrolled in CI, and
   the reason (unconfirmed TMDB egress + an unsettled credential question) is recorded.

### User Story 4 - Model spend is attributable per surface (Priority: P3)

A single `secrets.ANTHROPIC_API_KEY` backs three unrelated surfaces — the `app-e2e` job, the `dast`
job, and wiki generation. Console spend therefore conflates them, and no one can say what a CI run
costs versus what a wiki-maintenance run costs. Three replacement secrets now exist:
`ANTHROPIC_API_CI_E2E`, `ANTHROPIC_API_CI_DAST`, `ANTHROPIC_API_WIKI_MAINTAIN`.

**Why this priority**: it writes no product code and blocks nothing, but it is cheap and it is the
only way the console can ever separate these surfaces.

**Independent Test**: after one `app-ci` run and one `wiki-maintain` run, the Anthropic console shows
non-overlapping spend against distinct keys.

**Acceptance Scenarios**:

1. **Given** the workflows are updated, **When** `app-e2e` runs, **Then** it authenticates with
   `ANTHROPIC_API_CI_E2E` and no other surface draws on that key.
2. **Given** the `dast` job runs, **When** the gateway boots, **Then** it uses `ANTHROPIC_API_CI_DAST`.
3. **Given** wiki generation runs, **When** the generator is invoked, **Then** it uses
   `ANTHROPIC_API_WIKI_MAINTAIN`.
4. **Given** the split has landed, **When** the repository is searched, **Then** **no** workflow
   references `secrets.ANTHROPIC_API_KEY`, and the now-unreferenced secret has been **deleted** from
   Forgejo rather than left configured.
5. **Given** the US2 pre-deploy live gate, **When** it runs, **Then** it authenticates with
   `ANTHROPIC_API_CD_GOLDEN` — not `ANTHROPIC_API_CI_E2E` — so deploy-gate spend stays separable from
   E2E spend.

### Edge Cases

- **A cassette miss inside a fixture.** `_supervisor_model()` wraps model construction in a blanket
  `except Exception` that calls `pytest.skip`. Under replay, a `CassetteMissError` raised there is
  converted into a skip — turning the loudest drift signal in the design into a green run. This is the
  single highest-risk defect in the change.
- **`"no cassette"` is already whitelisted** in `_LEGITIMATE_SKIPS`, so a golden run with zero
  cassettes present currently skips everything and reports green.
- **`invoke_or_skip` classifies by substring.** A `CassetteMissError` whose text happened to contain
  a capacity keyword would be silently converted to a skip.
- **Physically relocating the test file breaks it** — see Assumptions.
- A provider 529 mid-run is upstream capacity, not a classification defect, and must stay
  distinguishable from a real failure.
- **Nothing in this change requires renaming the `ANTHROPIC_API_KEY` environment variable** — only the
  secret it is assigned from changes. Renaming it is simply unnecessary work: consumers keying on the
  name are `models.py::resolve_anthropic_key`, `scripts/agent-stack.mjs`, the `-e ANTHROPIC_API_KEY`
  docker passthrough at `app-ci.yml:550`, and the DAST leak check at `app-ci.yml:865`. If a rename were
  ever done deliberately, each is a one-line update including the guard. The one asymmetry worth
  recording: the leak check is guarded by `if [ -n "$ANTHROPIC_API_KEY" ]`, so a *missed* rename there
  would no-op silently, whereas every other consumer fails loudly. It is the place to check last.
- **An empty or mistyped secret does not fail open.** `${{ secrets.TYPO }}` evaluates to an empty
  string, but every job that consumes it aborts first: `agent-stack.mjs` exits 1 without a key under
  `MODEL_PROVIDER=anthropic` (so `dast` never reaches its leak-check step), and `wiki-maintain.mjs`
  exits 2 with an explicit missing-credential message. A botched secret name is therefore a loud CI
  failure, not a silent one.
- **The US2 pre-deploy gate is a fourth surface with no key.** `cd-deploy.yml` contains no Anthropic
  credential today. Pointing it at `ANTHROPIC_API_CI_E2E` would re-conflate two of the surfaces this
  story exists to separate.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The topic-confinement tests MUST run through the existing `models.build_chat_model`
  cassette seam. No second record/replay mechanism may be introduced.
- **FR-002**: The tests MUST be selected by the repo's existing **`golden` pytest marker**, which is
  what `nx test:golden` and `app-ci`'s `-m "not golden"` filter both key on.
- **FR-003**: Under `LLM_CASSETTE_MODE=replay`, a missing or non-matching cassette MUST fail the run.
  It MUST NOT be converted into a skip by any fixture, helper, or `_LEGITIMATE_SKIPS` entry.
- **FR-004**: The blanket `except Exception → pytest.skip` in the model fixture MUST be narrowed so it
  cannot swallow `CassetteMissError`.
- **FR-005**: Cassettes MUST be recorded for both the runtime and the gate model, covering all 8
  parametrized prompts plus the full-graph scenario, per strategy §5.6.
- **FR-006**: A live-model (`off` mode) golden gate MUST exist and MUST run in `cd-deploy.yml` before
  any image promotion or redeploy webhook.
- **FR-007**: The live gate MUST fail — not skip — when it cannot obtain a credential.
- **FR-008**: The live gate MUST NOT be scheduled. It runs at deploy only. (Owner constraint: quality
  checks gate at merge or at deploy, never on a timer.)
- **FR-009**: `test_parse_via_real_transient_store_is_single_use` MUST assert a row count derived from
  the fixture workbook, not a hard-coded literal.
- **FR-010**: The event-loop defect MUST be fixed in the **test fixture** by resetting the
  module-level singleton between tests. `store._shared_client` is correct for the long-lived server
  process and MUST NOT be changed to suit the tests.
- **FR-011**: `movie-mcp` and `spreadsheet-mcp` `test:integration` MUST run in `app-ci`.
- **FR-012**: The MCP integration suites MUST escalate an infrastructure skip to a failure in CI, in
  the same spirit as `MCM_REQUIRE_LIVE_STACK=1`. Enrolling a suite that can skip to green would
  reproduce the exact illusion this feature removes.
- **FR-013**: `web-api-mcp` MUST NOT be enrolled in CI by this feature.
- **FR-014**: Each Anthropic-consuming workflow job MUST source its credential from its own
  per-surface secret: `app-ci.yml` app-e2e → `ANTHROPIC_API_CI_E2E`; `app-ci.yml` dast →
  `ANTHROPIC_API_CI_DAST`; `wiki-maintain.yml` → `ANTHROPIC_API_WIKI_MAINTAIN`.
- **FR-015**: The **environment variable name `ANTHROPIC_API_KEY` MUST NOT change.** Only the secret it
  is assigned from changes. Every downstream consumer keys on the variable name.
- **FR-016**: The US2 pre-deploy live gate MUST source its credential from `ANTHROPIC_API_CD_GOLDEN`,
  distinct from all three above, so deploy-gate spend remains separately attributable.
- **FR-017**: After the split, `secrets.ANTHROPIC_API_KEY` MUST have zero references in the repository,
  and the secret MUST be deleted from Forgejo Actions Secrets rather than left configured. An
  unreferenced live credential has no owner, no rotation trigger, and still works.

### Key Entities

- **Cassette** — a per-scenario JSON file keyed by `sha256(model_id + normalized prompt)`; a prompt or
  model change produces a loud miss, never a stale pass.
- **`golden` marker** — the selector that routes a test to the keyless replay gate and out of the
  live-key integration job. The two selectors are complementary and exhaustive over
  `tests/integration/`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With no `ANTHROPIC_API_KEY` set, the golden gate runs the 9 topic-confinement
  assertions and reports **0 skipped, 0 failed**.
- **SC-002**: Deleting any one cassette makes the golden gate **fail**; the run does not report green.
- **SC-003**: `app-ci`'s live-model flow count for the agent-integration step drops from 9 to 0;
  the routine `app-ci` live-model total falls from ~61 to ~52.
- **SC-004**: `cd-deploy` fails before promotion when the live gate fails, verified by a deliberate
  break.
- **SC-005**: `spreadsheet-mcp` integration suite: **2 failed → 0 failed**, with a non-zero executed
  count (not skipped).
- **SC-006**: Reverting either MCP fix independently turns CI red — proving each test is sensitive to
  the defect it covers, not merely present.
- **SC-007**: `movie-mcp` (20 tests) and `spreadsheet-mcp` run in `app-ci` with a SKIP COUNT of 0.
- **SC-008**: `grep -rn "secrets.ANTHROPIC_API_KEY" .forgejo/` returns **0 matches**, and the four
  Anthropic-consuming jobs each reference a distinct secret.
- **SC-009**: After one `app-ci` run and one `wiki-maintain` run, the Anthropic console attributes
  non-zero spend to at least two distinct keys — proving the surfaces are actually separated rather
  than merely renamed.

## Assumptions

- **The golden tier here is a pytest MARKER, not a directory.** `tests/golden/` contains only
  cassettes, `dataset.json` and `compare.py`; the golden *test* is
  `tests/integration/test_golden_pairs.py` carrying `@pytest.mark.golden`, and `nx test:golden` runs
  `pytest tests/integration -m golden`. **Physically moving `test_out_of_domain.py` into
  `tests/golden/` would place it outside the path both selectors scan, so it would run nowhere.** The
  approved intent — inherit replay-in-CI and live-at-deploy from the existing runner — is achieved by
  adding the marker, and that is what this spec requires.
- `test_golden_pairs.py` is the reference implementation, including its `replay` / `record` /
  `off` three-mode structure. The `off` branch exists; only an invoker is missing.
- The sample workbook's `Sample` tab has **204 data rows** (205 including the header) — independently
  verified with openpyxl on 2026-08-06. The parser's `rowCount` (`len(data_rows)`) is correct and the
  `== 200` expectation is wrong.
- CI has no Ollama; the runtime model in CI is Anthropic. Switching providers is infrastructure work,
  not a config flag, and is out of scope here.
- **The ~52 live-model E2E flows stay on live Anthropic — decided by the product owner 2026-08-07.**
  No measurement gates this feature. The supporting evidence is on record: 047 PR A found a guard bug
  that passed on local Ollama and failed on Anthropic in CI, so Anthropic-in-E2E has already caught a
  genuine provider-dependent defect.
- All four per-surface secrets already exist in Forgejo Actions Secrets (`ANTHROPIC_API_CI_E2E`,
  `ANTHROPIC_API_CI_DAST`, `ANTHROPIC_API_WIKI_MAINTAIN`, `ANTHROPIC_API_CD_GOLDEN`); this feature
  consumes them rather than creating them.
