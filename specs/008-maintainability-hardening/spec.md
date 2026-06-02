# Feature Specification: MCM Maintainability Hardening

**Feature Branch**: `008-maintainability-hardening`

**Created**: 2026-06-02

**Status**: Draft

**Input**: User description: "Repo-wide cleanup of files/modules named after spec requirement IDs (rename to behavior-descriptive names, keep the FR-id in JSDoc); add a constitution principle that identifiers describe behavior while requirement IDs live in comments/JSDoc for traceability; then a detailed code review. All tests must stay green."

## Clarifications

### Session 2026-06-02

- Q: Scope breadth — does the cleanup target only files/modules, or also in-code identifiers named after spec IDs? → A: Files/modules **and exported** in-code identifiers (functions, types, constants); private/local identifiers (not crossing a module boundary) are out of scope.
- Q: Which test suites gate the behavior-preserving cleanup? → A: The **full** final-validation suite — unit + integration + the **complete E2E run against the dev BFF container** (web `E2E_BFF_TARGET=dev-container` + mobile Maestro), per the feature-007 procedure.

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are the people and tools that read and maintain the codebase: **developers** and **AI coding assistants**. The value is faster comprehension, fewer spec cross-references, and a governing rule that keeps the codebase readable over time — with **zero change to runtime behavior**.

### User Story 1 - Behavior-descriptive identifiers (Priority: P1)

A developer (or AI assistant) reads an `import` or opens a file and understands what it does **from the name alone**, without having to look up a spec requirement ID. Today, artifacts named after requirement IDs (e.g. `utils/fr009.ts`) force a cross-reference: the functions inside are well-named (`isAutoNavDone`, `markAutoNavDone`, `clearAutoNav`) but the filename communicates nothing. This story renames every first-party source artifact named after a spec ID to a name that describes its behavior, while preserving the requirement-ID link in a comment/JSDoc for traceability — and changes no behavior.

**Why this priority**: This is the core deliverable and the MVP. It directly removes the readability/comprehension cost the PRD identifies, and it stands alone as a shippable improvement even if the governance (US2) and review (US3) are deferred.

**Independent Test**: Run a repo scan for first-party code identifiers named after requirement/task IDs (e.g. `fr009`, `fr-009`, `t012`); confirm none remain (excluding justified external-contract cases). Confirm each renamed artifact carries its requirement ID in a comment/JSDoc, all imports resolve, and the full existing test suite passes unchanged.

**Acceptance Scenarios**:

1. **Given** `frontend/mcm-app/src/utils/fr009.ts` (named after FR-009), **When** the cleanup runs, **Then** the file is renamed to a behavior-descriptive name (e.g. `default-collection-auto-nav.ts`), every importer is updated, the FR-009 reference is retained in the file's JSDoc, and all tests pass.
2. **Given** any other first-party source file/module/exported symbol named after a spec ID, **When** the cleanup runs, **Then** it is likewise renamed to describe its behavior with the ID preserved in a comment, and no test logic changes (only import paths).
3. **Given** the renames are complete, **When** the unit, integration, and E2E suites run, **Then** they are all green with no new failures — proving the change is behavior-preserving.

---

### User Story 2 - Codified naming convention (Priority: P2)

A contributor adding new code has an explicit, discoverable rule that prevents re-introducing the anti-pattern: **identifiers describe behavior; requirement IDs belong in comments/JSDoc for traceability.** This is added as a principle in the project constitution so it governs all future work and is enforced in review.

**Why this priority**: Without the codified rule the cleanup decays — the next feature reintroduces ID-named artifacts. The governance is what makes the improvement durable, but it depends on the principle being agreed, so it follows the concrete cleanup.

**Independent Test**: Confirm the constitution contains a new, clearly worded principle stating the convention; the constitution version is bumped per its own amendment process; and any dependent templates/checklists that reference naming or governance are consistent with it.

**Acceptance Scenarios**:

1. **Given** the current constitution, **When** the amendment is applied, **Then** it includes a principle that code identifiers must describe behavior and requirement IDs must live in comments/JSDoc, with a short rationale.
2. **Given** the amendment, **When** the constitution version and dependent templates are checked, **Then** the version is incremented and no dependent template contradicts the new principle.

---

### User Story 3 - Maintainability code review (Priority: P3)

A reviewer performs a detailed, maintainability-focused code review over the cleanup (and immediately adjacent code) to confirm the renames are complete and correct, traceability is intact, behavior is unchanged, and no new readability/maintainability issues were introduced.

**Why this priority**: A final review raises confidence and may surface follow-ups, but it validates work the first two stories produce, so it is lowest priority. It is a quality gate, not new functionality.

**Independent Test**: A review is run over the branch; all High/Critical findings are resolved or explicitly triaged; the review confirms the success criteria (no ID-named identifiers remain, traceability preserved, tests green).

**Acceptance Scenarios**:

1. **Given** the completed cleanup + constitution change, **When** the review runs, **Then** it reports 0 unresolved High/Critical maintainability findings.
2. **Given** any review finding, **When** it is triaged, **Then** it is either fixed on the branch or recorded with a rationale for deferral.

---

### Edge Cases

- **Identifier maps to several requirement IDs** — the new name describes the shared behavior; the comment lists all the relevant IDs.
- **The name is part of an external or persisted contract** (e.g. a browser storage key, an environment variable, an API field, or an E2E `data-testid` consumed elsewhere) — renaming could break compatibility or stored data, so it is **kept** and annotated with a justifying comment rather than renamed.
- **Spec/plan/tasks documents, test descriptions, and task IDs (T-xxx)** legitimately reference requirement IDs for traceability — these are **out of scope** (they are documentation/traceability, not code identifiers).
- **Generated, vendored, or third-party code** — out of scope; only first-party source is cleaned.
- **A rename ripples across many importers** — all references (including dynamic imports, mocks, and test files) must be updated so nothing dangles.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The feature MUST identify every first-party source artifact — **files, modules, and exported identifiers** (functions, types, constants) — whose name is derived from a spec requirement/criterion/task ID (e.g. `FR-###`, `SC-###`, `T-###`, `US#`) rather than its behavior, across the frontend and backend codebases. Private/local identifiers that do not cross a module boundary are out of scope.
- **FR-002**: Each identified artifact MUST be renamed to a name that describes its behavior, and ALL references to it (imports, re-exports, mocks, test files, dynamic references) MUST be updated so the build and all tests resolve.
- **FR-003**: Each renamed artifact MUST retain its originating requirement/task ID in a comment or JSDoc so spec-to-code traceability is preserved. (This traceability/provenance comment is distinct from the prohibited "explains WHAT the code does" comment; the US2 constitution amendment codifies this carve-out.)
- **FR-004**: The renames MUST be behavior-preserving — no runtime/functional change. The existing unit, integration, and end-to-end test suites MUST pass unchanged — including the **containerized E2E run** (web + mobile) per SC-003 — with the only permitted test edits being updated import paths.
- **FR-005**: The feature MUST NOT rename identifiers that form an external or persisted contract (storage keys, environment-variable names, API field names, stable E2E selectors) where renaming would break compatibility or stored data; such cases MUST be left as-is and annotated with a justifying comment.
- **FR-006**: The project constitution MUST be amended to add a governing principle: code identifiers describe behavior; requirement IDs belong in comments/JSDoc for traceability. The amendment MUST follow the constitution's own change process (version bump; dependent templates kept consistent).
- **FR-007**: A maintainability-focused code review MUST be performed over the branch; all High/Critical findings MUST be resolved or explicitly triaged with a rationale.
- **FR-008**: Scope MUST be limited to first-party source code; `specs/` artifacts, test descriptions, task IDs, and generated/vendored code are explicitly excluded.

### Key Entities

Not applicable — this feature changes source-code identifiers and a governance document; it introduces no runtime data entities.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A repo-wide scan of first-party source finds **zero** files/modules/exported identifiers named after a spec ID, except cases explicitly excluded by FR-005 (each of which carries a justifying comment).
- **SC-002**: **100%** of renamed artifacts retain their requirement/task-ID traceability in a comment/JSDoc.
- **SC-003**: All pre-existing test suites pass with **zero new failures** after the cleanup (behavior unchanged), run as the **full final-validation gate**: mcm-app unit, BFF integration, mc-service unit + integration, **and the complete E2E suite against the dev BFF container** — web (`E2E_BFF_TARGET=dev-container`) **and** mobile (Maestro) — per the feature-007 procedure.
- **SC-004**: The constitution contains the new naming principle, its version is incremented, and **no** dependent template contradicts it.
- **SC-005**: The maintainability code review completes with **0** unresolved High/Critical findings.
- **SC-006**: For every renamed artifact, a reader can state its purpose from the name alone without consulting the spec (verified during the review for a sampled set).

## Assumptions

- The cleanup targets first-party **code identifiers** (file/module/symbol names), not spec/plan/tasks documents, test-case descriptions, or task IDs, which legitimately cite requirement IDs for traceability.
- All renames are behavior-preserving; this feature makes **no** logic, API, or schema changes.
- `git mv` (or equivalent) is used where practical so file history/blame is preserved across renames.
- The constitution amendment is applied through the existing constitution governance flow (e.g. `/speckit-constitution`), which handles the version bump and template synchronization.
- A concrete, already-identified instance is `frontend/mcm-app/src/utils/fr009.ts` → a behavior-descriptive name such as `default-collection-auto-nav.ts`; a repo scan during implementation determines the full set (which may be just this one, or a few more).
- The repo is at a known-green baseline (feature 007 merged to `main`; all suites green) so any post-cleanup test failure is attributable to the rename, not pre-existing drift.
