# Implementation Plan: MCM Maintainability Hardening

**Branch**: `008-maintainability-hardening` | **Date**: 2026-06-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-maintainability-hardening/spec.md`

## Summary

Eliminate the "module named after a requirement ID" anti-pattern repo-wide, codify the rule in the constitution so it cannot recur, and validate with a maintainability code review. A repo scan (Phase 0) found the surface is tiny: exactly **one** first-party source file is ID-named — `frontend/mcm-app/src/utils/fr009.ts` — with **three** importers; no exported symbols and no backend (Rust) artifacts are ID-named. The technical approach is a behavior-preserving rename (`git mv` → a descriptive kebab-case name, FR-009 kept in the JSDoc), updating the three importers, then a MINOR constitution amendment adding the naming principle, gated by the full final-validation test suite (per the spec's clarification) plus a code review.

## Technical Context

**Language/Version**: TypeScript (Expo SDK 56 / React Native 0.85 / React 19.2) for the frontend app; Rust (Edition 2021) for `mc-service` — both in scope for the scan, only the frontend has a hit.

**Primary Dependencies**: None added. Existing tooling only — Nx (test/lint orchestration), pnpm, cargo, ESLint/Prettier, clippy/`cargo fmt`, ripgrep/`grep` for the scan, `git mv` for history-preserving renames.

**Storage**: N/A — no data, schema, or persisted contract changes.

**Testing**: Jest (mcm-app unit + integration), Playwright (web E2E), Maestro (mobile E2E), `cargo test` (mc-service). Per spec SC-003 (clarified), the gate is the **full** suite including the containerized dev-container E2E (web + mobile).

**Target Platform**: Web + Android (Expo app); Linux container (`mc-service`).

**Project Type**: Polyglot monorepo (Expo frontend + Rust backend). This is a **maintenance/refactor + governance** feature, not new runtime functionality.

**Performance Goals**: N/A — zero runtime behavior change; no performance surface.

**Constraints**: Behavior-preserving (no logic/API/schema change); spec-to-code traceability preserved (requirement IDs move to comments/JSDoc); all existing suites stay green; renames use `git mv` to preserve blame.

**Scale/Scope**: Tiny code surface — 1 file rename + 3 import-path updates. Plus 1 constitution amendment (MINOR → v1.5.0) and 1 maintainability review.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

This feature **strengthens** the constitution rather than challenging it. Relevant gates:

| Principle | Status | Notes |
|---|---|---|
| AI Assistant Constraints → **Documentation** ("self-documenting through clear naming"; WHAT-comments prohibited) | ✅ Aligned | The rename improves self-documentation. The retained `// FR-009 …` is a **traceability/provenance** comment (a non-obvious link from code to spec), not a prohibited WHAT-comment. The US2 amendment codifies this exception explicitly. |
| Frontend UI & UX → **User-Centric Naming** (names reflect behavior "to aid readability and AI comprehension") | ✅ Aligned | The new principle generalizes this existing rule from components to all identifiers. |
| **Directory and File Naming** (kebab-case for TS; snake_case for `.rs`) | ✅ Aligned | The new name is kebab-case (`default-collection-auto-nav.ts`); no Rust files are affected. |
| **TDD (NON-NEGOTIABLE)** | ✅ Aligned (refactor) | A pure rename is the **Refactor** step of the TDD cycle — it adds no behavior, so there is no new behavior to test RED-first. The safety net is the **existing green suite**: RED = a broken import/reference after a partial rename (compile/test failure); GREEN = the full suite passing post-rename. No test logic changes; only import paths. |
| **Test Type Integrity / E2E session reuse / Platform Parity** | ✅ Aligned | No test logic added or reclassified; the existing suites are reused unchanged. No new test scenarios → the Platform Parity Table records "no new scenarios; existing suites are the regression gate." |
| **Governance / Amendment process** | ✅ Followed | US2 amends via the documented process (rationale + impact + migration), **MINOR** bump (guidance addition) → v1.5.0. |

**Result: PASS — no violations.** Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/008-maintainability-hardening/
├── plan.md              # This file
├── research.md          # Phase 0 — the rename inventory + decisions
├── data-model.md        # Phase 1 — N/A (no entities)
├── quickstart.md        # Phase 1 — run-the-cleanup + verification runbook
├── checklists/
│   └── requirements.md   # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

(No `contracts/` directory: this feature exposes no external interface — it is an internal rename + a governance doc change.)

### Source Code (repository root)

```text
frontend/mcm-app/src/
├── utils/
│   ├── fr009.ts                      # → RENAME to default-collection-auto-nav.ts (git mv; FR-009 stays in JSDoc)
│   └── unit-tests/                   # (no test exists for this util today; behavior unchanged)
├── hooks/
│   └── use-auth.tsx                  # importer → update path
└── screens/home/
    ├── home-screen.tsx               # importer → update path
    └── home-screen.test.tsx          # importer → update path

backend/mc-service/src/              # scanned — NO ID-named artifacts (no changes)

.specify/memory/
└── constitution.md                  # add naming principle (MINOR → v1.5.0)
```

**Structure Decision**: Polyglot monorepo (Expo frontend + Rust backend), per the constitution's mandated layout. The change is confined to the frontend `utils/` + its three importers and the constitution document; the backend is in scope for the scan but has no hits.

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.
