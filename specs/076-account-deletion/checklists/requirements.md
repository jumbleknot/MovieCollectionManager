# Specification Quality Checklist: Self-service account deletion

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-24
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

**Technology-agnosticism, verified rather than asserted.** A word-boundary scan for `keycloak`,
`redis`, `mongo`, `oidc`, `pkce`, `oauth`, `http`, `cookie`, `jwt`, `bff`, `expo`, `react` and
`rust` returns exactly one hit: `Keycloak`, inside the verbatim backlog-item title quoted on the
**Input** line, which the spec template requires be recorded. It is a citation of the item being
specified, not a requirement, and no requirement, scenario or success criterion names a technology.
The vocabulary follows feature 073's spec — "identity provider", "standing permission",
"destination" — so the two specs read as one system.

**Ordering is a requirement, not a design detail.** FR-014, FR-015, FR-021 and FR-022 constrain the
*order* of destruction. That looks like implementation but is not: the order is the entire
difference between a deletion that closes backlog item #544 and one that widens it. The plan may
choose how each step is performed; it may not reorder them.

**Two decisions have no precedent in the system to inherit** and are recorded in Assumptions rather
than left to the plan: the 5-minute re-authentication freshness window, and the refusal to delete
the last remaining administrator. Both are defaults chosen for safety; either can be changed in
`/speckit-clarify` without disturbing the rest of the spec.

**Verification method is inherited from feature 073's SC-012 and is deliberately strict.** SC-001
requires proving the standing permission is dead by *attempting to use it* against the identity
provider. Observing a local record disappear is explicitly not evidence — that is the failure mode
backlog item #544 describes.

### Re-validated after the 2026-09-24 clarification session

All 16 items still pass; no item changed state. The spec grew from 27 to 37 functional requirements
and from 11 to 14 success criteria. Superseding the note above: the 5-minute window is no longer an
unexamined default — it was confirmed in clarification and now also governs the pending request's
expiry (FR-011), so one clock covers both. The last-administrator refusal (FR-013) was not
revisited and remains a chosen default.

One clarification answer was **retracted after verification rather than recorded**: an emailed
deletion confirmation was selected, then found unbuildable — the system has no general-purpose
outbound sender, and the message would have to be sent after the account no longer exists. The
spec now requires in-app notification only (FR-031) and backlog item #551 records the missing
channel. This is the second feature to narrow its scope around that absence.
