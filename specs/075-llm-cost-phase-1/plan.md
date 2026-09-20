# Implementation Plan: LLM cost reduction, phase 1 — no new vendor

**Branch**: `075-llm-cost-phase-1` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/075-llm-cost-phase-1/spec.md`

## Summary

Halve the measured $74.89/30-day model spend without adding a vendor, by changing
two model defaults, one generator model id, and the *shape* of one prompt — then
asserting in-repo that the shape change actually buys what it is supposed to buy.

The technical approach, established in [research.md](./research.md):

- **Generator**: one env value in `infrastructure-as-code/project.json`. The existing
  offline guard already accepts the new id (verified at both resolution layers, R6);
  nothing else moves.
- **Classification**: `classify_intent` stops building one string and builds
  `[SystemMessage(<static, cache_control: ephemeral>), HumanMessage(<user text>)]`.
  One shape for both providers — verified inert on Ollama and on the fast Anthropic
  tier, honoured on the cached tier (R1). No provider branch.
- **Model selection**: two table edits plus environment pins on exactly the burst
  surfaces. The golden gate deliberately keeps the code defaults so it still certifies
  what production runs (R3 — this corrects the proposal).
- **Verification**: one offline unit test proving the cached prefix is byte-stable, and
  one live-model integration test proving a repeated classification is served from
  cache, gated by the existing fail-not-skip escalation (R7).

Ships as **two independent merges** (FR-020) so a red pipeline names its own cause.

## Technical Context

**Language/Version**: Python 3.14 (agent gateway); Node/JSON configuration elsewhere

**Primary Dependencies**: `langchain-core 1.6.2`, `langchain-anthropic 1.7.2`,
`langchain-ollama 1.1.0`, `anthropic 1.5.0`, `openwiki 0.5.2` (all installed versions
verified in R1/R2/R6; no dependency is added, removed or bumped by this feature)

**Storage**: N/A — no persisted state changes. Committed JSON cassettes under
`agents/movie-assistant/tests/golden/cassettes/` are regenerated fixtures, not storage.

**Testing**: `pytest` via Nx (`test`, `test:integration`, `test:golden`,
`test:golden-live`); `node --test` for the generator guard; Playwright/Maestro for
`app-e2e`

**Target Platform**: Linux containers (agent gateway, CI runners, dev container)

**Project Type**: Polyglot Nx monorepo — this feature touches the Python agent gateway,
the infrastructure Nx project, two Forgejo workflows, the dev-container definition and
the knowledge bundle

**Performance Goals**: No latency target. The cached tier adds negligible per-call
latency and is only selected on non-interactive surfaces.

**Constraints**:

- The static classification prefix MUST be byte-identical across calls (FR-006) — the
  entire saving is a prefix match.
- Production MUST NOT move to the cached tier; break-even is a ≈65% hit rate that real
  user traffic cannot reach (R8).
- A cassette miss MUST fail, never skip — constitutional requirement, and the ordering
  in `invoke_or_skip` that guarantees it must not be weakened (R5).

**Scale/Scope**: ~29M classification input tokens/month on the CI surface; 43 committed
cassettes to re-record (31 + 11 Anthropic, 1 Ollama); 5 source files, 2 workflows,
4 documents.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. No violations.*

| Principle | Assessment |
|---|---|
| **TDD (NON-NEGOTIABLE)** | PASS. Both new tests are written and verified RED before the change they cover. The prefix-stability unit test is RED while the prompt is still one string (no static block exists to assert on); the cache assertion is RED on the fast tier (`cache_read` is 0 because 2,650 < 4,096). `tasks.md` will carry the mandated Verify RED / Verify GREEN commands per `docs/templates/feature-test-tasks-template.md`. |
| **Test Type Integrity (NON-NEGOTIABLE)** | PASS. The cache assertion needs the *real* provider — a replayed cassette carries no usage metadata — so it is a genuine integration test with nothing mocked, placed in `tests/integration/` and excluded from the golden marker. The prefix-stability test touches one pure function with no IO and is a genuine unit test. |
| **Sanctioned exception — agent golden tier** | PASS, and relied upon. The constitution states cassettes are keyed on `sha256(model_id + normalized prompt)` so "a prompt or model change produces a loud miss, never a stale pass; a cassette miss MUST fail the run and MUST NOT be converted to a skip". This feature triggers that loud miss deliberately and re-records; it does not widen the exception, and it preserves the type-before-text ordering in `invoke_or_skip` that keeps a miss from being read as capacity. |
| **Agent Architecture Boundaries** | PASS. Additive and non-breaking; no route, no domain logic, no tool surface changes. Only which model answers a classification. |
| **Identity Propagation (NON-NEGOTIABLE)** | PASS, explicitly preserved. `runtime_env`'s no-shared-fallback rule and its dropping of per-node pins on a provider switch are unchanged and are what make the new environment pins safe under BYOK (FR-015/FR-016, R10). |
| **Agent Security — Secrets** | PASS. No new credential. The new live test reads the same `ANTHROPIC_API_KEY` the tier already uses, and asserts on a token *count*, never on prompt or key material. |
| **Agent Security — Rate Limiting / token spend** | ADVANCED. The per-user `costLimitUsd` ceiling is unchanged, but a cheaper extractor buys each user ~30% more turns under the same ceiling. |
| **Logging & Monitoring** | PASS. No new log lines. The cache signal is read from a response object inside a test, not logged. |
| **Model-provider scoping invariant** | PASS with a required doc update (FR-019). The invariant's premise — provider is env-scoped per environment, not one global choice — is exactly what this feature leans on; the specific ids it names change and must be corrected in the canonical page. |
| **Nx as universal task runner** | PASS. Every command runs through an existing Nx target; no target is added. |

**Post-Phase-1 re-evaluation**: unchanged. The design added no new project, no new
dependency, no new abstraction and no new credential. Complexity Tracking is therefore
empty and omitted.

## Project Structure

### Documentation (this feature)

```text
specs/075-llm-cost-phase-1/
├── spec.md              # /speckit-specify output
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output — 10 findings, 3 corrections to the proposal
├── data-model.md        # Phase 1 output — the model-selection entities
├── quickstart.md        # Phase 1 output — runnable validation
├── contracts/
│   └── model-selection.md   # Phase 1 output — env → model-tier contract per surface
├── checklists/
│   └── requirements.md      # spec quality validation
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
agents/movie-assistant/
├── src/
│   ├── models.py                       # _BALANCED_DEFAULTS["anthropic"] → fast tier (FR-013)
│   └── nodes/
│       └── supervisor.py               # classify_intent: string → [System(cached), Human] (FR-005/006)
└── tests/
    ├── unit/
    │   └── test_supervisor_prompt_cache.py      # NEW — prefix byte-stability, offline (FR-006)
    ├── integration/
    │   ├── live_model.py                        # reused unchanged — fail-not-skip escalation
    │   └── test_prompt_cache_effectiveness.py   # NEW — cache_read > 0, live (FR-009..012)
    └── golden/cassettes/                        # 43 cassettes re-recorded (FR-017)

infrastructure-as-code/
└── project.json                        # OPENWIKI_MODEL_ID → claude-sonnet-5 (FR-001)

scripts/__tests__/
└── wiki-maintain.guard.test.mjs        # RUN UNCHANGED — must pass as-is (FR-004)

.forgejo/workflows/
└── app-ci.yml                          # app-e2e job env: supervisor pin (FR-007)

.devcontainer/
└── devcontainer.json                   # local runs take the same pin (FR-007)

infrastructure-as-code/docker/agents/
└── compose.prod.yaml                   # header comment only — still pins nothing (FR-008/019)

openwiki/invariants/model-provider-scoping.md   # canonical — learning goes here (FR-019)
docs/runbooks/agent-layer.md                    # cited source (FR-019)
```

**Structure Decision**: No new project, directory or module. The feature edits two
tables and one function in the existing gateway, one env block in the existing
infrastructure project, and adds two test files to the two existing test tiers. The
only structural judgement is *which* tier the cache assertion belongs to, resolved by
Test Type Integrity: it drives the real provider, so it is an integration test, and it
carries no `golden` marker so the keyless replay gate stays keyless (FR-018).

## Delivery sequence

Two merges, ordered so the risk-free one is not held hostage by the risky one
(FR-020, SC-007). This follows the repository's PR-batching rule: batch by default,
split when a red pipeline would otherwise be ambiguous — and here it genuinely would
be, because a re-recorded cassette, a downgraded specialist and a restructured prompt
all land in the same suite.

**Merge 1 — generator (US1).** `OPENWIKI_MODEL_ID`, plus the guard run and the doc
line. No application code, no cassettes, no e2e. Green or red is unambiguous. Merge
first so the queued #525/#526 regeneration runs on the cheaper model.

**Merge 2 — gateway (US2 + US3).** The prompt restructure, both defaults, both new
tests, the workflow and dev-container pins, the cassette re-record and the remaining
docs. US2 and US3 are *not* split from each other: both invalidate the same 43
cassettes, so splitting them would mean re-recording twice at double the live cost for
no diagnostic gain — the failure signatures (a classification regression vs an
extraction regression) are already distinct within one suite because the cassettes are
per-pair.

## Risks and how the plan answers each

| Risk | Answer |
|---|---|
| The prefix silently stops caching after a later edit | The offline prefix-stability unit test fails at merge time; the live assertion fails at deploy time. Neither can skip (R7). |
| `qwen2.5` regresses on the new message shape | Re-record its one cassette and run the Ollama tier; if it regresses, fall back to the string shape on the Ollama path only (R9). Measured, not assumed. |
| The Ollama-only cassette is forgotten | Called out as its own task with its own credential requirement (a local Ollama, not an Anthropic key). Missing it surfaces as a `CassetteMissError` in a suite nobody associates with this change (R5). |
| The cheaper extractor degrades extraction quality | The 11 re-recorded extraction pairs are the gate. A failure blocks the change; it is not waived. |
| A cassette miss is misread as provider capacity | `invoke_or_skip` re-raises `CassetteMissError` by type *before* its text heuristic. The plan forbids touching that ordering (R5, and the constitution requires it). |
| The live gate certifies a model production does not run | Corrected by R3 — the golden gate keeps the code defaults. |
| Re-record cost is treated as incidental | Budgeted as its own task. 43 cassettes against a live key, plus one local Ollama recording. |

## Out of scope

Explicitly deferred to the proposal's later phases and not foreclosed by anything here:
a cheaper non-Anthropic generator provider (phase 2); an OpenAI-compatible provider
adapter and the BYOK UI to expose it (phase 3); surfacing per-user running cost against
`costLimitUsd` (phase 4). The escalation tier stays pinned and dormant throughout.
