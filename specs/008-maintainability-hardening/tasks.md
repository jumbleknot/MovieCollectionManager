# Tasks: MCM Maintainability Hardening

**Feature**: `008-maintainability-hardening` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Nature**: behavior-preserving **refactor** (1 file rename + 3 import updates) + a constitution amendment + a code review. The only new test is a **characterization** test (T005) that locks the renamed util's *existing* behavior; everything else is gated by the *existing* green suites. Under TDD this is the **Refactor** step: the RED state is a broken import/reference after a partial rename (compile/test failure); the GREEN state is the full suite passing post-rename. (The characterization test is honestly not RED-first — the behavior already exists — so it is labeled as such, not as new-feature TDD.)

---

## Phase 1: Setup

- [x] T001 Confirm baseline + inventory: verify the branch is `008-maintainability-hardening` (off a green `main`, feature 007 merged), RTK active, and re-run the ID-name scan to confirm the surface — exactly `frontend/mcm-app/src/utils/fr009.ts` with 3 importers, 0 exported symbols, 0 backend hits (commands in [quickstart.md](./quickstart.md) §1; details in [research.md](./research.md) R1).

**Checkpoint**: scope confirmed = 1 file + 3 importers.

---

## Phase 2: Foundational (blocking prerequisite)

- [x] T002 Capture the pre-rename GREEN baseline so the rename's behavior-preservation is provable: `pnpm nx test mcm-app`, `pnpm nx test:integration mcm-app`, `pnpm nx test mc-service`, `pnpm nx test:integration mc-service`, `pnpm nx lint mcm-app`, `pnpm exec tsc --noEmit` (in `frontend/mcm-app`) — record all green.

**Checkpoint**: known-green baseline recorded; any later failure is attributable to the rename.

---

## Phase 3: User Story 1 - Behavior-descriptive identifiers (Priority: P1) 🎯 MVP

**Goal**: rename the one ID-named module to a behavior-descriptive name, update its importers, preserve the FR-009 traceability in JSDoc, with zero behavior change.

**Independent Test**: the ID-name scan returns zero hits, the renamed module's JSDoc cites FR-009, and the full suite (incl. the new characterization test) is green.

- [x] T003 [US1] `git mv frontend/mcm-app/src/utils/fr009.ts frontend/mcm-app/src/utils/default-collection-auto-nav.ts` (preserve history; do NOT rename the exported functions `isAutoNavDone`/`markAutoNavDone`/`clearAutoNav` or the `mcm_auto_nav_done` storage key — FR-005).
- [x] T004 [US1] Update the module JSDoc header in `frontend/mcm-app/src/utils/default-collection-auto-nav.ts`: lead with the behavior ("tracks whether the post-login auto-navigation to the user's default collection has fired this session") and retain the **FR-009** reference as a traceability line (FR-003).
- [x] T005 [P] [US1] Add a **characterization** unit test in `frontend/mcm-app/src/utils/unit-tests/default-collection-auto-nav.test.ts` that locks the existing behavior of `isAutoNavDone` / `markAutoNavDone` / `clearAutoNav`: (a) native path (module-level flag) — false initially, true after `markAutoNavDone`, false after `clearAutoNav`; (b) web path — `markAutoNavDone` writes the `mcm_auto_nav_done` sessionStorage key, `isAutoNavDone` reads it, `clearAutoNav` removes it. Use `jest.resetModules()` per test to reset the module-level flag. Verify GREEN: `pnpm nx test mcm-app -- --testPathPattern default-collection-auto-nav`. (Characterization test of pre-existing behavior — not RED-first.)
- [x] T006 [P] [US1] Update the import specifier `@/utils/fr009` → `@/utils/default-collection-auto-nav` in `frontend/mcm-app/src/hooks/use-auth.tsx`.
- [x] T007 [P] [US1] Update the import specifier `@/utils/fr009` → `@/utils/default-collection-auto-nav` in `frontend/mcm-app/src/screens/home/home-screen.tsx`.
- [x] T008 [P] [US1] Update the import specifier `@/utils/fr009` → `@/utils/default-collection-auto-nav` in `frontend/mcm-app/src/screens/home/home-screen.test.tsx`.
- [x] T009 [US1] **Verify GREEN — full final-validation gate (SC-003)**: `pnpm nx test mcm-app` + `pnpm nx test:integration mcm-app` + `pnpm nx test mc-service` + `pnpm nx test:integration mc-service` + `pnpm nx lint mcm-app` + `pnpm exec tsc --noEmit` + `pnpm nx lint mc-service` (clippy), then the **containerized dev-container E2E** per the 007 procedure: `pnpm nx docker-build mcm-app`; `docker compose --profile bff-dev up -d`; `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` (expect 93/93) + mobile `pnpm nx e2e:mobile mcm-app` (expect 20/20). Reset to Metro afterward (`docker compose rm -sf mcm-bff-dev caddy mcm-bff`; revert `.env.local`). Expected: every suite matches the T002 baseline (zero new failures), plus the new characterization test passes.
  - *Verify RED (refactor):* if T006–T008 are incomplete, the build/unit run fails with an unresolved-module error for `@/utils/fr009` — confirming the rename is load-bearing.
- [x] T010 [US1] Re-run the ID-name scan (quickstart §1): confirm **zero** ID-named files/exported identifiers remain (SC-001) and the renamed module carries the FR-009 traceability comment (SC-002).

**Checkpoint**: US1 is independently shippable — the anti-pattern is gone, behavior unchanged, full suite green.

---

## Phase 4: User Story 2 - Codified naming convention (Priority: P2)

**Goal**: add the naming principle to the constitution so the anti-pattern cannot recur.

**Independent Test**: the constitution contains the principle, version is bumped to v1.5.0, no dependent template contradicts it.

- [x] T011 [US2] Run `/speckit-constitution` to add, under **AI Assistant Constraints**, a **Behavior-Descriptive Identifiers** principle: "Code identifiers (files, modules, exported symbols) MUST describe behavior. Requirement/spec IDs MUST NOT appear in identifiers; they belong in comments/JSDoc for traceability." Include a one-line rationale and the traceability-comment carve-out (reconciling the "no WHAT-comments" rule). MINOR bump `.specify/memory/constitution.md` v1.4.0 → **v1.5.0** with a version-history entry; let the skill sync dependent templates (research R4).
- [x] T012 [US2] Verify the amendment (SC-004): the principle is present under AI Assistant Constraints, `**Version**: 1.5.0` is set, the version-history block has the new entry, and no dependent template (`.specify/templates/*`) contradicts it.

**Checkpoint**: the convention is governed; future ID-named identifiers are a review-flagged violation.

---

## Phase 5: User Story 3 - Maintainability code review (Priority: P3)

**Goal**: a detailed maintainability review confirms the cleanup is complete/correct and surfaces no new issues.

**Independent Test**: the review runs over the branch with 0 unresolved High/Critical findings.

- [x] T013 [US3] Run the project code review over the branch (`/code-review`, or `/code-review ultra` for the multi-agent cloud review): focus on the rename's completeness, traceability, behavior-preservation, and adjacent readability.
- [x] T014 [US3] Resolve all **High/Critical** findings on the branch; triage **Medium/Low** with a written rationale or a follow-up note (SC-005).

**Checkpoint**: review clean; SC-006 (purpose-clear-from-name) confirmed for the renamed module.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T015 [P] Doc sweep: grep `docs/`, `README*`, and `CLAUDE.md` for `fr009` / `@/utils/fr009`; update any that point at the old name. Do **NOT** touch `specs/**` (those legitimately cite FR-009 for traceability).
- [x] T016 [P] Confirm no regression in lint/format gates: `pnpm nx lint mcm-app` (ESLint 0) + Prettier check + `cargo fmt --check` / `cargo clippy` for mc-service — all clean.
- [x] T017 `rtk gain` → confirm >80% per-test-run compression (constitution; run last).
- [x] T018 Run the [quickstart.md](./quickstart.md) Definition-of-Done checklist end-to-end (SC-001…SC-006).

---

## Platform Parity Table

This feature is a behavior-preserving refactor + governance change; it adds **no new user-facing UI flows and no new E2E test scenarios** (the one new unit test, T005, is non-UI). The pre-existing web (Playwright) and mobile (Maestro) suites are reused unchanged as the regression gate (T009).

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| (none new) — rename behavior-preservation | existing suite reused as regression gate (T009) | existing suite reused as regression gate (T009) | N/A — refactor adds no scenarios (justification: no new behavior; both clients' full suites must stay green) |

No `❌ Gap` rows: the N/A is justified (no new behavior to test; existing both-client suites gate the change).

---

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002)** → **US1 (T003–T010)** → **US2 (T011–T012)** → **US3 (T013–T014)** → **Polish (T015–T018)**.
- **US1** is the MVP and blocks US2/US3 (the review reviews the rename; the constitution codifies the lesson).
- **Within US1**: T003 (`git mv`) blocks T004 (JSDoc), T005 (test references the new path), and T006–T008 (importers reference the new path). T005/T006/T007/T008 are **[P]** (four different files). T009 (verify) requires T003–T008. T010 (scan) requires T009.
- **Polish**: T015/T016 are **[P]**; T017/T018 run last.

## Parallel Execution Examples

- US1 — once T003 lands, run together: **T005** (new unit test), **T006**, **T007**, **T008** (import updates) — four different files, no shared state.
- Polish: **T015, T016** in parallel.

## Implementation Strategy

**MVP = US1 alone** (T001–T010): the anti-pattern is removed, locked by a unit test, and proven behavior-preserving — a complete, shippable increment. US2 (governance) and US3 (review) harden and validate it but are not required for the rename to deliver value. Recommended order: ship US1 → amend constitution (US2) → review (US3) → polish.
