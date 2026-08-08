# Implementation Plan: Test-harness remediation (048)

**Branch**: `048-test-harness-remediation` | **Date**: 2026-08-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/048-test-harness-remediation/spec.md`

## Summary

Two independent remediations sharing one theme. **US1+US2**: move the FR-005 topic-confinement tests
onto the existing cassette seam via the `golden` pytest marker (keyless replay at merge), and build
the missing `off`-mode live gate into `cd-deploy` so the live verification is preserved rather than
dropped. **US3**: fix two `spreadsheet-mcp` integration tests that have never passed, and enrol
`movie-mcp` + `spreadsheet-mcp` in `app-ci` with skip-escalation so they cannot rot again.

**US4**: repoint the three Anthropic-consuming workflow jobs at per-surface secrets so console spend is
attributable, and retire the shared key. **US5**: make the DAST secret-leak check fail closed, and
prove it fires with a canary.

**US6** (added 2026-08-08, found while validating this feature): make `gen-dev-env.mjs` create
`frontend/mcm-app/.env.local` instead of silently skipping it, and make credential-driven skips name
their own remedy — the silent skip disabled a local test tier and produced a wrong "cannot run in this
dev container" conclusion during T043.

The dominant technical risk is not the happy path — it is that every mechanism here has a
skip-to-green failure mode. Most of the plan below is about closing those.

### Credential mapping (US4)

Exactly three `${{ secrets.ANTHROPIC_API_KEY }}` interpolations exist repo-wide — verified
2026-08-07 by `grep -rn "secrets.ANTHROPIC_API_KEY"` across all file types excluding `node_modules`.
They map 1:1 to the secrets already provisioned:

| Location | Job | New secret |
|---|---|---|
| `app-ci.yml:255` | `app-e2e` | `ANTHROPIC_API_CI_E2E` |
| `app-ci.yml:753` | `dast` | `ANTHROPIC_API_CI_DAST` |
| `wiki-maintain.yml:156` | wiki generation | `ANTHROPIC_API_WIKI_MAINTAIN` |
| `cd-deploy.yml` (**new**, US2) | live pre-deploy golden gate | `ANTHROPIC_API_CD_GOLDEN` |

Only `.forgejo/workflows/` is affected; the two other repo-wide matches are prose in
`docs/proposals/PRD-TestHarnessRemediation.md`.

**The env var name does not change** — each becomes
`ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_CI_E2E }}` and so on. This is a "don't do unnecessary
work" note, not a hazard: renaming the variable is possible and every consumer would be a one-line
update (`models.py::resolve_anthropic_key`, `scripts/agent-stack.mjs`, the `-e ANTHROPIC_API_KEY`
passthrough at `app-ci.yml:550`, and the leak check at `app-ci.yml:865`). The single asymmetry: the
leak check's `[ -n "$ANTHROPIC_API_KEY" ]` guard fails open, so a missed rename *there* is silent while
every other consumer is loud.

**A mistyped secret name is caught loudly.** An unresolvable `${{ secrets.X }}` yields an empty string,
but `agent-stack.mjs` exits 1 without a key under `MODEL_PROVIDER=anthropic` (so `dast` aborts at stack
bring-up, before its leak-check step) and `wiki-maintain.mjs` exits 2 with an explicit
missing-credential message. No silent-green path exists for a botched rename.

**US5 removes the dependence on that.** The protection above is real but *incidental* — it comes from
an unrelated script's argument validation, not from the leak check itself. US5 makes the check fail
closed on its own terms, so it stays correct if `agent-stack.mjs`'s validation is ever relaxed or the
step is ever reordered ahead of stack bring-up.

### The three fail-open guards (US5)

| Line | Secret | Expected when |
|---|---|---|
| `app-ci.yml:859` | `E2E_TEST_PASSWORD` | always (job env, from secrets) |
| `app-ci.yml:862` | `E2E_ROPC_CLIENT_SECRET` | always (minted at `:834` into `$GITHUB_ENV`) |
| `app-ci.yml:865` | `ANTHROPIC_API_KEY` | **only when `MODEL_PROVIDER == anthropic`** — `:749` allows a dispatch/vars override, under which an empty key is legitimate |

The JWT regex scan below them takes no variable and already runs unconditionally — it needs no change.

The conditional in the third row is the part most likely to be got wrong: a blanket "fail if empty"
would break the documented provider-override path. The requirement is *fail on **unexpected**
emptiness*, not on emptiness.

### The `.env.local` silent skip (US6)

`scripts/gen-dev-env.mjs` writes four env files. Three are generated outright; `.env.local` is
**surgically synced** — only the client-secret lines are rewritten, so a developer's other Metro keys
survive. `syncEnvFile` implements that with `if (!existsSync(path)) return false`, and the caller turns
the `false` into the console fragment `(.env.local absent — skipped; copy .env.example for Metro)`.

Two things are wrong with that, and they compound:

| Problem | Consequence |
|---|---|
| A missing file is treated as "nothing to sync" | The three realm client secrets never reach the file `kc_admin.cfg()` reads, so every credential-dependent integration test skips |
| The remedy names `frontend/mcm-app/.env.example`, which **does not exist** | The reader looks for a missing file, finds nothing, and concludes the environment is at fault |

The fix is to **create** the file when absent. That is safe here specifically because the sync set is
exactly the three realm client secrets, which are the same values `.env.docker` already receives — a
created file is a strict subset of a correct one, never a conflicting one. Preserving developer keys
in an *existing* file remains unchanged.

The second half of US6 is the message quality. `subject_token`'s skip read `ROPC / service-account
creds not set — needs the live stack`: it names neither which of the three credentials is missing, nor
the file, nor the command. That is what turned a one-command fix into "CI is where this leg gets
proven". Per FR-024 a credential skip must carry variable + file + remedy.

**Why this belongs in 048 rather than a follow-up**: the feature's thesis is that a check which cannot
fail is not a check. A generator step that silently no-ops, and a skip that misattributes its own cause,
are the same failure mode one layer down — and this one was found *by* 048's own validation.

## Technical Context

**Language/Version**: Python 3.12 (agent + MCP servers), YAML (Forgejo Actions)
**Primary Dependencies**: pytest, pytest-asyncio, langchain-anthropic, redis.asyncio, openpyxl
**Storage**: Redis (spreadsheet-mcp transient handle store); cassette JSON on disk
**Testing**: `pnpm nx test:golden movie-assistant`, `pnpm nx test:integration <project>`
**Target Platform**: Forgejo Actions (`guardrails.yml`, `app-ci.yml`, `cd-deploy.yml`)
**Project Type**: Polyglot monorepo — Nx is the universal task runner
**Performance Goals**: golden replay stays sub-second (currently 41 pairs in 0.36 s); MCP integration
suites add ≲1 min to `app-ci`
**Constraints**: no scheduled gates (owner constraint); CI has no Ollama; `web-api-mcp` stays out of CI
**Scale/Scope**: 9 topic-confinement assertions, 2 MCP test fixes, 3 workflow files

### Load-bearing mechanism facts (verified 2026-08-06)

| Fact | Evidence |
|---|---|
| The golden tier is a **marker**, not a directory | `test:golden` = `uv run pytest tests/integration -m golden`; `tests/golden/` holds only cassettes + `dataset.json` + `compare.py` |
| The two CI selectors are complementary and exhaustive | guardrails runs `-m golden`; `app-ci` runs `-m "not golden"` |
| The seam is already in the call path | `test_out_of_domain.py` builds its model via `build_chat_model(select_model_config("supervisor", …))`, which already honors `LLM_CASSETTE_MODE` |
| `off` mode is already implemented | `test_golden_pairs.py` has `replay` / `record` / `off` branches; only an invoker is missing |
| A cassette miss can be swallowed | `_supervisor_model()` uses a blanket `except Exception → pytest.skip` |
| A missing cassette is whitelisted | `"no cassette"` is in `_LEGITIMATE_SKIPS` |
| The row-count expectation is wrong, the parser is right | Workbook has 205 rows / 204 data rows; `rowCount = len(data_rows)` |
| The Redis singleton is correct for production | `store._make_redis()` reuses one client for a long-lived server; `read_upload(handle, *, client=None)` already accepts injection |

## Constitution Check

| Principle | Status | Note |
|---|---|---|
| TDD (RED → GREEN) | ✅ | Test tasks follow `docs/templates/feature-test-tasks-template.md` — `Scenarios covered`, fenced Verify RED with `Expected RED`, paired implementation task with `Verify GREEN` + touched-suite regression. Converted 2026-08-07 after the `/speckit-analyze` pass found the original checkbox format omitted the mandatory `Scenarios covered` field (constitution.md:112) |
| Test Type Integrity — never mock the dependency under integration | ✅ | The **only** cassetted dimension is the LLM, and only in the golden tier — now an explicitly sanctioned exception (constitution **v2.4.0**, added 2026-08-07 in response to this feature's analysis). Redis stays real in US3; that fix is fixture-side |
| Golden-pair suite must gate deployment (AI Agent Quality Standards) | ✅ *with recorded deviation* | The constitution names the **LangFuse** golden-pair suite. US2 gates deployment with the **cassette** golden suite in `off` mode against the live provider — same regression pairs, same gating point, no LangFuse dependency. LangFuse stays available at that boundary (prod already carries the keys, `compose.prod.yaml:61-63`), so attaching it is additive and would yield per-trace cost attribution for free. A deliberate deviation, not an oversight |
| Code coverage ≥70% (AI Agent Quality Standards) | N/A | This feature adds no production code — changes are test files, one conftest fixture, cassette data, CI wiring, and one extracted shell script (T034). Existing floors are unaffected and re-verified by T043 |
| Tests assert the SPEC, not the implementation | ✅ | FR-009 derives the row count from the fixture rather than restating an intent |
| E2E required for every feature | ⚠️ | This feature changes only test topology and CI wiring — no product code path changes. Web E2E runs as regression; see Complexity Tracking |
| Evaluation gate must gate deployment | ✅ | US2 is precisely the missing enforcement of this principle |
| Nx as universal task runner | ✅ | New work is exposed as Nx targets, not bare CLI calls |

**No violations requiring justification.**

## Project Structure

### Documentation (this feature)

```
specs/048-test-harness-remediation/
├── spec.md
├── plan.md      # this file
└── tasks.md
```

### Source Code (repository root)

```
agents/movie-assistant/
├── src/models.py                              # seam — read only, no change expected
├── src/eval/cassette.py                       # read only
└── tests/
    ├── integration/
    │   ├── test_out_of_domain.py              # US1: + golden marker, narrow the except, cassette wiring
    │   ├── test_golden_pairs.py               # reference implementation
    │   ├── live_model.py                      # US1: invoke_or_skip must not swallow CassetteMissError
    │   └── conftest.py                        # US1: _LEGITIMATE_SKIPS review
    └── golden/cassettes/                      # US1: new recorded cassettes

mcp-servers/spreadsheet-mcp/
├── src/store.py                               # US3: NOT modified (production design is correct)
└── tests/integration/
    ├── conftest.py                            # US3: new autouse singleton-reset fixture
    └── test_parse_store.py                    # US3: fixture-derived row count

.forgejo/workflows/
├── guardrails.yml                             # US1: golden gate already runs replay here
├── app-ci.yml                                 # US3: enrol MCP suites · US4: per-surface secrets
│                                              # US5: leak step calls the extracted script
├── wiki-maintain.yml                          # US4: ANTHROPIC_API_WIKI_MAINTAIN
└── cd-deploy.yml                              # US2: new live-model pre-deploy gate (CD_GOLDEN)

scripts/
├── dast-leak-scan.sh                          # US5: extracted from app-ci.yml (T034) — new
└── __tests__/dast-leak-scan.test.sh           # US5: RED/GREEN + canary harness — new
```

**Structure Decision**: no new projects or directories. The change is deliberately confined to test
files, one new conftest fixture, cassette data, and CI wiring — the production `store.py` singleton
and the `models.py` seam are explicitly left alone.

## Phased approach

**Phase A (US1 + US2) and Phase B (US3) are independent** and can be built in either order. They are
batched into one feature because a failure in either is unambiguously attributable — a red golden gate
and a red `spreadsheet-mcp` assertion can never be confused for one another
([pull-request-batching](../../openwiki/process/pull-request-batching.md)).

**US1 and US2 must ship together.** US1 alone removes the live signal; US2 is what restores it at the
deploy boundary. Merging US1 without US2 is the failure mode the PRD names explicitly.

### Phases 2–4 ordering (US1 + US2)

1. Narrow the skip-swallowing paths **first**, while the tests still run live. This makes the
   subsequent conversion verifiable — if a cassette is missing, the run must go red, and that must be
   demonstrable before the cassettes exist.
2. Record cassettes on both the runtime and gate models (strategy §5.6).
3. Add the `golden` marker — this simultaneously enrols the tests in the keyless replay gate and
   removes them from `app-ci`'s live-key step, in one change.
4. Build the `off`-mode gate and wire it into `cd-deploy` ahead of promotion.

### Phase 5b ordering (US4 — independent, can land first)

1. Repoint the three secrets (parallel, one line each).
2. Verify no consumer keyed on the **variable name** was disturbed — especially the DAST leak check.
3. Verify by result: zero `secrets.ANTHROPIC_API_KEY` references, then console-confirm distinct keys
   are carrying traffic.
4. Only then delete the old secret. Deleting before the console confirms would turn a botched rename
   into an outage rather than a diff.

### Phase 5c ordering (US5 — independent)

1. **Extract the scan to `scripts/dast-leak-scan.sh` first (T034).** The logic is inline YAML `run:`
   shell with no local entry point, so nothing below is executable until it is extracted. Behaviour
   must be byte-identical — extraction only, no logic change.
2. Establish the fail-open defect by result (3 of 3 cases exit 0 today), then add a preflight that
   fails when a guarded secret is unexpectedly empty, with `ANTHROPIC_API_KEY` conditional on
   `MODEL_PROVIDER`.
3. Prove it with a canary, per secret. **The canary is the point** — a fail-closed assertion that was
   never observed failing is the same unverified control in a new shape.
4. Keep the per-secret `grep` invocations; the preflight is an addition, not a replacement.

### Phase 5 ordering (US3)

1. Fix the row-count assertion (derive from fixture).
2. Add the autouse singleton-reset fixture.
3. Add skip-escalation to the MCP integration suites.
4. Enrol the two keyless projects in `app-ci`.

Skip-escalation lands **before** enrolment, so the suites cannot be added in a state where they could
report green by skipping.

### Phase 5d ordering (US6 — independent, added 2026-08-08)

1. Write the guard test first: with `.env.local` absent, `gen-dev-env.mjs` must create it. This fails
   today (the function returns early), so RED is real.
2. Make `syncEnvFile` create-on-absent for `.env.local`, and correct the stale `.env.example` advice.
3. Rewrite the credential skip messages to carry variable + file + remedy.
4. Prove it end-to-end by DELETING `.env.local` and recovering with one command (SC-012) — the same
   delete-and-recover discipline used for the cassette in T008.
5. Document the detect-and-resolve procedure (FR-025).

## Complexity Tracking

| Item | Why it exists | Simpler alternative rejected because |
|---|---|---|
| Skip-escalation for MCP suites (FR-012) | Without it, enrolling a suite whose fixtures skip on absent Redis reproduces the exact illusion this feature removes | "Just add them to CI" is what the PRD's option C is, and it was explicitly rejected |
| Narrowing `invoke_or_skip` / `_supervisor_model` | A `CassetteMissError` converted to a skip turns the design's loudest signal into green | Leaving them alone would make SC-002 unachievable |
| Cassettes on two models | Routing bugs are model-specific (strategy §5.6) | A single-model dataset gives false confidence |

**E2E deviation**: the constitution requires a web E2E regression for every feature. This feature
changes no product code path — only which tier a test runs in and which jobs invoke it. The web E2E
suite runs as an unchanged-behaviour regression rather than as new coverage; no new E2E scenario is
warranted because there is no new user-visible behaviour to discriminate.

## Open items carried into tasks.md

- Whether `_LEGITIMATE_SKIPS`'s `"no cassette"` entry should be removed outright or scoped to the
  `test_golden_pairs` dataset path. Removing it wholesale may turn the existing golden gate red if any
  of the 41 pairs lacks a cassette — measure before changing.
- Which `cd-deploy` job the live gate attaches to, and whether it gates `build-deploy` as a `needs:`
  dependency or runs as an in-job step before the promotion step.
- ~~A fourth secret is needed and does not exist.~~ **Resolved 2026-08-07**: `ANTHROPIC_API_CD_GOLDEN`
  created. The US2 pre-deploy gate uses it; `ANTHROPIC_API_KEY` is therefore fully unreferenced once
  US4 lands and is deleted in T033.
