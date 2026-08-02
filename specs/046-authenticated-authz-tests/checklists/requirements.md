# Specification Quality Checklist: Authenticated HTTP authorization tests for mc-service

**Purpose**: Validate specification completeness and quality before proceeding to planning

**Created**: 2026-08-02

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

Validation performed 2026-08-02. Three issues were found and fixed inline before marking complete:

1. **Implementation leakage (Content Quality).** The first draft named the grant type, the token
   endpoint, the specific client, `problem+json`, and the seeded usernames throughout. All were
   replaced with capability language ("obtain a real end-user credential", "the standard problem
   format"). The concrete mechanism is a planning concern and now lives only in `plan.md`.
2. **Unverifiable success criteria.** SC-001 originally read "the token helper works", which is a
   restatement of the implementation rather than an outcome. Rewritten as an observable property
   (own data readable, foreign data refused, verified every merge) with the baseline stated — zero
   authenticated requests verified today.
3. **Ambiguity in FR-004.** "Cross-tenant access is rejected" could be satisfied by either `403` or
   `404`. Made explicit that `403` must **fail**, since accepting it would silently permit the
   existence-leak regression this feature exists to prevent.

Two assumptions are marked **Verified** rather than asserted: a working credential was obtained and
its audience/role claims inspected, and the codebase was checked for elevated-role bypass of owner
scoping. Both were confirmed by direct measurement during design.

The deferred `403` is recorded under Out of Scope with its blocking prerequisite, not dropped.
