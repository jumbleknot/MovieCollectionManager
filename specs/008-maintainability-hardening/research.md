# Phase 0 Research: MCM Maintainability Hardening

## R1 — Rename inventory (the repo scan)

**Decision**: The cleanup surface is **one file with three importers**, and nothing else.

A scan of first-party source (`frontend/mcm-app/src`, `backend/mc-service/src`), excluding `tests/`-only descriptions and `specs/`, for artifacts named after spec IDs (`FR-###`, `SC-###`, `T-###`, `US#`):

| Find | Result |
|---|---|
| Files named after a spec ID | **1** — `frontend/mcm-app/src/utils/fr009.ts` |
| Exported identifiers (function/const/type/class) named after a spec ID | **0** — the functions (`isAutoNavDone`, `markAutoNavDone`, `clearAutoNav`) are already behavior-named |
| Backend (Rust) artifacts named after a spec ID | **0** — `mc-service` uses Clean-Architecture domain names |
| Importers of the ID-named module | **3** — `hooks/use-auth.tsx`, `screens/home/home-screen.tsx`, `screens/home/home-screen.test.tsx` |
| Other references | `app/(app)/home.tsx` contains a `FR-009` **comment** only (already the correct pattern — left as-is) |

**Rationale**: Confirms the clarified scope (files/modules + exported identifiers) does not expand the work — there are no symbol-level cases. The feature is genuinely small.

**Alternatives considered**: A broader scan including private/local identifiers and test-description IDs — rejected per the spec's scope decisions (private locals out of scope; test descriptions/task IDs legitimately cite IDs).

## R2 — New name for `fr009.ts`

**Decision**: Rename to **`frontend/mcm-app/src/utils/default-collection-auto-nav.ts`**.

**Rationale**: The module's behavior is "track whether the post-login auto-navigation to the user's **default collection** has already fired this session." `default-collection-auto-nav` states that from the name alone; it is kebab-case (constitution file-naming) and lives in the same `utils/` layer. The exported functions keep their existing names. The FR-009 reference moves into / stays in the module JSDoc for traceability.

**Alternatives considered**: `auto-nav.ts` (too generic — doesn't say *what* nav); `default-collection-redirect.ts` (accurate but "redirect" is the mechanism, "auto-nav" is the user-facing behavior); keeping `fr009.ts` (rejected — the whole point).

## R3 — Rename mechanics (behavior-preserving)

**Decision**: Use `git mv` for the file, then update the three importer paths (`@/utils/fr009` → `@/utils/default-collection-auto-nav`). No symbol renames, no logic edits.

**Rationale**: `git mv` preserves blame/history. The `@/*` → `src/*` path alias (tsconfig) and Jest/Metro module resolution are path-string based, so only the import specifier strings change — resolution is unaffected. The module's `AUTO_NAV_STORAGE_KEY = 'mcm_auto_nav_done'` is an **external/persisted contract** (a browser storage key) and is already behavior-named, so it is **not** touched (FR-005). This is a pure Refactor step under TDD — the existing suite is the regression guard.

**Alternatives considered**: Plain delete+create (loses history — rejected); a re-export shim at the old path (unnecessary indirection for 3 importers — rejected).

## R4 — Constitution amendment (US2)

**Decision**: Add a naming principle and bump the constitution **MINOR**: v1.4.0 → **v1.5.0**.

**Rationale**: Per the constitution's Governance section, a **MINOR** bump is for "guidance additions." The new rule — *code identifiers (files, modules, exported symbols) MUST describe behavior; requirement/spec IDs belong in comments/JSDoc for traceability* — is additive guidance that generalizes the existing "User-Centric Naming" (components) and "Documentation: self-documenting through clear naming" principles; it redefines nothing, so it is not MAJOR, and it is more than a typo/clarification, so it is not PATCH. It also explicitly reconciles the "no WHAT-comments" rule by carving out **traceability/provenance** comments (a spec-ID link is allowed). The amendment is applied via `/speckit-constitution` (which handles the version bump, history entry, and dependent-template sync).

**Placement**: under **AI Assistant Constraints** (alongside *Documentation*) so it governs all code, frontend and backend — not only the frontend UI section.

**Alternatives considered**: PATCH bump (rejected — it adds new guidance, not a clarification); placing it only in the Frontend section (rejected — the principle is language-agnostic and should bind the Rust backend too).

## R5 — Verification gate (SC-003, clarified)

**Decision**: The behavior-preserving gate is the **full** final-validation suite: mcm-app unit + BFF integration + mc-service unit + integration + the **containerized dev-container E2E** (web `E2E_BFF_TARGET=dev-container` 93/93 + mobile Maestro), per the feature-007 procedure, plus ESLint/Prettier and `cargo clippy`/`fmt`.

**Rationale**: The clarification (Session 2026-06-02, Q2 → B) chose maximum confidence. For a rename, unit + integration + type-check + lint deterministically catch any broken import; the containerized E2E confirms the running app is byte-for-behavior unchanged. Tasks must budget for standing up the dev container (and resetting to Metro afterward) per the 007 quickstart.

**Alternatives considered**: A lighter gate (unit + integration + one Metro web E2E) — was the recommendation but the user opted for the full gate; recorded and honored.

## R6 — Traceability comment vs. the "no WHAT-comments" rule

**Decision**: Retain the requirement-ID link as a JSDoc/comment annotation on the renamed module; it is compliant.

**Rationale**: The constitution prohibits comments that explain *what* code does (names do that) but permits comments for *non-obvious rationale / hidden constraints*. A `FR-009` reference is **provenance** — it links the implementation to the governing spec requirement for audit/traceability, which a reader cannot derive from the code. The US2 amendment states this exception so it is unambiguous going forward.
