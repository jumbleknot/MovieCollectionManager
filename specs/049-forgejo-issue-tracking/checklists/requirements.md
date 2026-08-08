# Specification Quality Checklist: Forgejo issue tracking — an agent-driven backlog with no human transport layer

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-08
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`

### Validation record (2026-08-08)

All items pass on the first review pass. The source PRD is deliberately implementation-level, so the
following translations were applied while authoring, per the constitution's *Technology Agnosticism in
Specification* rule — the mechanics they replace belong in `plan.md`:

- Transport mechanics were restated as observable behaviour: the verb used to close an item, the query
  parameter that excludes change proposals, and the response header carrying the authoritative total
  became FR-008 and FR-010; tooling filenames and file paths were dropped entirely.
- Endpoint vocabulary was replaced with domain terms throughout: *backlog item*, *change proposal*,
  *label*, *milestone*, *blocking relationship*, *the forge*, *the tracker*.

Deliberate, reviewed exceptions:

- `MCM_FORGE_ISSUE_TOKEN` and `MCM_FORGE_TOKEN` are named once each, in **Key Entities** only. They are
  externally contracted environment-variable names (the same exemption the constitution grants for
  storage keys and env-var names), and every requirement that depends on them is stated behaviourally
  rather than by name. Naming them is what makes FR-005 and SC-005 verifiable.
- "Forgejo" appears in the feature title only, because the forge product *is* the subject of the
  feature. The body uses "the forge" throughout so no requirement is coupled to the product name.

### Clarification decisions taken as defaults (no [NEEDS CLARIFICATION] markers raised)

The source PRD left five questions open for planning. Four are implementation-level and belong in
`plan.md` (grant granularity, final label set, an optional operator CLI convenience, whether the tooling
gets a task-runner target). The fifth is scope-affecting and was resolved with a documented default
rather than a blocking question:

- **Merge-time automatic closure** (`closes #N` conventions auto-closing items on merge) is **not
  adopted**. It would couple item closure to the merge event and bypass the verify-then-close
  discipline that Story 3 exists to establish. Recorded in **Assumptions**; revisit via
  `/speckit-clarify` if the operator wants the coupling.
