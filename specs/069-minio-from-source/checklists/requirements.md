# Specification Quality Checklist: MinIO built from source

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-11
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

### Validation iterations

**Iteration 1 — three failures, all fixed inline.**

1. *No implementation details* — FAILED. The first draft named the base image, the Go toolchain
   version, the exact build flags, file paths (`scripts/infra-image-scan.mjs`,
   `security/infra-images/allowlist.yaml`), and the workflow filename. Those are plan-level decisions,
   already settled in brainstorming and recorded there. Rewritten to state the *property* instead:
   FR-004 requires a hermetic toolchain without naming one; FR-010/FR-011 require scanner coverage
   without naming the scanner's source file; FR-012 requires suppressions be removed without naming
   the file.

2. *Technology-agnostic success criteria* — FAILED for the same reason. "A real sweep confirmed by job
   duration ~2m30s" became SC-004's "demonstrably a real sweep rather than a skipped one", which is
   the property; how it is demonstrated belongs to the plan.

3. *Written for non-technical stakeholders* — FAILED. The Why-now section opened with registry HTTP
   codes. Restructured to lead with consequence (production cannot pull) and keep the 404/200 control
   evidence as support.

**Deliberately retained, against a strict reading of "no implementation details":** the specific
upstream release identifiers (`RELEASE.2025-09-07T16-13-09Z`, `RELEASE.2025-10-15T17-29-55Z`) and the
dates. These are not implementation choices — they are the *facts of the incident* and the evidence
for the scope boundary in FR-006. Removing them would make the spec unfalsifiable.

### Requirements traceability

Every FR maps to at least one SC:

| FR | Covered by |
|---|---|
| FR-001, FR-002 | SC-001, SC-002 |
| FR-003 | SC-006 *(provenance verified by inspection)* |
| FR-004, FR-005 | SC-002, SC-008 |
| FR-006, FR-007 | SC-003 |
| FR-008 | SC-001, SC-002 |
| FR-009 | SC-008, SC-009 |
| FR-010, FR-011 | SC-004, SC-006 |
| FR-012 | SC-007 |
| FR-013 | SC-008 |
| FR-014 | SC-006 |
| FR-015 | *(no SC — an acceptance record, verified by the artifact existing, not by a measurement)* |

FR-015 is knowingly without a measurable outcome. It exists so the root-identity acceptance is written
down rather than discovered later; that is a documentation obligation, not a behaviour.

### Open risk carried into planning

The spec assumes the live data volume is owned by the replaced image's runtime identity, inferred from
the upstream image's published configuration rather than from the running host. The plan must verify
this against the actual volume before the production rollout, not after.
