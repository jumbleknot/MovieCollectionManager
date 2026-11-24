# Implementation Plan: Version-pin guard — every pin is managed or excused

**Branch**: `107-version-pin-guard` | **Date**: 2026-11-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/107-version-pin-guard/spec.md` (backlog item #1128)

## Summary

This adds a required CI check, `scripts/check-version-pins.mjs`, that finds every hand-written version
pin in the workflows, `scripts/`, Dockerfiles and `.devcontainer/`. For each pin it decides whether
Renovate keeps it current. It decides that offline:
- by evaluating `renovate.json`'s customManagers per captured occurrence, not per file;
- by applying the known-action input table that Renovate's built-in github-actions manager uses.

Anything else must carry a reasoned, exact entry in `.forgejo/version-pin-exclusions.json`. Stale and
redundant exclusions fail too.

The day-one inventory (research R4) found five unmanaged pins. Each gets a customManager or a specific
exclusion. The check runs in guardrails' `renovate-config` job using Node built-ins only.

## Technical Context

**Language/Version**: Node.js ESM, the repository's pinned Node (26.13.1 in CI). Built-in modules only.

**Primary Dependencies**: none. It uses `node:fs`, `node:child_process` (`git ls-files`) and the in-repo
`scripts/lib/argv-contract.mjs` and `scripts/lib/is-main.mjs`.

**Storage**: one committed JSON file, `.forgejo/version-pin-exclusions.json` (research R6).

**Testing**: `node:test` unit tests in `scripts/__tests__/check-version-pins.test.mjs` (pure functions
over fixtures), plus one repository-state test that the committed tree passes. Integration and E2E tiers
do not apply: there is no external dependency to integrate with.

**Target Platform**: Forgejo Actions runner (Linux) for CI. The Windows host and the dev container for
local runs (path separators normalised).

**Project Type**: repository CI tooling (`scripts/`), a constitution-sanctioned direct `node` invocation.

**Performance Goals**: completes in well under 2 s on the current tree (about 100 scanned files). It must
not lengthen the `renovate-config` job meaningfully.

**Constraints**:
- offline and deterministic (FR-009);
- no `pnpm install` (R3, R5);
- tracked files only (`git ls-files`), so local untracked files never change the verdict;
- an instrument failure exits 3, never 1.

**Scale/Scope**: about 45 pins today (research R4); 13 customManagers; 4 built-in action inputs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| principle | how this plan complies |
| --- | --- |
| AI Assistant Constraints: technology-agnostic spec | spec.md names only the surfaces guarded. The mechanism lives here and in research.md |
| Behavior-descriptive identifiers | `check-version-pins.mjs`, `detectPins`, `managedOccurrences`, `classifyPins`. No `FR-`/`SC-` IDs in identifiers; IDs appear only in traceability comments |
| Doc-impact sweep (AI Assistant Constraints) | tasks.md runs it for the new terms (`version-pin-exclusions`, `check-version-pins`), with `git grep --untracked` per item #1134, and records it |
| TDD (NON-NEGOTIABLE) | every rule in FR-010 gets a test written first, with a Verify RED (`node --test …` showing the named test failing) and a Verify GREEN, in the RED/GREEN template (`docs/templates/feature-test-tasks-template.md`) |
| Test Type Integrity | unit tests over fixture strings; no mocks of external services (there are none). The repo-state test reads the real tree |
| Nx task runner | sanctioned exception: repository CI scripts under `scripts/` run directly with `node` (constitution, Common Technology Stack) |
| Security | no secrets, no network, read-only. Exclusion reasons are plain text in a tracked file; nothing sensitive |
| Logging & Monitoring | not a service; CI stdout only. The stable line format feeds the existing failure digest |

**Result**: PASS, with no violations, so there is no Complexity Tracking entry.

**Post-design re-check**: PASS. The design adds one script, one test file and one data file, and edits
one workflow step, `renovate.json` (new customManagers) and the renovate runbook. Nothing touches
`backend/`, `frontend/`, `agents/`, `mcp-servers/` or `infrastructure-as-code/`.

## Project Structure

### Documentation (this feature)

```text
specs/107-version-pin-guard/
├── plan.md              # This file
├── research.md          # Phase 0: R1–R7
├── data-model.md        # Phase 1: Pin, Coverage, Exclusion, Verdict
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── cli.md           # invocation, exit codes, output format
│   └── exclusions-file.md
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
scripts/
├── check-version-pins.mjs                      # NEW — detector, coverage evaluator, classifier, CLI
└── __tests__/
    ├── check-version-pins.test.mjs             # NEW — FR-010 rules + repo-state test
    └── cli-entry-guard.guard.test.mjs          # EDIT — add the new script to the --help probes
.forgejo/
├── version-pin-exclusions.json                 # NEW — reasoned exclusions (day-one: expected 1–2)
└── workflows/guardrails.yml                    # EDIT — renovate-config job: one step
renovate.json                                   # EDIT — customManagers for the pins that get one (R4)
.devcontainer/toolchain.Dockerfile              # maybe EDIT — `# renovate:`-free; managers match existing lines
docs/runbooks/renovate.md                       # EDIT — the guard section (FR-012)
openwiki/runbooks/renovate.md                   # EDIT — refreshed in the same PR (V17)
```

**Structure Decision**: a single script, following the existing gate pattern
(`check-toolchain-consistency.mjs`, `refresh-pinned-sha256.mjs`): pure, exported functions tested with
`node:test`, behind an `isMain` CLI shell. No new library directory; the shared argv contract is reused.

## Delivery order (input to /speckit-tasks)

1. **Tests first (RED):**
   - detector shapes, including the flow-form `with:`, comment skipping, and no `command-spec` in JS;
   - coverage per captured offset, including the "file pattern matches, regex misses" case;
   - built-in action inputs;
   - classification: unmanaged, stale, redundant, invalid exclusions;
   - an unsupported `matchStringsStrategy` throws (exit 3).
2. **Implement `check-version-pins.mjs` (GREEN).**
3. **Day-one inventory:** run the real detector, record its output in tasks.md, and resolve each
   unmanaged pin. Add a customManager (verified by the evaluator and by `renovate-config-validator
   --strict`) or an exclusion with a reason.
4. **Repo-state test:** the committed tree passes.
5. **Wire into guardrails `renovate-config`; register in `cli-entry-guard`.**
6. **Docs:** the renovate runbook section, and the openwiki refresh. Run the doc-impact sweep with
   `--untracked`.
7. **Validation:** the quickstart scenarios 1–2 by hand, the full `scripts/__tests__` suite against the
   `main` baseline, and the wiki gates.

## Complexity Tracking

No constitution violations. The table is intentionally empty.
