# Implementation Plan: CI diagnostics gap closure and E2E agent-gate fix

**Branch**: `051-ci-diagnostics-closure` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/051-ci-diagnostics-closure/spec.md`

## Summary

Close two false-signal failures in CI that share a cause-class — something that had to cross a
container boundary did not — plus two small riders.

Phase 0 research changed the shape of this materially, and the change is the most important thing in
this plan: **the PRD's headline diagnosis is wrong.** Step logs do *not* need to survive container
teardown, because the digest that reads them runs inside the same container. The reason every
guardrail failure was undiagnosable is that **most steps are never wrapped at all** — 13 of 16
`run:` steps in `guardrails / naming`, including every actual gate — and the coverage gate meant to
enforce instrumentation only requires *one* wrapped step per job. The reason the digest published
nothing on 2026-08-01 is separately that it could not authenticate. See
[research.md](./research.md) R1-R3.

So the work is: forward the environment flags the E2E container is missing (two silent skips, not
one), instrument the steps that can actually fail and tighten the gate that is supposed to require
it, make a broken digest distinguishable from an unneeded one, and give the digest a credential path
that survives a secretless run. Then the two riders.

## Technical Context

**Language/Version**: Node.js ≥ 22.13 (CI scripts, ESM `.mjs`); Bash (step wrapper); YAML (Forgejo
Actions); TypeScript (Playwright E2E harness); Markdown (knowledge bundle)

**Primary Dependencies**: none added. All CI scripts are dependency-free by design — they import only
Node built-ins and sibling scripts, because `guardrails / naming` runs them via
`node --test scripts/__tests__/*.test.mjs` before any install step exists.

**Storage**: filesystem only — per-run step-log directories under `$HOME/mcm-ci-step-logs/<run-id>/`;
the forge's generic package registry for full failure bundles.

**Testing**: `node --test scripts/__tests__/*.test.mjs` (unit, offline, fixture-driven);
`scripts/__tests__/*.guard.test.mjs` for gate self-tests; Playwright for the web E2E surface;
deliberate CI runs on this branch for the two success criteria that cannot be proven by inspection.

**Target Platform**: Forgejo Actions on a single self-hosted runner with two executors — `kvm` (host)
and `ubuntu-latest` (container). Developer workstations: Linux dev container and Windows host.

**Project Type**: repository tooling and CI configuration. No application runtime code changes.

**Constraints**:
- CI scripts must stay offline, deterministic and dependency-free; `js-yaml` is *not* available to
  them (confirmed — it is absent from the root `node_modules`), so any workflow parsing added to the
  coverage gate must use the same line-oriented approach the gate already uses.
- A broken digest must never fail, mask or delay a real job result.
- Anything newly published must pass `redactForPublication`.
- The runner is persistent, so per-run scoping is load-bearing, not hygiene.

**Scale/Scope**: 6 workflow files carrying 14 containerized jobs, 83 `run:` steps in total of which
**48 are uninstrumented**; 4 CI scripts; 1 Playwright invocation; 2 documentation targets.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Result: **PASS**, one
justified deviation recorded below.*

| Principle | Assessment |
| --- | --- |
| **TDD (NON-NEGOTIABLE)** | PASS. Every script change is covered by `scripts/__tests__/*.test.mjs` with a Verify RED before implementation. The Playwright forwarding change and the deliberate-breakage rehearsals are verified by observed result (executed-spec counts, published signal), not exit status — which is what FR-022 demands. |
| **Test Type Integrity** | PASS. The changes are to unit-tested scripts and to CI configuration. No test is reclassified; no external dependency is mocked inside an integration directory. |
| **Behavior-Descriptive Identifiers** | PASS. New symbols are named for behaviour (e.g. a digest-outcome describer, a step-instrumentation gate). Requirement IDs appear only in provenance comments. Environment-variable names are an external contract and are exempt where they already exist. |
| **Documentation** | PASS. Story 6 is documentation; Stories 1-4 update `docs/runbooks/ci-diagnostics.md` alongside the behaviour change, as the constitution requires documentation to move with implementation. |
| **Secrets Management** | PASS, and materially exercised. The R7 probe prints a token's **length and an HTTP status only**, never the value. Newly published output passes through the existing redaction. `KEYCLOAK_SERVICE_CLIENT_SECRET` is added as a `secrets.*` reference in the workflow, never a literal. |
| **Sensitive Data Prohibition (Logging)** | PASS. Step logs are already redacted before publication; instrumenting *more* steps widens what is captured, so the plan explicitly re-checks redaction coverage against the newly wrapped steps rather than assuming it carries over. |
| **No Vibe Coding** | PASS. The one significant deviation from the input PRD (rejecting §3.1) is documented with its evidence in research.md R1 and surfaced to the operator, not silently applied. |

### Deviation from the input document, recorded deliberately

The PRD names §3.1 (relocate step logs to the workspace) as the load-bearing fix. This plan
**rejects** it on evidence. That is a deviation from an approved input document, so per "No Vibe
Coding" it is documented here and in research.md R1 with the reproduction that establishes it, and
the PRD is annotated as part of Story 2 rather than left to contradict the implementation.

## Project Structure

### Documentation (this feature)

```text
specs/051-ci-diagnostics-closure/
├── plan.md              # This file
├── spec.md              # Phase -1 output (/speckit-specify)
├── research.md          # Phase 0 output — the decisions that reshaped this plan
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output — how to validate each story
├── contracts/
│   ├── digest-outcome.md          # the three-way outcome signal + its report strings
│   ├── step-instrumentation.md    # what the coverage gate requires and how to exempt
│   └── e2e-env-forwarding.md      # which env vars must reach the Playwright container
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
.forgejo/workflows/
├── app-ci.yml             # Story 1 (env forwarding); Story 2 (wrap bare steps)
├── guardrails.yml         # Story 2 — the largest instrumentation gap
├── infra-image-scan.yml   # Story 2
├── wiki-maintain.yml      # Story 2
├── renovate.yml           # Story 2
└── cd-deploy.yml          # Story 2

scripts/
├── ci-failure-digest.mjs          # Stories 3 + 4 — outcome marker, credential fallback
├── ci-status.mjs                  # Story 3 — report "ran and failed" vs "not published"
├── check-ci-digest-coverage.mjs   # Story 2 — require every run step wrapped or exempt
├── ci-log-step.sh                 # unchanged (research R1) — no relocation
└── __tests__/
    ├── ci-failure-digest.test.mjs
    ├── ci-status.test.mjs             # Story 5 — the Windows assertion
    └── check-ci-digest-coverage.test.mjs

frontend/mcm-app/tests/e2e/web/
└── setup/agent-stack-gate.ts      # unchanged — the gate is correct; only its input was missing

docs/
├── proposals/PRD-CIDiagnosticsGapClosure.md   # annotate: §1.3 closed, §3.1 rejected with evidence
└── runbooks/
    ├── ci-diagnostics.md    # Stories 2-4 — the new outcome vocabulary + instrumentation rule
    └── devcontainer.md      # Story 6 — offline resolution + stale toolchain-scope claim

openwiki/
├── gotchas/<new canonical concept>.md   # Story 6 — whole-crate formatting scope trap
└── policy.yaml                          # must permit the paths Story 6 touches
```

**Structure Decision**: no new projects or directories. This feature changes repository tooling in
place — six workflow files, four CI scripts and their unit tests, and two documentation targets.
`ci-log-step.sh` is deliberately **not** changed, which is the plan's single most consequential
structural decision and is justified in research.md R1.

## Execution Sequence

Ordered by dependency, not by story number. The one hard ordering constraint is R7.

1. **Story 5 (#157)** and **Story 6 (#155)** — independent of everything, no CI required. Do first
   so the branch carries value even if the CI-dependent work stalls.
2. **Story 1 (#158)** — self-contained workflow edit; unblocks the question of whether the agent
   specs are actually green, which may widen scope and is therefore worth learning early.
3. **Story 3** — the digest outcome signal. Pure script + unit test; also builds the vocabulary
   Story 4 reports through.
4. **Story 2** — instrumentation sweep and the stricter coverage gate. Largest mechanical change;
   the tightened gate must land with the wrapping, or it fails the build it is added in.
5. **R7 probe** — temporary commit, answers the auto-token question.
6. **Story 4** — implemented against whatever R7 returns.
7. **Rehearsals for SC-002 and SC-005** — deliberate breakage, evidence captured.
8. **Revert every temporary commit**, verify the branch tip is clean, then open the PR.

## Risks and how each is handled

| Risk | Handling |
| --- | --- |
| The auto token cannot write statuses on a secretless run (R7) | Story 4 is sequenced behind the probe. If it returns negative, Story 4 degrades to making the secretless condition itself loud through Story 3's vocabulary, and the spec's SC-004 is renegotiated with the operator rather than silently weakened. |
| Newly-running agent specs fail (item #150's open question) | Expected, not a surprise. Triage and either fix or attribute to a baseline with evidence. Reverting to a skip is prohibited. If the fix is a product defect beyond the harness, it is filed and split. |
| Wrapping 48 more steps widens what gets captured and published | Re-check `redactForPublication` coverage against the newly wrapped steps explicitly; do not assume it carries over. |
| The stricter coverage gate breaks CI the moment it lands | It ships in the same change as the wrapping it requires, and its own self-test proves both the pass and the fail path before the real scan — the pattern the other gates in `guardrails / naming` already use. |
| Deliberate-breakage commits reach `main` | FR-023: revert before merge and verify the branch tip. The final validation step greps the branch diff for the probe and breakage markers. |
| A digest change makes a broken digest fatal | The unconditional exit 0 and `continue-on-error` both stay. The new signal is a side effect, never a status change. Covered by an explicit unit test. |

## Complexity Tracking

No constitution violations require justification. The one deviation (rejecting PRD §3.1) is a
*reduction* in scope and complexity relative to the input document, evidenced in research.md R1.
