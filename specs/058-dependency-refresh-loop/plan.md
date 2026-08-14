# Implementation Plan: close the dependency-refresh gaps 057 left open

**Branch**: `058-dependency-refresh-loop` | **Date**: 2026-08-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/058-dependency-refresh-loop/spec.md`

## Summary

Two coupled gaps deferred by feature 057. **#186**: a pull request whose content is a regenerated
lockfile skips the end-to-end tier — the only tier that catches a bad transitive floor. **#184**: the
dependency bot proposes nothing when an override range already permits a published fix, because it
reasons about manifest ranges and the *lockfile* is what is stale; this cost ten days of red on
`fast-uri` and reddened `main` on `nanoid`.

The approach, per the operator's recorded decisions: add the lockfile and workspace manifest to the
pull-request change filter but not the mobile sub-filter; enable scheduled lockfile maintenance with an
**explicit** window (research R1 proves the obvious form silently never fires); and teach the security
gate to name which lever clears a finding — refresh the lockfile, or raise both halves of the floor.
The half-bump fault #184 was originally filed against is recorded as accepted, its guard unchanged.

Ordering is a requirement, not a preference: the filter must be in force before the first refresh
proposal can exist.

## Technical Context

**Language/Version**: Node.js 24 (ESM, `.mjs`) for scripts and tests; YAML/JSON for CI and bot config

**Primary Dependencies**: `yaml` (already a dependency, used by both existing gates); `node:test` +
`node:assert/strict` as the test runner; `renovate@44` (pinned major, CI-side only — not a repo dependency)

**Storage**: N/A — all inputs are files already in the repository (`pnpm-workspace.yaml`,
`pnpm-lock.yaml`, `security/sast/reports/findings.json`, `.forgejo/workflows/*.yml`, `renovate.json`)

**Testing**: `node --test scripts/__tests__/*.test.mjs` (653 tests today, auto-discovered by
`guardrails.yml:147`); `pnpm nx preflight infrastructure-as-code` (27 checks) as the pre-push sweep

**Target Platform**: Forgejo Actions on a single self-hosted runner; the dev container for local runs

**Project Type**: Repository infrastructure — CI workflow definitions, bot configuration, and guard
scripts. No application code changes.

**Performance Goals**: The accepted marginal cost is one additional end-to-end run (~23 min, web +
integration, no emulator) per dependency pull request, at roughly two proposals per weekly window.

**Constraints**: One CI runner. The forge exposes no job/step or log endpoint, so step-level execution
is unobservable (R3). The bot's throttles are `prConcurrentLimit 5` / `prHourlyLimit 2`. Actions cron is
UTC-only and does not observe daylight saving, so every schedule claim must hold under both offsets.

**Scale/Scope**: 3 configuration/workflow files, 1 new script module, 1 modified gate script, 2 test
files (1 new, 1 extended), 1 fixture, and documentation. No runtime service is touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | Status |
| --- | --- | --- |
| **Test-Driven Development (NON-NEGOTIABLE)** | Yes | **PASS.** Every behavioural change is preceded by a test. `tasks.md` carries the mandated checkpoint format — each test task states the acceptance scenarios it covers and a Verify RED command with its **expected failure output and the reason for it**; each implementation task carries a Verify GREEN. No test in this feature can pass before its implementation, and each wiring assertion is additionally mutation-tested (SC-003, SC-004) because a wiring test is exactly the kind that can pass vacuously. |
| **Test Type Integrity (NON-NEGOTIABLE)** | Yes | **PASS.** Everything added is a genuine unit test: pure file parsing and pure functions, no network, no runner, no mocks of any kind. Nothing is placed under `tests/integration/`, and no external dependency is substituted — there are none to substitute. |
| **Package Manager (pnpm only)** | Yes | **PASS.** No package-manager change. `npm` was used only in a throwaway scratchpad outside the repository, to inspect `renovate@44`'s shipped defaults (R1); nothing was installed into the workspace and no manifest changed. |
| **Nx as universal task runner** | Yes | **PASS.** The test tier runs through the existing auto-discovered `node --test` target and `nx preflight`; no new invocation path is introduced. |
| **Token Compression (RTK)** | Yes | **PASS.** Active for the session. |
| **Security (NON-NEGOTIABLE)** | Yes | **PASS**, and this feature strengthens it. No secret is read, written or logged; the advice prints only finding metadata already present in the scrubbed report. The existing override-consistency guard is unchanged and must keep passing as proof (FR-021). |
| **Logging & Monitoring** | No | The changed scripts are CI gates writing to stdout for a human reader, not production services. |
| **Backend / Frontend / AI Agent principles** | No | No application code in scope. |

**Scope note (repeated from the spec, because it is a gate question):** this feature touches
`.forgejo/workflows/`, `renovate.json` and `scripts/` — all **outside** the directories the SDD gate
governs. The lifecycle is run by choice, as 057 did, because the change reverses a documented decision.

**Post-Phase-1 re-check**: PASS, unchanged. The design added no dependency, no I/O, and no new
invocation path. The one new module is a pure function; the one gate change is additive output that
cannot alter an exit code (FR-018).

## Project Structure

### Documentation (this feature)

```text
specs/058-dependency-refresh-loop/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — R1..R7
├── data-model.md        # Phase 1 output — the three entities and their rules
├── quickstart.md        # Phase 1 output — how to validate this feature end to end
├── contracts/
│   └── override-lever.contract.md    # The advice module's interface + decision table
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
.forgejo/workflows/
└── app-ci.yml                          # MODIFIED — `changes.app` + `push:` paths; the superseded
                                        #   rationale comment replaced, not deleted (FR-007)

renovate.json                            # MODIFIED — lockFileMaintenance enabled with an EXPLICIT
                                        #   schedule (R1); rationale distinguishes the two faults

scripts/
├── override-lever.mjs                   # NEW — pure advice function (no I/O, no exit codes)
├── check-sast-findings.mjs              # MODIFIED — prints an advice section; exit code untouched
├── check-override-consistency.mjs       # MODIFIED — exports its version comparator for reuse.
                                        #   Rule, scope and exit codes unchanged (FR-021)
└── __tests__/
    ├── app-ci-lockfile-filter.guard.test.mjs   # NEW — the six FR-001..FR-006 wiring assertions
    ├── override-lever.test.mjs                 # NEW — the decision table + the fixture reconstruction
    ├── renovate-workflow.guard.test.mjs        # EXTENDED — reuses its cron/DST helpers for FR-009..FR-011
    └── fixtures/
        └── fast-uri-reconstruction.json        # NEW — the measured incident, frozen

specs/057-dependency-security-loop/{spec,research}.md   # MODIFIED — dated correction notes (FR-023)
docs/proposals/PRD-ForgejoIssueTracking.md              # MODIFIED — dated correction note (FR-023)
openwiki/…                                              # MODIFIED only if needed; canonical pages
                                                        #   ship their fingerprint in the same change (FR-024)
```

**Structure Decision**: The repository has no `src/`-style layout for this class of work. Guard scripts
live flat in `scripts/`, their tests in `scripts/__tests__/` where `guardrails.yml:147` auto-discovers
them, and CI definitions in `.forgejo/workflows/`. This feature follows that existing structure
exactly and introduces no new directory except `scripts/__tests__/fixtures/` for the frozen incident.

The one structural judgement is splitting the advice into `scripts/override-lever.mjs` rather than
inlining it in the gate. That mirrors how `allowlist-expiry.mjs` is already factored out of
`check-sast-findings.mjs` — the gate composes pure modules — and it is what allows the decision table to
be unit-tested without invoking the gate or being able to affect its exit code.

## Design overview

### US1 — the filter (FR-001..FR-008)

A filter edit plus a wiring test. `app` gains the two files; `mobile` does not; `push:` paths gain
`pnpm-workspace.yaml` so the two filters agree. The superseded comment at `app-ci.yml:44` is rewritten
to the 057 FR-013 reasoning. `Cargo.lock`'s deliberate divergence is recorded in-file (R2), which is
what #186's third acceptance criterion asks for.

The test asserts six things, each mutation-tested one at a time: both files in `app`; neither in
`mobile`; `mobile ⊆ app`; both in `push:` paths; and `app-e2e` still gated on `changes.outputs.app`.
That last one is the assertion that matters most — the other five are inert the moment it stops holding.

### US2 — the refresh (FR-009..FR-013)

`lockFileMaintenance: { enabled: true, schedule: ["* 2-4 * * 5"] }`. The explicit schedule is the whole
point (R1). The guard test extends `renovate-workflow.guard.test.mjs`, reusing its `cronSlots` and
`windowSlotsInUtc` helpers, and asserts the window is **present** and **intersects** under both offsets.
Its RED is produced by removing the explicit key, which reproduces the trap directly.

### US3 — the advice (FR-014..FR-021)

```
adviseLever(finding, overrides) → null | { package, resolved, permitted, fixFloor, action, message }
```

`action` is `'refresh-lockfile'` or `'raise-floor'`. Pure; returns `null` for no override, an
unparseable half, or a resolution the override does not govern (FR-019, FR-020). The gate prints a
dedicated section when the result set is non-empty and is forbidden from touching the exit code
(FR-018) — asserted by a test that runs the gate over a finding set containing advice-eligible
non-blocking findings and requires exit 0.

### US4 — the record (FR-022..FR-024)

Rationale in `renovate.json` distinguishing the two faults; dated correction notes where the
zero-extraction claim survives; canonical fingerprints updated in the same change if an openwiki page
is touched.

## Verification strategy

Split by what is actually observable (R3):

| Claim | How it is established | Residual |
| --- | --- | --- |
| A lockfile-only PR runs the tier (SC-001) | **Observed** — PR-B's `app-ci/app-e2e` conclusion is not `skipped` | none |
| The emulator half did not run (SC-002) | Wiring test + mutation (SC-003) | step execution unobservable; stated, not implied |
| The schedule trap is caught (SC-004) | Mutation — remove the explicit key, suite must fail | none |
| The advice is correct (SC-005, SC-006) | Fixture reconstruction + a run against live `main` | none |
| The remedy clears the findings (SC-007) | Finding **count** before/after, not exit code | none |
| The guard is unweakened (SC-008) | Its existing tests pass unchanged | none |
| The bot actually proposes a refresh (SC-009) | First scheduled run after merge | **defers item #184's closure** until observed |

Two standing traps are respected throughout: the full SAST scan fail-closes to a vacuously-passing
0-finding report, so `node scripts/sast-scan.mjs --scope full --only pnpm-audit` is used and the
**finding count** is checked rather than the exit code (baseline 55 / 2 blocking); and a successful CI
run publishes no failure digest, so nothing here is verified by reading a run's log.

## Complexity Tracking

> No Constitution Check violations. This table is intentionally empty.
