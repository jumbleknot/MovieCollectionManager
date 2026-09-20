# Specification Quality Checklist: Per-user scheduled collection backups

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-19
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

Validation performed 2026-09-19. Three decisions that would otherwise have been
[NEEDS CLARIFICATION] markers were settled with the operator before drafting and are
recorded in Assumptions: the size-ceiling-vs-streaming trade, in-app-only failure
notification, and shipping both destination kinds together.

**Deliberate terminology call**: "S3-compatible" and "WebDAV" appear throughout. These are
storage protocols the user chooses between when describing where their data goes — they are
domain vocabulary for this feature, not a technology selection. Two product names (MinIO,
Nextcloud) appear once, inside a user-story narrative, as examples of storage the *user*
already owns — they describe the user's world, not this system's stack. No client library,
SDK, datastore, framework or language is named anywhere in the spec.

**Carried forward to `plan.md`**, not resolved here (all are HOW, not WHAT):

- Where the scheduler ticks, and the mechanism that makes "exactly once across instances" true.
- The specific mechanism for the standing permission and its revocation call.
- The concrete default value of the size ceiling and the unit it is expressed in.
- Artifact serialization format, compression, key layout, and integrity-check algorithm.
- Encryption-at-rest key custody for destination credentials — note the constitution requires
  keys managed separately from the data they protect; the plan must state how this follows
  the existing precedent for per-user third-party configuration, or where it improves on it.
